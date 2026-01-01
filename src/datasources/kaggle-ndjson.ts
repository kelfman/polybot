/**
 * Kaggle NDJSON data source adapter
 * Handles the richer Polymarket_dataset format with NDJSON files:
 * - market=0x.../
 *   - price/token=xxx.ndjson
 *   - trade/market=xxx.ndjson
 *   - holder/market=xxx.ndjson
 *   - book/token=xxx.ndjson
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, join } from 'path';
import type { DataSource, MarketData, PricePointData, MarketFilter } from './types.js';

/**
 * Price point from NDJSON file
 */
interface NDJSONPricePoint {
  token_id: string;
  conditionId: string;
  market_id: string;
  outcome_index: number;
  t: number; // Unix timestamp
  p: number; // Price
}

/**
 * Kaggle NDJSON data source implementation
 */
export class KaggleNDJSONDataSource implements DataSource {
  readonly name = 'kaggle-ndjson';
  private basePath: string;
  private marketsCache: Map<string, MarketData> | null = null;
  private priceHistoryCache: Map<string, PricePointData[]> = new Map();
  private loaded = false;

  constructor(basePath: string) {
    this.basePath = resolve(basePath);
  }

  /**
   * Test if data is available
   */
  async isAvailable(): Promise<boolean> {
    if (!existsSync(this.basePath)) {
      return false;
    }
    
    try {
      const entries = readdirSync(this.basePath);
      return entries.some(e => e.startsWith('market='));
    } catch {
      return false;
    }
  }

  /**
   * Parse NDJSON file (space or newline separated JSON objects)
   */
  private parseNDJSON<T>(content: string): T[] {
    const results: T[] = [];
    
    // Handle both newline-separated and space-separated JSON
    // First try to find JSON objects by matching braces
    let depth = 0;
    let start = -1;
    
    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      
      if (char === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          try {
            const jsonStr = content.slice(start, i + 1);
            results.push(JSON.parse(jsonStr));
          } catch {
            // Skip malformed JSON
          }
          start = -1;
        }
      }
    }
    
    return results;
  }

  /**
   * Load all data from directory structure
   */
  private loadData(): void {
    if (this.loaded) return;
    
    console.log(`Loading Kaggle NDJSON data from: ${this.basePath}`);
    
    const marketDirs = readdirSync(this.basePath)
      .filter(name => name.startsWith('market='))
      .map(name => ({
        name,
        path: join(this.basePath, name),
        marketId: name.replace('market=', ''),
      }))
      .filter(m => {
        try {
          return statSync(m.path).isDirectory();
        } catch {
          return false;
        }
      });

    console.log(`Found ${marketDirs.length} market directories`);
    
    this.marketsCache = new Map();
    let totalPricePoints = 0;
    let marketsWithPrices = 0;
    let processed = 0;

    for (const marketDir of marketDirs) {
      processed++;
      if (processed % 500 === 0) {
        console.log(`Processing market ${processed}/${marketDirs.length}...`);
      }

      const pricePath = join(marketDir.path, 'price');
      if (!existsSync(pricePath)) continue;

      try {
        const priceFiles = readdirSync(pricePath).filter(f => f.endsWith('.ndjson'));
        if (priceFiles.length === 0) continue;

        const allPricePoints: PricePointData[] = [];
        let minTimestamp = Infinity;
        let maxTimestamp = 0;
        let lastYesPrice = 0.5;

        // Process each price file (one per token/outcome)
        for (const priceFile of priceFiles) {
          try {
            const content = readFileSync(join(pricePath, priceFile), 'utf-8');
            const points = this.parseNDJSON<NDJSONPricePoint>(content);

            for (const point of points) {
              // outcome_index 0 = NO, 1 = YES (typically)
              // We want YES prices
              if (point.outcome_index === 1 || priceFiles.length === 1) {
                const yesPrice = point.p;
                
                if (yesPrice >= 0 && yesPrice <= 1) {
                  if (point.t < minTimestamp) minTimestamp = point.t;
                  if (point.t > maxTimestamp) maxTimestamp = point.t;
                  lastYesPrice = yesPrice;

                  allPricePoints.push({
                    marketId: marketDir.marketId,
                    timestamp: new Date(point.t * 1000).toISOString(),
                    yesPrice,
                    noPrice: 1 - yesPrice,
                    volume: null,
                  });
                }
              }
            }
          } catch (error) {
            // Skip files we can't parse
          }
        }

        if (allPricePoints.length > 0) {
          // Sort by timestamp and dedupe (keep hourly resolution)
          allPricePoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          
          // Dedupe to hourly resolution to reduce memory
          const hourlyPoints: PricePointData[] = [];
          let lastHour = '';
          for (const point of allPricePoints) {
            const hour = point.timestamp.slice(0, 13); // YYYY-MM-DDTHH
            if (hour !== lastHour) {
              hourlyPoints.push(point);
              lastHour = hour;
            }
          }

          this.priceHistoryCache.set(marketDir.marketId, hourlyPoints);
          totalPricePoints += hourlyPoints.length;
          marketsWithPrices++;

          // Determine outcome from final price
          let outcome: 'YES' | 'NO' | null = null;
          if (lastYesPrice > 0.95) outcome = 'YES';
          else if (lastYesPrice < 0.05) outcome = 'NO';

          // Create market entry
          this.marketsCache.set(marketDir.marketId, {
            id: marketDir.marketId,
            question: `Market ${marketDir.marketId.slice(0, 10)}...`,
            category: null,
            resolutionDate: maxTimestamp > 0 
              ? new Date(maxTimestamp * 1000).toISOString() 
              : null,
            outcome,
            createdAt: minTimestamp < Infinity 
              ? new Date(minTimestamp * 1000).toISOString() 
              : null,
            isBinary: true,
            volumeUsd: null,
            liquidityUsd: null,
          });
        }
      } catch (error) {
        // Skip markets we can't process
      }
    }

    console.log(`Loaded ${marketsWithPrices} markets with ${totalPricePoints} price points`);
    this.loaded = true;
  }

  /**
   * Fetch markets
   */
  async fetchMarkets(filter: MarketFilter): Promise<MarketData[]> {
    this.loadData();
    
    let markets = Array.from(this.marketsCache?.values() || []);
    
    // Apply filters
    if (filter.resolved !== undefined) {
      markets = markets.filter(m => 
        filter.resolved ? m.outcome !== null : m.outcome === null
      );
    }
    if (filter.minResolutionDate) {
      markets = markets.filter(m => 
        m.resolutionDate && m.resolutionDate >= filter.minResolutionDate!
      );
    }
    if (filter.maxResolutionDate) {
      markets = markets.filter(m => 
        m.resolutionDate && m.resolutionDate <= filter.maxResolutionDate!
      );
    }
    if (filter.limit) {
      markets = markets.slice(0, filter.limit);
    }

    return markets;
  }

  /**
   * Fetch price history for a market
   */
  async fetchPriceHistory(marketId: string): Promise<PricePointData[]> {
    this.loadData();
    return this.priceHistoryCache.get(marketId) || [];
  }

  /**
   * Batch fetch price history
   */
  async fetchPriceHistoryBatch(marketIds: string[]): Promise<Map<string, PricePointData[]>> {
    this.loadData();
    const result = new Map<string, PricePointData[]>();
    for (const id of marketIds) {
      result.set(id, this.priceHistoryCache.get(id) || []);
    }
    return result;
  }
}

/**
 * Factory function
 */
export function createKaggleNDJSONDataSource(basePath: string): DataSource {
  return new KaggleNDJSONDataSource(basePath);
}

