/**
 * Volatility Classification
 * Classifies markets by their price volatility patterns
 */

import { getConfig, type VolatilityClassificationConfig } from '../config/index.js';
import type { PricePoint } from '../db/schema.js';
import type { VolatilityLevel } from './types.js';

/**
 * Volatility analysis result
 */
export interface VolatilityAnalysis {
  level: VolatilityLevel;
  maxDailySwing: number;
  averageDailySwing: number;
  largeSwingsCount: number;
  swingDates: string[];
}

/**
 * Analyze price history for volatility patterns
 */
export function analyzeVolatility(
  priceHistory: PricePoint[],
  config?: VolatilityClassificationConfig
): VolatilityAnalysis {
  const classConfig = config || getConfig().classification.volatility;
  
  if (priceHistory.length < 2) {
    return {
      level: 'low',
      maxDailySwing: 0,
      averageDailySwing: 0,
      largeSwingsCount: 0,
      swingDates: [],
    };
  }

  // Sort price history by timestamp
  const sortedHistory = [...priceHistory].sort((a, b) => 
    a.timestamp.localeCompare(b.timestamp)
  );

  // Calculate day-to-day price changes
  const dailySwings: { date: string; swing: number }[] = [];
  
  for (let i = 1; i < sortedHistory.length; i++) {
    const prevPrice = sortedHistory[i - 1].yes_price;
    const currPrice = sortedHistory[i].yes_price;
    const date = sortedHistory[i].timestamp.split('T')[0];
    
    // Swing as absolute percentage points (0-100 scale)
    const swing = Math.abs(currPrice - prevPrice) * 100;
    
    dailySwings.push({ date, swing });
  }

  if (dailySwings.length === 0) {
    return {
      level: 'low',
      maxDailySwing: 0,
      averageDailySwing: 0,
      largeSwingsCount: 0,
      swingDates: [],
    };
  }

  // Calculate statistics
  const swingValues = dailySwings.map(s => s.swing);
  const averageDailySwing = swingValues.reduce((a, b) => a + b, 0) / swingValues.length;
  const maxDailySwing = Math.max(...swingValues);
  
  // Find large swings (above threshold)
  const largeSwings = dailySwings.filter(s => s.swing > classConfig.highVolatilityThreshold);
  const largeSwingsCount = largeSwings.length;
  const swingDates = largeSwings.map(s => s.date);

  // Determine volatility level
  let level: VolatilityLevel;
  if (largeSwingsCount >= classConfig.swingCountThreshold) {
    level = 'high';
  } else if (largeSwingsCount > 0 || averageDailySwing > classConfig.highVolatilityThreshold / 2) {
    level = 'medium';
  } else {
    level = 'low';
  }

  return {
    level,
    maxDailySwing,
    averageDailySwing,
    largeSwingsCount,
    swingDates,
  };
}

/**
 * Get a human-readable description of volatility level
 */
export function describeVolatility(level: VolatilityLevel): string {
  switch (level) {
    case 'low':
      return 'Low volatility - stable price movements';
    case 'medium':
      return 'Medium volatility - some price swings';
    case 'high':
      return 'High volatility - significant price swings (possible manipulation)';
  }
}

