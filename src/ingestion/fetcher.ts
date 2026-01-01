/**
 * Data ingestion module
 * Fetches data from data sources and stores in SQLite
 */

import { getDataSourceManager, type MarketFilter, type MarketData, type PricePointData } from '../datasources/index.js';
import { 
  upsertMarket, 
  insertPriceHistory, 
  getMarket,
  getPriceHistory,
  getDbStats 
} from '../db/client.js';
import type { Market, PricePoint } from '../db/schema.js';

/**
 * Options for data ingestion
 */
export interface IngestionOptions {
  filter?: MarketFilter;
  skipExisting?: boolean;
  fetchPriceHistory?: boolean;
  progressCallback?: (progress: IngestionProgress) => void;
}

/**
 * Progress tracking for ingestion
 */
export interface IngestionProgress {
  phase: 'markets' | 'prices';
  current: number;
  total: number;
  currentMarketId?: string;
  source: string;
}

/**
 * Result of ingestion operation
 */
export interface IngestionResult {
  success: boolean;
  marketsIngested: number;
  pricePointsIngested: number;
  errors: string[];
  source: string;
  duration: number;
}

/**
 * Transform MarketData to database Market format
 */
function toDbMarket(data: MarketData): Omit<Market, 'fetched_at'> {
  return {
    id: data.id,
    question: data.question,
    category: data.category,
    resolution_date: data.resolutionDate,
    outcome: data.outcome,
    created_at: data.createdAt,
    is_binary: data.isBinary ? 1 : 0,
    volume_usd: data.volumeUsd,
    liquidity_usd: data.liquidityUsd,
  };
}

/**
 * Transform PricePointData to database PricePoint format
 */
function toDbPricePoint(data: PricePointData): Omit<PricePoint, 'id'> {
  return {
    market_id: data.marketId,
    timestamp: data.timestamp,
    yes_price: data.yesPrice,
    no_price: data.noPrice,
    volume: data.volume,
  };
}

/**
 * Ingest markets and price history from data source into SQLite
 */
export async function ingestData(options: IngestionOptions = {}): Promise<IngestionResult> {
  const startTime = Date.now();
  const manager = getDataSourceManager();
  const errors: string[] = [];
  let marketsIngested = 0;
  let pricePointsIngested = 0;
  let source = 'unknown';

  const {
    filter = { resolved: true, limit: 100 },
    skipExisting = false,
    fetchPriceHistory = true,
    progressCallback,
  } = options;

  // Fetch markets
  console.log(`Fetching markets with filter:`, filter);
  const marketsResult = await manager.fetchMarkets(filter);
  
  if (!marketsResult.success || !marketsResult.data) {
    return {
      success: false,
      marketsIngested: 0,
      pricePointsIngested: 0,
      errors: [marketsResult.error || 'Failed to fetch markets'],
      source: marketsResult.source,
      duration: Date.now() - startTime,
    };
  }

  source = marketsResult.source;
  const markets = marketsResult.data;
  console.log(`Fetched ${markets.length} markets from ${source}`);

  // Store markets
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    
    try {
      // Skip if exists and skipExisting is true
      if (skipExisting && getMarket(market.id)) {
        continue;
      }

      upsertMarket(toDbMarket(market));
      marketsIngested++;

      progressCallback?.({
        phase: 'markets',
        current: i + 1,
        total: markets.length,
        currentMarketId: market.id,
        source,
      });
    } catch (error) {
      errors.push(`Failed to store market ${market.id}: ${error}`);
    }
  }

  // Fetch and store price history
  if (fetchPriceHistory) {
    console.log(`Fetching price history for ${markets.length} markets...`);
    
    for (let i = 0; i < markets.length; i++) {
      const market = markets[i];
      
      try {
        // Skip if we already have price history
        if (skipExisting) {
          const existingHistory = getPriceHistory(market.id);
          if (existingHistory.length > 0) {
            continue;
          }
        }

        progressCallback?.({
          phase: 'prices',
          current: i + 1,
          total: markets.length,
          currentMarketId: market.id,
          source,
        });

        const priceResult = await manager.fetchPriceHistory(market.id);
        
        if (priceResult.success && priceResult.data && priceResult.data.length > 0) {
          const dbPoints = priceResult.data.map(toDbPricePoint);
          insertPriceHistory(dbPoints);
          pricePointsIngested += dbPoints.length;
        }
      } catch (error) {
        errors.push(`Failed to fetch/store price history for ${market.id}: ${error}`);
      }
    }
  }

  const duration = Date.now() - startTime;
  console.log(`Ingestion complete in ${duration}ms: ${marketsIngested} markets, ${pricePointsIngested} price points`);

  return {
    success: errors.length === 0,
    marketsIngested,
    pricePointsIngested,
    errors,
    source,
    duration,
  };
}

/**
 * Get ingestion statistics
 */
export function getIngestionStats(): {
  markets: number;
  pricePoints: number;
  backtestRuns: number;
  trades: number;
} {
  const stats = getDbStats();
  return {
    markets: stats.marketCount,
    pricePoints: stats.pricePointCount,
    backtestRuns: stats.backtestRunCount,
    trades: stats.tradeCount,
  };
}

/**
 * Check if a market has price history
 */
export function hasMarketPriceHistory(marketId: string): boolean {
  const history = getPriceHistory(marketId);
  return history.length > 0;
}

