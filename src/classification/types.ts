/**
 * Classification types for market analysis
 * Classifications are used to categorize markets for performance analysis,
 * NOT for filtering (we analyze all markets and compare performance by classification)
 */

import type { Market, PricePoint } from '../db/schema.js';

/**
 * Volatility classification levels
 */
export type VolatilityLevel = 'low' | 'medium' | 'high';

/**
 * Convergence type classification from LLM
 */
export type ConvergenceType = 
  | 'natural'      // Natural convergence (scheduled event, measurable metric)
  | 'uncertain'    // Unpredictable (court ruling, discretionary decision)
  | 'unknown';     // Could not determine or not classified

/**
 * Complete classification for a market
 */
export interface MarketClassification {
  marketId: string;
  
  // Volatility classification
  volatility: {
    level: VolatilityLevel;
    maxDailySwing: number;
    averageDailySwing: number;
    largeSwingsCount: number;
    swingDates: string[];
  };
  
  // Convergence classification (from LLM if enabled)
  convergence: {
    type: ConvergenceType;
    confidence: number;
    reasoning: string;
  };
}

/**
 * Performance metrics grouped by a classification dimension
 */
export interface ClassificationPerformance {
  label: string;
  tradeCount: number;
  winningTrades: number;
  winRate: number;
  totalPnL: number;
  averagePnL: number;
}

/**
 * Full classification breakdown for backtest results
 */
export interface ClassificationBreakdown {
  byVolatility: ClassificationPerformance[];
  byConvergence: ClassificationPerformance[];
  byCategory: ClassificationPerformance[];
}

