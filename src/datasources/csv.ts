/**
 * CSV data source adapter for Kaggle/local data
 * Fallback source when Gamma API is unavailable
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
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
        // Escaped quote
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
 * Parse a CSV file into objects
 */
function parseCSV<T>(content: string): T[] {
  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];
  
  const headers = parseCSVLine(lines[0]);
  const result: T[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const obj: Record<string, string> = {};
    
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[j] || '';
    }
    
    result.push(obj as T);
  }
  
  return result;
}

/**
 * CSV row type for markets
 */
interface CSVMarketRow {
  id?: string;
  market_id?: string;
  question?: string;
  title?: string;
  category?: string;
  resolution_date?: string;
  end_date?: string;
  endDate?: string;
  outcome?: string;
  resolved?: string;
  created_at?: string;
  volume?: string;
  volume_usd?: string;
  liquidity?: string;
  liquidity_usd?: string;
}

/**
 * CSV row type for price history
 */
interface CSVPriceRow {
  market_id?: string;
  marketId?: string;
  timestamp?: string;
  time?: string;
  date?: string;
  yes_price?: string;
  yesPrice?: string;
  price?: string;
  no_price?: string;
  noPrice?: string;
  volume?: string;
}

/**
 * CSV data source implementation
 */
export class CSVDataSource implements DataSource {
  readonly name = 'csv';
  private basePath: string;
  private marketsCache: MarketData[] | null = null;
  private priceHistoryCache: Map<string, PricePointData[]> = new Map();

  constructor(basePath: string) {
    this.basePath = resolve(basePath);
  }

  /**
   * Test if CSV data is available
   */
  async isAvailable(): Promise<boolean> {
    if (!existsSync(this.basePath)) {
      return false;
    }
    
    // Check for any CSV files
    try {
      const files = readdirSync(this.basePath);
      return files.some(f => f.endsWith('.csv'));
    } catch {
      return false;
    }
  }

  /**
   * Load and cache markets from CSV
   */
  private loadMarkets(): MarketData[] {
    if (this.marketsCache) {
      return this.marketsCache;
    }

    const files = readdirSync(this.basePath).filter(f => f.endsWith('.csv'));
    
    // Look for markets file
    const marketsFile = files.find(f => 
      f.toLowerCase().includes('market') && 
      !f.toLowerCase().includes('price') &&
      !f.toLowerCase().includes('history')
    );
    
    if (!marketsFile) {
      console.warn('No markets CSV file found in', this.basePath);
      this.marketsCache = [];
      return [];
    }

    const content = readFileSync(join(this.basePath, marketsFile), 'utf-8');
    const rows = parseCSV<CSVMarketRow>(content);
    
    this.marketsCache = rows.map(row => this.transformMarketRow(row)).filter(Boolean) as MarketData[];
    console.log(`Loaded ${this.marketsCache.length} markets from ${marketsFile}`);
    
    return this.marketsCache;
  }

  /**
   * Load price history from CSV
   */
  private loadPriceHistory(): void {
    if (this.priceHistoryCache.size > 0) {
      return;
    }

    const files = readdirSync(this.basePath).filter(f => f.endsWith('.csv'));
    
    // Look for price history file
    const priceFile = files.find(f => 
      f.toLowerCase().includes('price') || 
      f.toLowerCase().includes('history')
    );
    
    if (!priceFile) {
      console.warn('No price history CSV file found in', this.basePath);
      return;
    }

    const content = readFileSync(join(this.basePath, priceFile), 'utf-8');
    const rows = parseCSV<CSVPriceRow>(content);
    
    // Group by market ID
    for (const row of rows) {
      const point = this.transformPriceRow(row);
      if (!point) continue;
      
      const existing = this.priceHistoryCache.get(point.marketId) || [];
      existing.push(point);
      this.priceHistoryCache.set(point.marketId, existing);
    }
    
    // Sort each market's history by timestamp
    for (const [marketId, history] of this.priceHistoryCache) {
      history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      this.priceHistoryCache.set(marketId, history);
    }
    
    console.log(`Loaded price history for ${this.priceHistoryCache.size} markets from ${priceFile}`);
  }

  /**
   * Fetch markets from CSV
   */
  async fetchMarkets(filter: MarketFilter): Promise<MarketData[]> {
    let markets = this.loadMarkets();
    
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
    this.loadPriceHistory();
    return this.priceHistoryCache.get(marketId) || [];
  }

  /**
   * Batch fetch price history
   */
  async fetchPriceHistoryBatch(marketIds: string[]): Promise<Map<string, PricePointData[]>> {
    this.loadPriceHistory();
    
    const result = new Map<string, PricePointData[]>();
    for (const marketId of marketIds) {
      result.set(marketId, this.priceHistoryCache.get(marketId) || []);
    }
    return result;
  }

  /**
   * Transform a CSV market row to MarketData
   */
  private transformMarketRow(row: CSVMarketRow): MarketData | null {
    const id = row.id || row.market_id;
    if (!id) return null;
    
    // Parse outcome
    let outcome: 'YES' | 'NO' | null = null;
    if (row.outcome) {
      const outcomeStr = row.outcome.toUpperCase();
      if (outcomeStr === 'YES' || outcomeStr === '1' || outcomeStr === 'TRUE') {
        outcome = 'YES';
      } else if (outcomeStr === 'NO' || outcomeStr === '0' || outcomeStr === 'FALSE') {
        outcome = 'NO';
      }
    } else if (row.resolved === 'true' || row.resolved === '1') {
      // Some datasets mark as resolved but don't specify outcome
      outcome = null; // Will need to infer from final price
    }

    return {
      id,
      question: row.question || row.title || 'Unknown',
      category: row.category || null,
      resolutionDate: row.resolution_date || row.end_date || row.endDate || null,
      outcome,
      createdAt: row.created_at || null,
      isBinary: true,
      volumeUsd: parseFloat(row.volume || row.volume_usd || '0') || null,
      liquidityUsd: parseFloat(row.liquidity || row.liquidity_usd || '0') || null,
    };
  }

  /**
   * Transform a CSV price row to PricePointData
   */
  private transformPriceRow(row: CSVPriceRow): PricePointData | null {
    const marketId = row.market_id || row.marketId;
    if (!marketId) return null;
    
    const timestamp = row.timestamp || row.time || row.date;
    if (!timestamp) return null;
    
    // Parse prices
    let yesPrice = parseFloat(row.yes_price || row.yesPrice || row.price || '0');
    let noPrice = parseFloat(row.no_price || row.noPrice || '0');
    
    // If only one price, calculate the other
    if (yesPrice && !noPrice) {
      noPrice = 1 - yesPrice;
    } else if (noPrice && !yesPrice) {
      yesPrice = 1 - noPrice;
    }
    
    // Validate prices
    if (yesPrice < 0 || yesPrice > 1) return null;
    
    return {
      marketId,
      timestamp: this.normalizeTimestamp(timestamp),
      yesPrice,
      noPrice,
      volume: row.volume ? parseFloat(row.volume) : null,
    };
  }

  /**
   * Normalize timestamp to ISO format
   */
  private normalizeTimestamp(timestamp: string): string {
    // If already ISO format, return as-is
    if (timestamp.includes('T')) {
      return timestamp;
    }
    
    // Try parsing as date
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
    
    // Return original if can't parse
    return timestamp;
  }
}

/**
 * Create a CSV data source instance
 */
export function createCSVDataSource(basePath: string): DataSource {
  return new CSVDataSource(basePath);
}

