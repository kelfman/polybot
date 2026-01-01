/**
 * Classification module
 * Classifies markets by volatility, convergence type, and category
 * Used for performance analysis, NOT filtering
 */

import { getConfig } from '../config/index.js';
import { getPriceHistory } from '../db/client.js';
import { analyzeVolatility, type VolatilityAnalysis } from './volatility.js';
import { classifyConvergence, type ConvergenceClassification } from './convergence.js';
import type { Market, PricePoint } from '../db/schema.js';
import type { MarketClassification, ClassificationBreakdown, ClassificationPerformance, VolatilityLevel, ConvergenceType } from './types.js';

export type { MarketClassification, ClassificationBreakdown, ClassificationPerformance, VolatilityLevel, ConvergenceType } from './types.js';
export { analyzeVolatility, describeVolatility, type VolatilityAnalysis } from './volatility.js';
export { classifyConvergence, describeConvergence, clearClassificationCache, getCacheStats, type ConvergenceClassification } from './convergence.js';

/**
 * Classify a market on all dimensions
 */
export async function classifyMarket(
  market: Market,
  priceHistory?: PricePoint[]
): Promise<MarketClassification> {
  const config = getConfig();
  const history = priceHistory || getPriceHistory(market.id);
  
  // Volatility classification
  let volatilityAnalysis: VolatilityAnalysis;
  if (config.classification.volatility.enabled) {
    volatilityAnalysis = analyzeVolatility(history, config.classification.volatility);
  } else {
    volatilityAnalysis = {
      level: 'low',
      maxDailySwing: 0,
      averageDailySwing: 0,
      largeSwingsCount: 0,
      swingDates: [],
    };
  }
  
  // Convergence classification
  let convergenceResult: ConvergenceClassification;
  if (config.classification.llmConvergence.enabled) {
    convergenceResult = await classifyConvergence(market.question, config.classification.llmConvergence);
  } else {
    convergenceResult = {
      type: 'unknown',
      confidence: 0,
      reasoning: 'Classification disabled',
    };
  }
  
  return {
    marketId: market.id,
    volatility: {
      level: volatilityAnalysis.level,
      maxDailySwing: volatilityAnalysis.maxDailySwing,
      averageDailySwing: volatilityAnalysis.averageDailySwing,
      largeSwingsCount: volatilityAnalysis.largeSwingsCount,
      swingDates: volatilityAnalysis.swingDates,
    },
    convergence: {
      type: convergenceResult.type,
      confidence: convergenceResult.confidence,
      reasoning: convergenceResult.reasoning,
    },
  };
}

/**
 * Calculate performance breakdown by classification dimensions
 */
export function calculateClassificationBreakdown(
  trades: Array<{
    market_id: string;
    pnl: number | null;
  }>,
  classifications: Map<string, MarketClassification>,
  marketLookup: (id: string) => Market | undefined
): ClassificationBreakdown {
  // Filter to completed trades
  const completedTrades = trades.filter(t => t.pnl !== null);
  
  // Group by volatility level
  const byVolatilityMap = new Map<VolatilityLevel, typeof completedTrades>();
  // Group by convergence type
  const byConvergenceMap = new Map<ConvergenceType, typeof completedTrades>();
  // Group by category
  const byCategoryMap = new Map<string, typeof completedTrades>();
  
  for (const trade of completedTrades) {
    const classification = classifications.get(trade.market_id);
    const market = marketLookup(trade.market_id);
    
    // Volatility grouping
    const volLevel = classification?.volatility.level || 'low';
    const volGroup = byVolatilityMap.get(volLevel) || [];
    volGroup.push(trade);
    byVolatilityMap.set(volLevel, volGroup);
    
    // Convergence grouping
    const convType = classification?.convergence.type || 'unknown';
    const convGroup = byConvergenceMap.get(convType) || [];
    convGroup.push(trade);
    byConvergenceMap.set(convType, convGroup);
    
    // Category grouping
    const category = market?.category || 'unknown';
    const catGroup = byCategoryMap.get(category) || [];
    catGroup.push(trade);
    byCategoryMap.set(category, catGroup);
  }
  
  // Calculate performance for each group
  const calcPerformance = (label: string, groupTrades: typeof completedTrades): ClassificationPerformance => {
    const tradeCount = groupTrades.length;
    const winningTrades = groupTrades.filter(t => t.pnl! > 0).length;
    const winRate = tradeCount > 0 ? winningTrades / tradeCount : 0;
    const totalPnL = groupTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const averagePnL = tradeCount > 0 ? totalPnL / tradeCount : 0;
    
    return { label, tradeCount, winningTrades, winRate, totalPnL, averagePnL };
  };
  
  // Build breakdown
  const byVolatility: ClassificationPerformance[] = [];
  for (const level of ['low', 'medium', 'high'] as VolatilityLevel[]) {
    const group = byVolatilityMap.get(level) || [];
    if (group.length > 0) {
      byVolatility.push(calcPerformance(level, group));
    }
  }
  
  const byConvergence: ClassificationPerformance[] = [];
  for (const type of ['natural', 'uncertain', 'unknown'] as ConvergenceType[]) {
    const group = byConvergenceMap.get(type) || [];
    if (group.length > 0) {
      byConvergence.push(calcPerformance(type, group));
    }
  }
  
  const byCategory: ClassificationPerformance[] = [];
  for (const [category, group] of byCategoryMap) {
    byCategory.push(calcPerformance(category, group));
  }
  // Sort by trade count
  byCategory.sort((a, b) => b.tradeCount - a.tradeCount);
  
  return { byVolatility, byConvergence, byCategory };
}

