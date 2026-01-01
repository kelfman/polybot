/**
 * Polymarket Gamma API data source adapter
 * Uses Gamma API for market discovery and CLOB API for price history
 */

import type { DataSource, MarketData, PricePointData, MarketFilter } from './types.js';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const CLOB_API_BASE = 'https://clob.polymarket.com';

/**
 * Rate limiting helper
 */
class RateLimiter {
  private lastRequest = 0;
  private minInterval: number;

  constructor(requestsPerSecond: number = 2) {
    this.minInterval = 1000 / requestsPerSecond;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
    }
    this.lastRequest = Date.now();
  }
}

/**
 * Gamma API response types
 */
interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  resolutionSource: string;
  endDate: string;
  liquidity: string;
  volume: string;
  outcomes: string;
  outcomePrices: string;
  active: boolean;
  closed: boolean;
  marketType: string;
  groupItemTitle?: string;
  groupItemThreshold?: string;
  category?: string;
  createdAt?: string;
  updatedAt?: string;
  clobTokenIds?: string; // JSON array of token IDs [YES, NO]
}

interface CLOBPriceHistory {
  t: number;    // timestamp (unix seconds)
  p: number;    // price (0-1)
}

/**
 * Gamma API data source implementation
 */
export class GammaDataSource implements DataSource {
  readonly name = 'gamma';
  private rateLimiter = new RateLimiter(2); // 2 requests per second
  
  // Cache of market ID -> { yesTokenId, noTokenId, createdAt, endDate }
  private marketTokenCache = new Map<string, {
    yesTokenId: string;
    noTokenId: string;
    createdAt: string | null;
    endDate: string | null;
  }>();

  /**
   * Test if Gamma API is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${GAMMA_API_BASE}/markets?limit=1`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch markets from Gamma API
   */
  async fetchMarkets(filter: MarketFilter): Promise<MarketData[]> {
    await this.rateLimiter.wait();

    const params = new URLSearchParams();
    
    // Gamma API params
    if (filter.resolved !== undefined) {
      params.set('closed', filter.resolved.toString());
    }
    if (filter.limit) {
      params.set('limit', filter.limit.toString());
    }
    
    // Order by closedTime descending to get most recent resolved markets
    if (filter.resolved) {
      params.set('order', 'closedTime');
      params.set('ascending', 'false');
    }
    
    // Note: Gamma API doesn't support direct category/date filtering
    // We'll filter client-side

    const url = `${GAMMA_API_BASE}/markets?${params.toString()}`;
    
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
      }

      const markets: GammaMarket[] = await response.json();
      
      // Transform and filter - accept binary markets with token IDs
      // Note: marketType is often 'normal' not 'binary', so check outcomes format
      let result = markets
        .filter(m => {
          // Must have CLOB token IDs for price history
          if (!m.clobTokenIds) return false;
          
          // Check if it's a Yes/No market by parsing outcomes
          try {
            const outcomes = JSON.parse(m.outcomes);
            if (Array.isArray(outcomes) && outcomes.length === 2) {
              const normalized = outcomes.map((o: string) => o.toLowerCase());
              return normalized.includes('yes') && normalized.includes('no');
            }
          } catch {
            // If we can't parse, check string directly
          }
          return m.marketType === 'binary';
        })
        .map(m => this.transformMarket(m));

      // Apply client-side filters
      if (filter.category) {
        result = result.filter(m => m.category?.toLowerCase() === filter.category?.toLowerCase());
      }
      if (filter.minResolutionDate) {
        result = result.filter(m => m.resolutionDate && m.resolutionDate >= filter.minResolutionDate!);
      }
      if (filter.maxResolutionDate) {
        result = result.filter(m => m.resolutionDate && m.resolutionDate <= filter.maxResolutionDate!);
      }

      return result;
    } catch (error) {
      console.error('Gamma API fetchMarkets error:', error);
      throw error;
    }
  }

  /**
   * Fetch price history for a market using CLOB API
   */
  async fetchPriceHistory(marketId: string): Promise<PricePointData[]> {
    await this.rateLimiter.wait();

    // Get cached token info
    const tokenInfo = this.marketTokenCache.get(marketId);
    if (!tokenInfo) {
      // Try to fetch the market first to get token IDs
      console.warn(`No cached token info for market ${marketId}, fetching market first...`);
      try {
        const marketResponse = await fetch(`${GAMMA_API_BASE}/markets/${marketId}`);
        if (marketResponse.ok) {
          const market: GammaMarket = await marketResponse.json();
          if (market.clobTokenIds) {
            const tokenIds = JSON.parse(market.clobTokenIds);
            if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
              this.marketTokenCache.set(marketId, {
                yesTokenId: tokenIds[0],
                noTokenId: tokenIds[1],
                createdAt: market.createdAt || null,
                endDate: market.endDate || null,
              });
            }
          }
        }
      } catch {
        // Ignore errors
      }
    }

    const cachedInfo = this.marketTokenCache.get(marketId);
    if (!cachedInfo) {
      console.warn(`No token IDs available for market ${marketId}`);
      return [];
    }

    // Calculate time range: from market creation to resolution (or now)
    const startTs = cachedInfo.createdAt 
      ? Math.floor(new Date(cachedInfo.createdAt).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60); // Default to 1 year ago
    
    const endTs = cachedInfo.endDate
      ? Math.floor(new Date(cachedInfo.endDate).getTime() / 1000) + (24 * 60 * 60) // Add 1 day buffer
      : Math.floor(Date.now() / 1000);

    // Use CLOB API for price history
    const url = `${CLOB_API_BASE}/prices-history?market=${cachedInfo.yesTokenId}&startTs=${startTs}&endTs=${endTs}`;
    
    try {
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 404) {
          console.warn(`No price history for market ${marketId}`);
          return [];
        }
        throw new Error(`CLOB API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // CLOB API returns { history: [...] }
      if (data.history && Array.isArray(data.history)) {
        return data.history.map((point: CLOBPriceHistory) => ({
          marketId,
          timestamp: new Date(point.t * 1000).toISOString(),
          yesPrice: point.p,
          noPrice: 1 - point.p,
          volume: null,
        }));
      }

      return [];
    } catch (error) {
      console.error(`CLOB API fetchPriceHistory error for ${marketId}:`, error);
      return []; // Return empty instead of throwing to allow continued processing
    }
  }

  /**
   * Batch fetch price history for multiple markets
   */
  async fetchPriceHistoryBatch(marketIds: string[]): Promise<Map<string, PricePointData[]>> {
    const result = new Map<string, PricePointData[]>();
    
    for (const marketId of marketIds) {
      try {
        const history = await this.fetchPriceHistory(marketId);
        result.set(marketId, history);
      } catch (error) {
        console.error(`Failed to fetch price history for ${marketId}:`, error);
        result.set(marketId, []);
      }
    }
    
    return result;
  }

  /**
   * Transform Gamma API market to our format
   */
  private transformMarket(market: GammaMarket): MarketData {
    // Parse outcome from outcomePrices if closed
    let outcome: 'YES' | 'NO' | null = null;
    if (market.closed) {
      try {
        const prices = JSON.parse(market.outcomePrices);
        if (Array.isArray(prices) && prices.length >= 2) {
          // If YES price is close to 1, outcome is YES
          const yesPrice = parseFloat(prices[0]);
          if (yesPrice > 0.99) outcome = 'YES';
          else if (yesPrice < 0.01) outcome = 'NO';
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Cache token IDs for price history fetching
    if (market.clobTokenIds) {
      try {
        const tokenIds = JSON.parse(market.clobTokenIds);
        if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
          this.marketTokenCache.set(market.id, {
            yesTokenId: tokenIds[0],
            noTokenId: tokenIds[1],
            createdAt: market.createdAt || null,
            endDate: market.endDate || null,
          });
        }
      } catch {
        // Ignore parse errors
      }
    }

    return {
      id: market.id,
      question: market.question,
      category: market.category || null,
      resolutionDate: market.endDate || null,
      outcome,
      createdAt: market.createdAt || null,
      isBinary: true,
      volumeUsd: market.volume ? parseFloat(market.volume) : null,
      liquidityUsd: market.liquidity ? parseFloat(market.liquidity) : null,
    };
  }
}

/**
 * Create a Gamma API data source instance
 */
export function createGammaDataSource(): DataSource {
  return new GammaDataSource();
}

