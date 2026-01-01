/**
 * Backtest Engine
 * Replays historical price data and simulates trades
 * Classifies markets for performance analysis (no filtering)
 */

import { randomBytes } from 'crypto';
import { getConfig } from '../config/index.js';
import { 
  getResolvedMarkets, 
  getPriceHistory,
  getMarket,
  createBacktestRun,
  insertBacktestTrade,
  updateBacktestTrade,
  completeBacktestRun,
} from '../db/client.js';
import { createStrategy } from '../strategy/convergence.js';
import { 
  classifyMarket, 
  calculateClassificationBreakdown,
  type MarketClassification,
  type ClassificationBreakdown,
} from '../classification/index.js';
import { calculateMetrics, type BacktestMetrics } from './metrics.js';
import type { Market, PricePoint, BacktestTrade } from '../db/schema.js';

/**
 * Generate a unique ID
 */
function generateId(): string {
  const randomPart = randomBytes(4).toString('hex');
  return `bt_${Date.now()}_${randomPart}`;
}

/**
 * Options for running a backtest
 */
export interface BacktestOptions {
  startDate?: string;
  endDate?: string;
  marketIds?: string[]; // Specific markets to test, or all if not specified
  dryRun?: boolean; // If true, don't persist results
  progressCallback?: (progress: BacktestProgress) => void;
}

/**
 * Progress tracking for backtest
 */
export interface BacktestProgress {
  phase: 'classifying' | 'simulating' | 'calculating';
  currentMarket: number;
  totalMarkets: number;
  marketId?: string;
  tradesFound: number;
}

/**
 * Result of a backtest run
 */
export interface BacktestResult {
  runId: string;
  success: boolean;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  marketsAnalyzed: number;
  classifications: Map<string, MarketClassification>;
  classificationBreakdown: ClassificationBreakdown;
  duration: number;
  errors: string[];
}

/**
 * Open position tracking during simulation
 */
interface OpenPosition {
  tradeId: number;
  marketId: string;
  side: 'YES' | 'NO';
  entryPrice: number;
  entryTime: string;
  sizeUsd: number;
}

/**
 * The Backtest Engine
 */
export class BacktestEngine {
  private strategy = createStrategy();
  private config = getConfig();

  /**
   * Run a backtest
   */
  async run(options: BacktestOptions = {}): Promise<BacktestResult> {
    const startTime = Date.now();
    const runId = generateId();
    const errors: string[] = [];
    const classifications = new Map<string, MarketClassification>();
    
    const {
      startDate = this.config.backtest.startDate,
      endDate = this.config.backtest.endDate || new Date().toISOString().split('T')[0],
      marketIds,
      dryRun = false,
      progressCallback,
    } = options;

    console.log(`Starting backtest ${runId}`);
    console.log(`Date range: ${startDate} to ${endDate}`);
    console.log(`Strategy: ${this.config.strategy.name}`);
    
    // Show classification settings
    const volEnabled = this.config.classification.volatility.enabled;
    const llmEnabled = this.config.classification.llmConvergence.enabled;
    console.log(`Classifications: volatility=${volEnabled ? 'ON' : 'OFF'}, convergence=${llmEnabled ? 'ON' : 'OFF'}`);

    // Create backtest run record
    if (!dryRun) {
      createBacktestRun(runId, {
        strategy: this.config.strategy,
        classification: this.config.classification,
        risk: this.config.risk,
        startDate,
        endDate,
      });
    }

    // Get markets to analyze
    let markets = getResolvedMarkets();
    
    // Filter by specific market IDs if provided
    if (marketIds && marketIds.length > 0) {
      markets = markets.filter(m => marketIds.includes(m.id));
    }
    
    // Filter by date range
    markets = markets.filter(m => {
      if (!m.resolution_date) return false;
      return m.resolution_date >= startDate && m.resolution_date <= endDate;
    });

    console.log(`Found ${markets.length} markets in date range`);

    // Phase 1: Classify all markets
    if (volEnabled || llmEnabled) {
      console.log('Classifying markets...');
      
      for (let i = 0; i < markets.length; i++) {
        const market = markets[i];
        
        progressCallback?.({
          phase: 'classifying',
          currentMarket: i + 1,
          totalMarkets: markets.length,
          marketId: market.id,
          tradesFound: 0,
        });

        try {
          const priceHistory = getPriceHistory(market.id);
          const classification = await classifyMarket(market, priceHistory);
          classifications.set(market.id, classification);
        } catch (error) {
          errors.push(`Classification error for ${market.id}: ${error}`);
        }
      }

      // Log classification summary
      const volCounts = { low: 0, medium: 0, high: 0 };
      const convCounts = { natural: 0, uncertain: 0, unknown: 0 };
      
      for (const cls of classifications.values()) {
        volCounts[cls.volatility.level]++;
        convCounts[cls.convergence.type]++;
      }
      
      console.log(`Volatility: low=${volCounts.low}, medium=${volCounts.medium}, high=${volCounts.high}`);
      if (llmEnabled) {
        console.log(`Convergence: natural=${convCounts.natural}, uncertain=${convCounts.uncertain}, unknown=${convCounts.unknown}`);
      }
    }

    // Phase 2: Simulate trades on ALL markets (no filtering)
    const openPositions: Map<string, OpenPosition> = new Map();
    const completedTrades: BacktestTrade[] = [];
    const tradedMarkets: Set<string> = new Set(); // Prevent re-entry after closing
    let currentExposure = 0;

    for (let i = 0; i < markets.length; i++) {
      const market = markets[i];
      
      progressCallback?.({
        phase: 'simulating',
        currentMarket: i + 1,
        totalMarkets: markets.length,
        marketId: market.id,
        tradesFound: completedTrades.length,
      });

      try {
        // Get price history
        const priceHistory = getPriceHistory(market.id);
        if (priceHistory.length === 0) {
          continue;
        }

        // Filter price history to date range
        const relevantHistory = priceHistory.filter(p => {
          const date = p.timestamp.split('T')[0];
          return date >= startDate && date <= endDate;
        });

        // Simulate through price history
        for (const pricePoint of relevantHistory) {
          // Check for exits on open positions
          const position = openPositions.get(market.id);
          if (position) {
            const exitSignal = this.strategy.checkExitConditions(
              position.side,
              position.entryPrice,
              pricePoint,
              market
            );

            if (exitSignal) {
              // Close position
              const pnl = this.strategy.calculatePnL(
                position.side,
                position.entryPrice,
                exitSignal.exitPrice,
                position.sizeUsd
              );

              const trade: BacktestTrade = {
                id: position.tradeId,
                run_id: runId,
                market_id: market.id,
                side: position.side,
                entry_time: position.entryTime,
                entry_price: position.entryPrice,
                exit_time: exitSignal.timestamp,
                exit_price: exitSignal.exitPrice,
                size_usd: position.sizeUsd,
                pnl,
                exit_reason: exitSignal.reason,
              };

              if (!dryRun) {
                updateBacktestTrade(position.tradeId, {
                  exit_time: exitSignal.timestamp,
                  exit_price: exitSignal.exitPrice,
                  pnl,
                  exit_reason: exitSignal.reason,
                });
              }

              completedTrades.push(trade);
              currentExposure -= position.sizeUsd;
              openPositions.delete(market.id);
              tradedMarkets.add(market.id); // Mark as traded to prevent re-entry
            }
          }

          // Check for entry signals (only if no position and never traded this market)
          if (!openPositions.has(market.id) && !tradedMarkets.has(market.id)) {
            // Check volatility filter
            const marketClassification = classifications.get(market.id);
            const maxVol = this.config.strategy.maxVolatility || 'high';
            const volLevel = marketClassification?.volatility.level || 'low';
            
            // Skip if volatility is too high
            const volRank = { low: 1, medium: 2, high: 3 };
            if (volRank[volLevel] > volRank[maxVol]) {
              continue; // Skip this price point - market is too volatile
            }
            
            const entrySignal = this.strategy.checkEntryConditions(market, pricePoint);
            
            if (entrySignal) {
              // Calculate position size
              const sizeUsd = this.strategy.calculatePositionSize(
                currentExposure,
                openPositions.size
              );

              if (sizeUsd > 0) {
                // Open position
                const trade: Omit<BacktestTrade, 'id'> = {
                  run_id: runId,
                  market_id: market.id,
                  side: entrySignal.side,
                  entry_time: entrySignal.timestamp,
                  entry_price: entrySignal.entryPrice,
                  exit_time: null,
                  exit_price: null,
                  size_usd: sizeUsd,
                  pnl: null,
                  exit_reason: null,
                };

                let tradeId: number;
                if (!dryRun) {
                  tradeId = insertBacktestTrade(trade);
                } else {
                  tradeId = completedTrades.length + openPositions.size + 1;
                }

                openPositions.set(market.id, {
                  tradeId,
                  marketId: market.id,
                  side: entrySignal.side,
                  entryPrice: entrySignal.entryPrice,
                  entryTime: entrySignal.timestamp,
                  sizeUsd,
                });

                currentExposure += sizeUsd;
              }
            }
          }
        }

        // Force close any remaining positions at resolution
        if (openPositions.has(market.id) && market.outcome) {
          const position = openPositions.get(market.id)!;
          const finalPrice = market.outcome === position.side ? 1.0 : 0.0;
          const lastPrice = priceHistory[priceHistory.length - 1];
          
          const pnl = this.strategy.calculatePnL(
            position.side,
            position.entryPrice,
            finalPrice,
            position.sizeUsd
          );

          const trade: BacktestTrade = {
            id: position.tradeId,
            run_id: runId,
            market_id: market.id,
            side: position.side,
            entry_time: position.entryTime,
            entry_price: position.entryPrice,
            exit_time: lastPrice.timestamp,
            exit_price: finalPrice,
            size_usd: position.sizeUsd,
            pnl,
            exit_reason: 'resolution',
          };

          if (!dryRun) {
            updateBacktestTrade(position.tradeId, {
              exit_time: lastPrice.timestamp,
              exit_price: finalPrice,
              pnl,
              exit_reason: 'resolution',
            });
          }

          completedTrades.push(trade);
          currentExposure -= position.sizeUsd;
          openPositions.delete(market.id);
          tradedMarkets.add(market.id); // Mark as traded
        }

      } catch (error) {
        errors.push(`Error processing market ${market.id}: ${error}`);
      }
    }

    // Phase 3: Calculate metrics with classification breakdown
    progressCallback?.({
      phase: 'calculating',
      currentMarket: markets.length,
      totalMarkets: markets.length,
      tradesFound: completedTrades.length,
    });

    // Provide market lookup for category tracking
    const marketLookup = (marketId: string) => getMarket(marketId);
    const metrics = calculateMetrics(completedTrades, 1000, marketLookup);

    // Calculate classification breakdown
    const classificationBreakdown = calculateClassificationBreakdown(
      completedTrades,
      classifications,
      marketLookup
    );

    // Complete backtest run
    if (!dryRun) {
      completeBacktestRun(runId, {
        total_trades: metrics.totalTrades,
        winning_trades: metrics.winningTrades,
        total_pnl: metrics.totalPnL,
        max_drawdown: metrics.maxDrawdown,
        sharpe_ratio: metrics.sharpeRatio,
      });
    }

    const duration = Date.now() - startTime;

    return {
      runId,
      success: errors.length === 0,
      metrics,
      trades: completedTrades,
      marketsAnalyzed: markets.length,
      classifications,
      classificationBreakdown,
      duration,
      errors,
    };
  }

  /**
   * Get strategy parameters
   */
  getParameters() {
    return this.strategy.getParameters();
  }
}

/**
 * Create a backtest engine instance
 */
export function createBacktestEngine(): BacktestEngine {
  return new BacktestEngine();
}
