/**
 * Unified data source interface for Polymarket data
 * Allows swapping between different data providers (Gamma API, CSV, etc.)
 */

/**
 * Market data from any data source
 */
export interface MarketData {
  id: string;
  question: string;
  category: string | null;
  resolutionDate: string | null;
  outcome: 'YES' | 'NO' | null;
  createdAt: string | null;
  isBinary: boolean;
  volumeUsd: number | null;
  liquidityUsd: number | null;
}

/**
 * Price point from any data source
 */
export interface PricePointData {
  marketId: string;
  timestamp: string;
  yesPrice: number;
  noPrice: number;
  volume: number | null;
}

/**
 * Filter options for fetching markets
 */
export interface MarketFilter {
  resolved?: boolean;
  category?: string;
  minResolutionDate?: string;
  maxResolutionDate?: string;
  limit?: number;
}

/**
 * Unified data source interface
 * Any data provider must implement this interface
 */
export interface DataSource {
  /**
   * Name of the data source for logging/debugging
   */
  readonly name: string;

  /**
   * Test if the data source is available and working
   */
  isAvailable(): Promise<boolean>;

  /**
   * Fetch markets matching the filter
   */
  fetchMarkets(filter: MarketFilter): Promise<MarketData[]>;

  /**
   * Fetch price history for a specific market
   */
  fetchPriceHistory(marketId: string): Promise<PricePointData[]>;

  /**
   * Fetch price history for multiple markets (batch operation)
   */
  fetchPriceHistoryBatch?(marketIds: string[]): Promise<Map<string, PricePointData[]>>;
}

/**
 * Result of a data fetch operation
 */
export interface FetchResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  source: string;
}

