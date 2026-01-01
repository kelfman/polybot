/**
 * Data source factory
 * Creates and manages data sources with fallback support
 */

import { getConfig } from '../config/index.js';
import { createGammaDataSource } from './gamma.js';
import { createCSVDataSource } from './csv.js';
import { createKaggleDataSource } from './kaggle.js';
import { createKaggleNDJSONDataSource } from './kaggle-ndjson.js';
import type { DataSource, MarketData, PricePointData, MarketFilter, FetchResult } from './types.js';

export type { DataSource, MarketData, PricePointData, MarketFilter, FetchResult } from './types.js';

/**
 * Data source manager with fallback support
 */
export class DataSourceManager {
  private primary: DataSource;
  private fallback: DataSource | null;

  constructor(primary: DataSource, fallback?: DataSource) {
    this.primary = primary;
    this.fallback = fallback || null;
  }

  /**
   * Get the name of the active data source
   */
  get activeSources(): string[] {
    const sources = [this.primary.name];
    if (this.fallback) {
      sources.push(this.fallback.name);
    }
    return sources;
  }

  /**
   * Fetch markets with fallback
   */
  async fetchMarkets(filter: MarketFilter): Promise<FetchResult<MarketData[]>> {
    // Try primary
    try {
      if (await this.primary.isAvailable()) {
        const data = await this.primary.fetchMarkets(filter);
        return { success: true, data, source: this.primary.name };
      }
    } catch (error) {
      console.warn(`Primary data source (${this.primary.name}) failed:`, error);
    }

    // Try fallback
    if (this.fallback) {
      try {
        if (await this.fallback.isAvailable()) {
          const data = await this.fallback.fetchMarkets(filter);
          return { success: true, data, source: this.fallback.name };
        }
      } catch (error) {
        console.warn(`Fallback data source (${this.fallback.name}) failed:`, error);
      }
    }

    return {
      success: false,
      error: 'All data sources unavailable',
      source: 'none',
    };
  }

  /**
   * Fetch price history with fallback
   */
  async fetchPriceHistory(marketId: string): Promise<FetchResult<PricePointData[]>> {
    // Try primary
    try {
      if (await this.primary.isAvailable()) {
        const data = await this.primary.fetchPriceHistory(marketId);
        return { success: true, data, source: this.primary.name };
      }
    } catch (error) {
      console.warn(`Primary data source (${this.primary.name}) failed for ${marketId}:`, error);
    }

    // Try fallback
    if (this.fallback) {
      try {
        if (await this.fallback.isAvailable()) {
          const data = await this.fallback.fetchPriceHistory(marketId);
          return { success: true, data, source: this.fallback.name };
        }
      } catch (error) {
        console.warn(`Fallback data source (${this.fallback.name}) failed for ${marketId}:`, error);
      }
    }

    return {
      success: false,
      error: `No data source available for market ${marketId}`,
      source: 'none',
    };
  }

  /**
   * Fetch price history for multiple markets
   */
  async fetchPriceHistoryBatch(marketIds: string[]): Promise<Map<string, PricePointData[]>> {
    const result = new Map<string, PricePointData[]>();
    
    // Try batch method if available
    const source = (await this.primary.isAvailable()) ? this.primary : this.fallback;
    
    if (source?.fetchPriceHistoryBatch) {
      try {
        return await source.fetchPriceHistoryBatch(marketIds);
      } catch (error) {
        console.warn('Batch fetch failed, falling back to individual fetches:', error);
      }
    }
    
    // Fallback to individual fetches
    for (const marketId of marketIds) {
      const fetchResult = await this.fetchPriceHistory(marketId);
      result.set(marketId, fetchResult.data || []);
    }
    
    return result;
  }
}

/**
 * Create a data source based on config
 */
export function createDataSource(type: 'gamma' | 'csv' | 'kaggle' | 'kaggle-ndjson', csvPath?: string): DataSource {
  switch (type) {
    case 'gamma':
      return createGammaDataSource();
    case 'csv':
      return createCSVDataSource(csvPath || './data/kaggle');
    case 'kaggle':
      return createKaggleDataSource(csvPath || './data/kaggle/filtered_4_ML/filtered_4_ML');
    case 'kaggle-ndjson':
      return createKaggleNDJSONDataSource(csvPath || './data/kaggle/Polymarket_dataset/Polymarket_dataset');
    default:
      throw new Error(`Unknown data source type: ${type}`);
  }
}

/**
 * Create data source manager from config
 */
export function createDataSourceManager(): DataSourceManager {
  const config = getConfig();
  
  const primary = createDataSource(
    config.dataSource.primary,
    config.dataSource.csvPath
  );
  
  let fallback: DataSource | undefined;
  if (config.dataSource.fallback !== 'none') {
    fallback = createDataSource(
      config.dataSource.fallback,
      config.dataSource.csvPath
    );
  }
  
  return new DataSourceManager(primary, fallback);
}

// Default export for convenience
let defaultManager: DataSourceManager | null = null;

/**
 * Get the default data source manager (singleton)
 */
export function getDataSourceManager(): DataSourceManager {
  if (!defaultManager) {
    defaultManager = createDataSourceManager();
  }
  return defaultManager;
}

