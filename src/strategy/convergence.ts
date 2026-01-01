/**
 * Late-Stage Convergence Harvesting Strategy
 * 
 * Core insight: As time to resolution approaches, markets with clear outcomes
 * tend to drift toward certainty (0 or 1). Markets frequently lag this convergence,
 * creating positive expectancy trades.
 */

import { getConfig, type StrategyConfig, type RiskConfig } from '../config/index.js';
import type { Market, PricePoint } from '../db/schema.js';

/**
 * A potential trade signal
 */
export interface TradeSignal {
  marketId: string;
  side: 'YES' | 'NO';
  entryPrice: number;
  timestamp: string;
  timeToResolutionDays: number;
  reason: string;
}

/**
 * Exit signal for an open position
 */
export interface ExitSignal {
  marketId: string;
  exitPrice: number;
  timestamp: string;
  reason: 'target' | 'resolution' | 'stop_loss';
}

/**
 * Market eligibility check result
 */
export interface EligibilityResult {
  eligible: boolean;
  reason: string;
}

/**
 * Calculate days between two dates
 */
function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffMs = d2.getTime() - d1.getTime();
  return diffMs / (1000 * 60 * 60 * 24);
}

/**
 * The Convergence Strategy implementation
 */
export class ConvergenceStrategy {
  private config: StrategyConfig;
  private riskConfig: RiskConfig;

  constructor(config?: StrategyConfig, riskConfig?: RiskConfig) {
    const fullConfig = getConfig();
    this.config = config || fullConfig.strategy;
    this.riskConfig = riskConfig || fullConfig.risk;
  }

  /**
   * Check if a market is eligible for this strategy
   * Note: Category filtering removed - we track performance by category instead
   */
  checkEligibility(market: Market): EligibilityResult {
    // Must be binary
    if (!market.is_binary) {
      return { eligible: false, reason: 'Not a binary market' };
    }

    // Must have a resolution date
    if (!market.resolution_date) {
      return { eligible: false, reason: 'No resolution date' };
    }

    return { eligible: true, reason: 'Market is eligible' };
  }

  /**
   * Check if entry conditions are met at a given price point
   */
  checkEntryConditions(
    market: Market,
    pricePoint: PricePoint
  ): TradeSignal | null {
    // Check eligibility first
    const eligibility = this.checkEligibility(market);
    if (!eligibility.eligible) {
      return null;
    }

    // Calculate time to resolution
    const timeToResolution = daysBetween(pricePoint.timestamp, market.resolution_date!);
    
    // Check time window
    if (timeToResolution < this.config.timeToResolutionDaysMin ||
        timeToResolution > this.config.timeToResolutionDaysMax) {
      return null;
    }

    // Check YES side entry conditions
    if (pricePoint.yes_price >= this.config.entryPriceMin &&
        pricePoint.yes_price <= this.config.entryPriceMax) {
      return {
        marketId: market.id,
        side: 'YES',
        entryPrice: pricePoint.yes_price,
        timestamp: pricePoint.timestamp,
        timeToResolutionDays: timeToResolution,
        reason: `YES price ${pricePoint.yes_price.toFixed(3)} in range [${this.config.entryPriceMin}, ${this.config.entryPriceMax}]`,
      };
    }

    // Check NO side entry conditions (symmetric)
    const noEntryMin = 1 - this.config.entryPriceMax;
    const noEntryMax = 1 - this.config.entryPriceMin;
    
    if (pricePoint.no_price >= noEntryMin && pricePoint.no_price <= noEntryMax) {
      return {
        marketId: market.id,
        side: 'NO',
        entryPrice: pricePoint.no_price,
        timestamp: pricePoint.timestamp,
        timeToResolutionDays: timeToResolution,
        reason: `NO price ${pricePoint.no_price.toFixed(3)} in range [${noEntryMin.toFixed(2)}, ${noEntryMax.toFixed(2)}]`,
      };
    }

    return null;
  }

  /**
   * Check if exit conditions are met
   */
  checkExitConditions(
    side: 'YES' | 'NO',
    entryPrice: number,
    currentPrice: PricePoint,
    market: Market
  ): ExitSignal | null {
    const price = side === 'YES' ? currentPrice.yes_price : currentPrice.no_price;

    // Check target price reached (only if not holding to resolution)
    if (!this.config.holdToResolution && price >= this.config.exitPriceTarget) {
      return {
        marketId: market.id,
        exitPrice: price,
        timestamp: currentPrice.timestamp,
        reason: 'target',
      };
    }

    // Check stop loss if configured (always active, even when holding to resolution)
    if (this.riskConfig.stopLossPercent !== null) {
      const stopLossThreshold = entryPrice * (1 - this.riskConfig.stopLossPercent / 100);
      if (price <= stopLossThreshold) {
        return {
          marketId: market.id,
          exitPrice: price,
          timestamp: currentPrice.timestamp,
          reason: 'stop_loss',
        };
      }
    }

    // Check if market has resolved (only exit at resolution if we're past resolution date)
    if (market.outcome !== null && market.resolution_date) {
      const currentDate = new Date(currentPrice.timestamp);
      const resolutionDate = new Date(market.resolution_date);
      
      // Only exit at resolution if current price point is at or after resolution
      if (currentDate >= resolutionDate) {
        const finalPrice = (market.outcome === side) ? 1.0 : 0.0;
        return {
          marketId: market.id,
          exitPrice: finalPrice,
          timestamp: currentPrice.timestamp,
          reason: 'resolution',
        };
      }
    }

    return null;
  }

  /**
   * Calculate position size for a trade
   */
  calculatePositionSize(currentExposure: number, openPositions: number): number {
    // Check max positions
    if (openPositions >= this.riskConfig.maxPositions) {
      return 0;
    }

    // Check max exposure
    const remainingExposure = this.riskConfig.maxExposureUsd - currentExposure;
    if (remainingExposure <= 0) {
      return 0;
    }

    // Use configured position size, capped by remaining exposure
    return Math.min(this.riskConfig.positionSizeUsd, remainingExposure);
  }

  /**
   * Calculate PnL for a trade
   */
  calculatePnL(
    side: 'YES' | 'NO',
    entryPrice: number,
    exitPrice: number,
    sizeUsd: number
  ): number {
    // Calculate shares purchased
    const shares = sizeUsd / entryPrice;
    
    // Calculate exit value
    const exitValue = shares * exitPrice;
    
    // PnL is exit value minus entry cost
    return exitValue - sizeUsd;
  }

  /**
   * Get strategy parameters for display/logging
   */
  getParameters(): {
    strategy: StrategyConfig;
    risk: RiskConfig;
  } {
    return {
      strategy: this.config,
      risk: this.riskConfig,
    };
  }
}

/**
 * Create a convergence strategy instance
 */
export function createStrategy(config?: StrategyConfig, riskConfig?: RiskConfig): ConvergenceStrategy {
  return new ConvergenceStrategy(config, riskConfig);
}

/**
 * Get the default strategy instance
 */
let defaultStrategy: ConvergenceStrategy | null = null;

export function getStrategy(): ConvergenceStrategy {
  if (!defaultStrategy) {
    defaultStrategy = createStrategy();
  }
  return defaultStrategy;
}

