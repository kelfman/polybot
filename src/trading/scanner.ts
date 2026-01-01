/**
 * Market Scanner
 * Finds markets that qualify for the Late-Stage Convergence strategy
 * 
 * Qualification criteria (from config):
 * - Price between entryPriceMin and entryPriceMax (e.g., 0.70-0.90)
 * - Time to resolution between timeToResolutionDaysMin and timeToResolutionDaysMax (e.g., 1-5 days)
 * - Binary market (YES/NO)
 * - Low volatility (if filter enabled)
 * - Sufficient liquidity
 */

import { ClobClient, type OrderBookSummary } from '@polymarket/clob-client';
import { getConfig, type StrategyConfig } from '../config/index.js';
import { type StateManager } from './state.js';

// Market categories for diversification
export type MarketCategory = 
  | 'crypto'      // BTC, ETH, SOL price targets
  | 'stocks'      // AAPL, TSLA, META etc
  | 'sports'      // Football, basketball, etc
  | 'politics'    // Elections, policy
  | 'awards'      // Oscars, Critics Choice, Steam Awards
  | 'entertainment' // TV shows, movies, celebrities
  | 'other';

export interface QualifyingMarket {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  currentYesPrice: number;
  currentNoPrice: number;
  resolutionDate: string;
  daysToResolution: number;
  liquidity: number;        // Total liquidity in orderbook
  spread: number;           // Bid-ask spread
  category: MarketCategory; // For diversification
  isObjective: boolean;     // Objective vs subjective outcome
  qualificationScore: number; // Higher = better opportunity
  qualificationReasons: string[];
}

export interface ScanResult {
  timestamp: string;
  marketsScanned: number;
  qualifyingMarkets: QualifyingMarket[];
  scanDurationMs: number;
  errors: string[];
}

interface GammaMarket {
  conditionId: string;
  question: string;
  outcomes: string;           // JSON string: '["Yes", "No"]'
  outcomePrices: string;      // JSON string: '["0.85", "0.15"]'
  clobTokenIds: string;       // JSON string: '["token1", "token2"]'
  endDate: string;
  active: boolean;
  closed: boolean;
  volume: string;
  liquidity: string;
}

const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Category detection patterns
const CATEGORY_PATTERNS: Record<MarketCategory, RegExp[]> = {
  crypto: [
    /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|doge|crypto|token)\b/i,
    /\bprice of\b.*\b(above|below|between)\b/i,
  ],
  stocks: [
    /\b(aapl|tsla|msft|meta|googl|nvda|amzn|stock|nasdaq|s&p|dow)\b/i,
    /\bfinish week\b/i,
    /\bclose at\b/i,
  ],
  sports: [
    /\b(win on|fc |fc$| vs |match|game|nfl|nba|mlb|nhl|epl|premier league|champions league|super bowl|playoff|touchdown|goal|score)\b/i,
    /\b(raiders|patriots|cowboys|lakers|celtics|yankees|dodgers|manchester|liverpool|juventus|barcelona|real madrid)\b/i,
  ],
  politics: [
    /\b(election|vote|trump|biden|democrat|republican|senate|congress|governor|president|policy|legislation)\b/i,
  ],
  awards: [
    /\b(win best|oscar|emmy|grammy|golden globe|critics choice|steam awards|award|nomination)\b/i,
  ],
  entertainment: [
    /\b(movie|film|tv show|series|celebrity|album|song|release|premiere)\b/i,
  ],
  other: [],
};

// Objective outcome patterns (clear resolution criteria)
const OBJECTIVE_PATTERNS = [
  /\bprice\b.*\b(above|below|between)\b/i,  // Price targets
  /\bwin on\b/i,                             // Sports match outcomes
  /\bfinish week\b/i,                        // Stock prices
  /\bclose at\b/i,                           // Stock prices
  /\bby (january|february|march|april|may|june|july|august|september|october|november|december)/i,
  /\blaunch\b.*\bby\b/i,                     // Product launches with dates
];

/**
 * Detect market category from question
 */
function detectCategory(question: string): MarketCategory {
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (category === 'other') continue;
    for (const pattern of patterns) {
      if (pattern.test(question)) {
        return category as MarketCategory;
      }
    }
  }
  return 'other';
}

/**
 * Check if outcome is objective (clear resolution) vs subjective
 */
function isObjectiveOutcome(question: string): boolean {
  return OBJECTIVE_PATTERNS.some(pattern => pattern.test(question));
}

export class MarketScanner {
  private client: ClobClient;
  private config: StrategyConfig;
  private stateManager: StateManager | null;

  constructor(client: ClobClient, stateManager?: StateManager) {
    this.client = client;
    this.config = getConfig().strategy;
    this.stateManager = stateManager || null;
  }

  /**
   * Scan all active markets and find qualifying opportunities
   */
  async scan(): Promise<ScanResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const qualifyingMarkets: QualifyingMarket[] = [];
    
    // Track rejection reasons for summary
    const rejectionReasons: Record<string, number> = {
      'not_binary': 0,
      'price_too_low': 0,
      'price_too_high': 0,
      'too_far_from_resolution': 0,
      'too_close_to_resolution': 0,
      'closed_or_inactive': 0,
      'already_have_position': 0,
      'other': 0,
    };
    
    // Get existing positions to filter out
    let existingPositionMarkets: Set<string> = new Set();
    if (this.stateManager) {
      const state = await this.stateManager.getState();
      existingPositionMarkets = new Set(state.positions.map(p => p.marketId));
    }
    
    let nearMisses: Array<{ question: string; reason: string; price?: number; days?: number }> = [];

    console.log('\n[Scanner] ═══════════════════════════════════════════════════════');
    console.log('[Scanner] Starting market scan...');
    console.log(`[Scanner] Criteria: Price ${this.config.entryPriceMin}-${this.config.entryPriceMax}, ≤${this.config.timeToResolutionDaysMax} days`);

    try {
      // Fetch active markets from Gamma API
      const markets = await this.fetchActiveMarkets();
      console.log(`[Scanner] Fetched ${markets.length} active markets from Gamma API`);

      // Check each market for qualification
      for (const market of markets) {
        try {
          // Skip markets where we already have a position
          if (existingPositionMarkets.has(market.conditionId)) {
            rejectionReasons['already_have_position']++;
            continue;
          }
          
          const qualification = this.checkQualification(market);
          
          if (qualification.qualifies) {
            // Parse token IDs and prices
            let tokenIds: string[] = [];
            let outcomes: string[] = [];
            let prices: number[] = [];
            try {
              tokenIds = JSON.parse(market.clobTokenIds || '[]');
              outcomes = JSON.parse(market.outcomes || '[]');
              prices = JSON.parse(market.outcomePrices || '[]').map((p: string) => parseFloat(p));
            } catch {
              continue;
            }
            
            const yesIndex = outcomes.findIndex(o => o.toLowerCase() === 'yes');
            const noIndex = outcomes.findIndex(o => o.toLowerCase() === 'no');
            
            if (yesIndex !== -1 && tokenIds[yesIndex]) {
              const yesTokenId = tokenIds[yesIndex];
              const noTokenId = noIndex !== -1 ? tokenIds[noIndex] : '';
              const yesPrice = prices[yesIndex] || 0;
              
              const orderbook = await this.fetchOrderbook(yesTokenId);
              const liquidity = this.calculateLiquidity(orderbook);
              const spread = this.calculateSpread(orderbook);
              const category = detectCategory(market.question);
              const objective = isObjectiveOutcome(market.question);
              
              // Adjust score based on liquidity and spread
              let adjustedScore = qualification.score;
              
              // Liquidity bonus (up to 15 points)
              if (liquidity > 5000) adjustedScore += 15;
              else if (liquidity > 1000) adjustedScore += 10;
              else if (liquidity > 500) adjustedScore += 5;
              
              // Spread penalty (tight spread = good)
              if (spread < 0.02) adjustedScore += 10;  // <2% spread
              else if (spread < 0.05) adjustedScore += 5;
              else if (spread > 0.10) adjustedScore -= 10; // >10% spread penalty
              
              // Objective outcome bonus
              if (objective) adjustedScore += 5;
              
              qualifyingMarkets.push({
                conditionId: market.conditionId,
                question: market.question,
                yesTokenId,
                noTokenId,
                currentYesPrice: yesPrice,
                currentNoPrice: 1 - yesPrice,
                resolutionDate: market.endDate,
                daysToResolution: qualification.daysToResolution,
                liquidity,
                spread,
                category,
                isObjective: objective,
                qualificationScore: adjustedScore,
                qualificationReasons: qualification.reasons,
              });
            }
          } else {
            // Track rejection reason
            const reason = qualification.reasons[0] || 'other';
            if (reason.includes('closed') || reason.includes('inactive')) {
              rejectionReasons['closed_or_inactive']++;
            } else if (reason.includes('below min')) {
              rejectionReasons['price_too_low']++;
            } else if (reason.includes('above max')) {
              rejectionReasons['price_too_high']++;
            } else if (reason.includes('> max')) {
              rejectionReasons['too_far_from_resolution']++;
            } else if (reason.includes('< min')) {
              rejectionReasons['too_close_to_resolution']++;
            } else if (reason.includes('Not a binary')) {
              rejectionReasons['not_binary']++;
            } else {
              rejectionReasons['other']++;
            }
            
            // Track near misses (close to qualifying)
            try {
              const outcomes = JSON.parse(market.outcomes || '[]');
              const prices = JSON.parse(market.outcomePrices || '[]').map((p: string) => parseFloat(p));
              const yesIdx = outcomes.findIndex((o: string) => o.toLowerCase() === 'yes');
              const price = yesIdx !== -1 ? prices[yesIdx] : 0;
              
              if (price >= 0.65 && price <= 0.95 && qualification.daysToResolution <= 7 && qualification.daysToResolution > 0) {
                nearMisses.push({
                  question: market.question?.slice(0, 50) + '...',
                  reason: reason.slice(0, 40),
                  price,
                  days: qualification.daysToResolution,
                });
              }
            } catch {}
          }
        } catch (error) {
          errors.push(`Error checking market ${market.conditionId}: ${error}`);
        }
      }

      // Sort by qualification score (highest first)
      qualifyingMarkets.sort((a, b) => b.qualificationScore - a.qualificationScore);
      nearMisses = nearMisses.slice(0, 5); // Keep top 5 near misses

    } catch (error) {
      errors.push(`Scan failed: ${error}`);
    }

    const scanDurationMs = Date.now() - startTime;
    
    // Apply diversification filter - max 2 per category for recommendations
    const diversifiedMarkets = this.applyDiversification(qualifyingMarkets, 2);
    
    // Count by category
    const categoryCounts: Record<string, number> = {};
    for (const m of qualifyingMarkets) {
      categoryCounts[m.category] = (categoryCounts[m.category] || 0) + 1;
    }
    
    // Print summary
    console.log('[Scanner] ───────────────────────────────────────────────────────');
    console.log('[Scanner] SCAN SUMMARY:');
    const totalScanned = rejectionReasons['closed_or_inactive'] + rejectionReasons['not_binary'] + rejectionReasons['price_too_low'] + rejectionReasons['price_too_high'] + rejectionReasons['too_far_from_resolution'] + rejectionReasons['too_close_to_resolution'] + rejectionReasons['already_have_position'] + rejectionReasons['other'] + qualifyingMarkets.length;
    console.log(`[Scanner]   Markets scanned: ${totalScanned}`);
    console.log(`[Scanner]   ✅ Qualifying: ${qualifyingMarkets.length}`);
    console.log(`[Scanner]   ❌ Rejected:`);
    console.log(`[Scanner]      - Price too low (<${this.config.entryPriceMin}): ${rejectionReasons['price_too_low']}`);
    console.log(`[Scanner]      - Price too high (>${this.config.entryPriceMax}): ${rejectionReasons['price_too_high']}`);
    console.log(`[Scanner]      - Too far from resolution: ${rejectionReasons['too_far_from_resolution']}`);
    console.log(`[Scanner]      - Too close to resolution: ${rejectionReasons['too_close_to_resolution']}`);
    console.log(`[Scanner]      - Not binary: ${rejectionReasons['not_binary']}`);
    if (rejectionReasons['already_have_position'] > 0) {
      console.log(`[Scanner]      - Already have position: ${rejectionReasons['already_have_position']}`);
    }
    
    // Category breakdown
    console.log('[Scanner] ───────────────────────────────────────────────────────');
    console.log('[Scanner] CATEGORY BREAKDOWN:');
    const categoryEmojis: Record<MarketCategory, string> = {
      crypto: '🪙', stocks: '📊', sports: '⚽', politics: '🏛️',
      awards: '🏆', entertainment: '🎬', other: '❓'
    };
    for (const [cat, count] of Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])) {
      const emoji = categoryEmojis[cat as MarketCategory] || '❓';
      console.log(`[Scanner]   ${emoji} ${cat}: ${count}`);
    }
    
    if (diversifiedMarkets.length > 0) {
      console.log('[Scanner] ───────────────────────────────────────────────────────');
      console.log('[Scanner] TOP DIVERSIFIED PICKS (max 2 per category):');
      for (const market of diversifiedMarkets.slice(0, 10)) {
        const emoji = categoryEmojis[market.category] || '❓';
        const objTag = market.isObjective ? '📐' : '🎲';
        const liqTag = market.liquidity > 1000 ? '💧' : market.liquidity > 100 ? '💦' : '🏜️';
        console.log(`[Scanner]   ${emoji} ${market.question.slice(0, 45)}...`);
        console.log(`[Scanner]      ${(market.currentYesPrice * 100).toFixed(0)}¢ | ${market.daysToResolution.toFixed(1)}d | Score: ${market.qualificationScore} | ${objTag}${liqTag}`);
      }
      console.log('[Scanner]   ───────────────────────────────────────────────────');
      console.log('[Scanner]   Legend: 📐=Objective 🎲=Subjective | 💧=High liq 💦=Med 🏜️=Low');
    } else if (nearMisses.length > 0) {
      console.log('[Scanner] ───────────────────────────────────────────────────────');
      console.log('[Scanner] NEAR MISSES (close to qualifying):');
      for (const nm of nearMisses) {
        console.log(`[Scanner]   ⚠️  ${nm.question}`);
        console.log(`[Scanner]      Price: ${(nm.price! * 100).toFixed(1)}¢ | Days: ${nm.days?.toFixed(1)} | Why not: ${nm.reason}`);
      }
    }
    
    console.log('[Scanner] ───────────────────────────────────────────────────────');
    console.log(`[Scanner] Scan completed in ${scanDurationMs}ms`);
    console.log('[Scanner] ═══════════════════════════════════════════════════════\n');

    return {
      timestamp: new Date().toISOString(),
      marketsScanned: Object.values(rejectionReasons).reduce((a, b) => a + b, 0) + qualifyingMarkets.length,
      qualifyingMarkets,
      scanDurationMs,
      errors,
    };
  }

  /**
   * Check if a specific market qualifies
   */
  checkQualification(market: GammaMarket): {
    qualifies: boolean;
    daysToResolution: number;
    score: number;
    reasons: string[];
  } {
    const reasons: string[] = [];
    let score = 0;

    // Skip closed/inactive markets
    if (market.closed || !market.active) {
      return { qualifies: false, daysToResolution: 0, score: 0, reasons: ['Market closed or inactive'] };
    }

    // Parse outcomes and prices from JSON strings
    let outcomes: string[];
    let prices: number[];
    try {
      outcomes = JSON.parse(market.outcomes || '[]');
      prices = JSON.parse(market.outcomePrices || '[]').map((p: string) => parseFloat(p));
    } catch {
      return { qualifies: false, daysToResolution: 0, score: 0, reasons: ['Failed to parse market data'] };
    }

    // Check if binary market
    if (outcomes.length !== 2) {
      return { qualifies: false, daysToResolution: 0, score: 0, reasons: ['Not a binary market'] };
    }

    // Get YES price (first outcome is typically Yes)
    const yesIndex = outcomes.findIndex(o => o.toLowerCase() === 'yes');
    if (yesIndex === -1) {
      return { qualifies: false, daysToResolution: 0, score: 0, reasons: ['No YES outcome found'] };
    }
    
    const yesPrice = prices[yesIndex];

    // Check price range
    if (yesPrice < this.config.entryPriceMin) {
      return { qualifies: false, daysToResolution: 0, score: 0, reasons: [`Price ${yesPrice.toFixed(3)} below min ${this.config.entryPriceMin}`] };
    }
    if (yesPrice > this.config.entryPriceMax) {
      return { qualifies: false, daysToResolution: 0, score: 0, reasons: [`Price ${yesPrice.toFixed(3)} above max ${this.config.entryPriceMax}`] };
    }

    reasons.push(`Price ${yesPrice.toFixed(3)} in range [${this.config.entryPriceMin}, ${this.config.entryPriceMax}]`);
    score += 20;

    // Check time to resolution
    const resolutionDate = new Date(market.endDate);
    const now = new Date();
    const daysToResolution = (resolutionDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

    if (daysToResolution < this.config.timeToResolutionDaysMin) {
      return { qualifies: false, daysToResolution, score: 0, reasons: [`${daysToResolution.toFixed(1)} days < min ${this.config.timeToResolutionDaysMin}`] };
    }
    if (daysToResolution > this.config.timeToResolutionDaysMax) {
      return { qualifies: false, daysToResolution, score: 0, reasons: [`${daysToResolution.toFixed(1)} days > max ${this.config.timeToResolutionDaysMax}`] };
    }

    reasons.push(`${daysToResolution.toFixed(1)} days to resolution`);
    score += 20;

    // Bonus points for better price (closer to min = more upside)
    const priceRange = this.config.entryPriceMax - this.config.entryPriceMin;
    const pricePosition = (yesPrice - this.config.entryPriceMin) / priceRange;
    score += Math.round((1 - pricePosition) * 30); // Up to 30 points for price

    // Bonus points for closer to resolution (less time = less risk of flip)
    const timeRange = this.config.timeToResolutionDaysMax - this.config.timeToResolutionDaysMin;
    const timePosition = (daysToResolution - this.config.timeToResolutionDaysMin) / timeRange;
    score += Math.round((1 - timePosition) * 20); // Up to 20 points for time

    // Bonus for liquidity
    const liquidityNum = parseFloat(market.liquidity) || 0;
    if (liquidityNum > 10000) {
      score += 10;
      reasons.push('Good liquidity');
    }

    return {
      qualifies: true,
      daysToResolution,
      score,
      reasons,
    };
  }

  /**
   * Fetch active markets from Gamma API with pagination
   * Uses end_date_max filter to focus on near-term markets (much faster)
   */
  private async fetchActiveMarkets(): Promise<GammaMarket[]> {
    const allMarkets: GammaMarket[] = [];
    const pageSize = 500;
    let offset = 0;
    let hasMore = true;
    
    // Add buffer of 1 day beyond max to account for timezone differences
    const maxDays = this.config.timeToResolutionDaysMax + 1;
    const maxDate = new Date(Date.now() + maxDays * 24 * 60 * 60 * 1000);
    const maxDateStr = encodeURIComponent(maxDate.toISOString());
    
    console.log(`[Scanner] Filtering for markets resolving within ${maxDays} days`);
    
    while (hasMore) {
      const url = `${GAMMA_API_URL}/markets?closed=false&limit=${pageSize}&offset=${offset}&end_date_max=${maxDateStr}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as GammaMarket[];
      allMarkets.push(...data);
      
      // If we got fewer than pageSize, we've reached the end
      if (data.length < pageSize) {
        hasMore = false;
      } else {
        offset += pageSize;
      }
      
      // Limit to 3000 markets for faster scans
      if (allMarkets.length >= 3000) {
        break;
      }
    }
    
    return allMarkets;
  }

  /**
   * Fetch orderbook for a token
   */
  private async fetchOrderbook(tokenId: string): Promise<OrderBookSummary | null> {
    try {
      return await this.client.getOrderBook(tokenId);
    } catch {
      return null;
    }
  }

  /**
   * Calculate total liquidity from orderbook
   */
  private calculateLiquidity(orderbook: OrderBookSummary | null): number {
    if (!orderbook) return 0;

    let total = 0;
    for (const bid of orderbook.bids) {
      total += parseFloat(bid.price) * parseFloat(bid.size);
    }
    for (const ask of orderbook.asks) {
      total += parseFloat(ask.price) * parseFloat(ask.size);
    }
    return total;
  }

  /**
   * Calculate bid-ask spread
   */
  private calculateSpread(orderbook: OrderBookSummary | null): number {
    if (!orderbook || orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return 1; // Max spread if no orderbook
    }

    const bestBid = Math.max(...orderbook.bids.map(b => parseFloat(b.price)));
    const bestAsk = Math.min(...orderbook.asks.map(a => parseFloat(a.price)));

    return Math.max(0, bestAsk - bestBid);
  }

  /**
   * Apply diversification filter - limit markets per category
   * Returns top N from each category, preserving score order
   */
  private applyDiversification(
    markets: QualifyingMarket[],
    maxPerCategory: number
  ): QualifyingMarket[] {
    const result: QualifyingMarket[] = [];
    const categoryCount: Record<string, number> = {};

    // Markets are already sorted by score
    for (const market of markets) {
      const count = categoryCount[market.category] || 0;
      if (count < maxPerCategory) {
        result.push(market);
        categoryCount[market.category] = count + 1;
      }
    }

    return result;
  }

  /**
   * Get diversified recommendations for trading
   * Filters for best opportunities across categories
   */
  getDiversifiedRecommendations(
    markets: QualifyingMarket[],
    maxTotal: number,
    maxPerCategory: number = 2
  ): QualifyingMarket[] {
    // First apply diversification
    const diversified = this.applyDiversification(markets, maxPerCategory);
    
    // Then take top N overall
    return diversified.slice(0, maxTotal);
  }
}

/**
 * Create scanner from CLOB client
 */
export function createScanner(client: ClobClient, stateManager?: StateManager): MarketScanner {
  return new MarketScanner(client, stateManager);
}

