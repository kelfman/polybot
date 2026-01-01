/**
 * Kaggle data source adapter
 * Handles the partitioned directory structure from Kaggle dataset:
 * - market=0x.../
 *   - 2024-01-01.csv
 *   - 2024-01-02.csv
 *   - ...
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, join, basename } from 'path';
import type { DataSource, MarketData, PricePointData, MarketFilter } from './types.js';

/**
 * Parse a CSV line handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

/**
 * Kaggle price row from filtered_4_ML dataset
 */
interface KagglePriceRow {
  date: string;
  outcome: string; // 0 or 1
  p_open: string;
  p_high: string;
  p_low: string;
  p_close: string;
  count: string;
  // ... many more columns we don't need
}

/**
 * Kaggle data source implementation
 */
export class KaggleDataSource implements DataSource {
  readonly name = 'kaggle';
  private basePath: string;
  private marketsCache: Map<string, MarketData> | null = null;
  private priceHistoryCache: Map<string, PricePointData[]> = new Map();
  private loaded = false;

  constructor(basePath: string) {
    this.basePath = resolve(basePath);
  }

  /**
   * Test if Kaggle data is available
   */
  async isAvailable(): Promise<boolean> {
    if (!existsSync(this.basePath)) {
      return false;
    }
    
    try {
      const entries = readdirSync(this.basePath);
      // Look for market= directories
      return entries.some(e => e.startsWith('market='));
    } catch {
      return false;
    }
  }

  /**
   * Load all data from Kaggle directory structure
   */
  private loadData(): void {
    if (this.loaded) return;
    
    console.log(`Loading Kaggle data from: ${this.basePath}`);
    
    const marketDirs = readdirSync(this.basePath)
      .filter(name => name.startsWith('market='))
      .map(name => ({
        name,
        path: join(this.basePath, name),
        marketId: name.replace('market=', ''),
      }))
      .filter(m => statSync(m.path).isDirectory());

    console.log(`Found ${marketDirs.length} market directories`);
    
    this.marketsCache = new Map();
    let totalPricePoints = 0;
    let marketsWithPrices = 0;

    for (const marketDir of marketDirs) {
      const priceHistory: PricePointData[] = [];
      let minDate = '';
      let maxDate = '';
      let lastYesPrice = 0.5;
      let volume = 0;

      // Get all CSV files in this market directory
      const csvFiles = readdirSync(marketDir.path)
        .filter(f => f.endsWith('.csv'))
        .sort(); // Sort by date

      for (const csvFile of csvFiles) {
        const date = csvFile.replace('.csv', '');
        if (!minDate || date < minDate) minDate = date;
        if (!maxDate || date > maxDate) maxDate = date;

        try {
          const content = readFileSync(join(marketDir.path, csvFile), 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          
          if (lines.length < 2) continue;
          
          const headers = parseCSVLine(lines[0]);
          const dateIdx = headers.indexOf('date');
          const outcomeIdx = headers.indexOf('outcome');
          const pCloseIdx = headers.indexOf('p_close');
          const volQuoteIdx = headers.indexOf('vol_quote');

          // Parse rows (typically 2: one for outcome=0, one for outcome=1)
          for (let i = 1; i < lines.length; i++) {
            const values = parseCSVLine(lines[i]);
            const outcome = values[outcomeIdx];
            
            if (outcome === '1') { // YES outcome
              const yesPrice = parseFloat(values[pCloseIdx]) || 0.5;
              const dayVolume = parseFloat(values[volQuoteIdx]) || 0;
              
              if (yesPrice >= 0 && yesPrice <= 1) {
                lastYesPrice = yesPrice;
                volume += dayVolume;
                
                priceHistory.push({
                  marketId: marketDir.marketId,
                  timestamp: `${date}T00:00:00.000Z`,
                  yesPrice,
                  noPrice: 1 - yesPrice,
                  volume: dayVolume,
                });
              }
            }
          }
        } catch (error) {
          // Skip files we can't parse
        }
      }

      if (priceHistory.length > 0) {
        // Sort by timestamp
        priceHistory.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        this.priceHistoryCache.set(marketDir.marketId, priceHistory);
        totalPricePoints += priceHistory.length;
        marketsWithPrices++;

        // Determine outcome from final price
        const finalPrice = lastYesPrice;
        let outcome: 'YES' | 'NO' | null = null;
        if (finalPrice > 0.95) outcome = 'YES';
        else if (finalPrice < 0.05) outcome = 'NO';

        // Create market entry
        this.marketsCache.set(marketDir.marketId, {
          id: marketDir.marketId,
          question: `Market ${marketDir.marketId.slice(0, 10)}...`,
          category: null,
          resolutionDate: maxDate ? `${maxDate}T23:59:59.000Z` : null,
          outcome,
          createdAt: minDate ? `${minDate}T00:00:00.000Z` : null,
          isBinary: true,
          volumeUsd: volume,
          liquidityUsd: null,
        });
      }
    }

    console.log(`Loaded ${marketsWithPrices} markets with ${totalPricePoints} price points`);
    this.loaded = true;
  }

  /**
   * Fetch markets from Kaggle data
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
    if (filter.category) {
      markets = markets.filter(m => 
        m.category?.toLowerCase() === filter.category?.toLowerCase()
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
    for (const marketId of marketIds) {
      result.set(marketId, this.priceHistoryCache.get(marketId) || []);
    }
    return result;
  }
}

/**
 * Create a Kaggle data source instance
 */
export function createKaggleDataSource(basePath: string): DataSource {
  return new KaggleDataSource(basePath);
}

