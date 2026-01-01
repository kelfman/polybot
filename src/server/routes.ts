/**
 * API Routes for the backtester dashboard
 */

import { Router, type Request, type Response } from 'express';
import { getConfig } from '../config/index.js';
import { 
  getDbStats, 
  getResolvedMarkets, 
  getMarket,
  getPriceHistory,
  getBacktestRuns,
  getBacktestRun,
  getBacktestTrades,
  getMarketsByFilter,
} from '../db/client.js';
import { createBacktestEngine } from '../backtest/engine.js';
import { calculateEquityCurve, calculateCategoryMetrics } from '../backtest/metrics.js';
import { analyzeVolatility, classifyMarket } from '../classification/index.js';

const router = Router();

// ============================================
// Health & Stats
// ============================================

/**
 * Health check endpoint
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Get database statistics
 */
router.get('/stats', (_req: Request, res: Response) => {
  try {
    const stats = getDbStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get current configuration
 */
router.get('/config', (_req: Request, res: Response) => {
  try {
    const config = getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get classification settings
 */
router.get('/classification', (_req: Request, res: Response) => {
  try {
    const config = getConfig();
    res.json({
      volatility: {
        enabled: config.classification.volatility.enabled,
        highVolatilityThreshold: config.classification.volatility.highVolatilityThreshold,
        swingCountThreshold: config.classification.volatility.swingCountThreshold,
      },
      llmConvergence: {
        enabled: config.classification.llmConvergence.enabled,
        provider: config.classification.llmConvergence.provider,
        model: config.classification.llmConvergence.model,
      },
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================
// Markets
// ============================================

/**
 * Get all markets with optional filters
 */
router.get('/markets', (req: Request, res: Response) => {
  try {
    const { resolved, category, limit } = req.query;
    
    const markets = getMarketsByFilter({
      resolved: resolved === 'true' ? true : resolved === 'false' ? false : undefined,
      category: category as string | undefined,
    });
    
    const limitNum = limit ? parseInt(limit as string, 10) : 100;
    res.json(markets.slice(0, limitNum));
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get a specific market
 */
router.get('/markets/:id', (req: Request, res: Response) => {
  try {
    const market = getMarket(req.params.id);
    if (!market) {
      res.status(404).json({ error: 'Market not found' });
      return;
    }
    res.json(market);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get price history for a market
 */
router.get('/markets/:id/prices', (req: Request, res: Response) => {
  try {
    const prices = getPriceHistory(req.params.id);
    res.json(prices);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get classification for a market
 */
router.get('/markets/:id/classification', async (req: Request, res: Response) => {
  try {
    const market = getMarket(req.params.id);
    if (!market) {
      res.status(404).json({ error: 'Market not found' });
      return;
    }
    
    const prices = getPriceHistory(req.params.id);
    const classification = await classifyMarket(market, prices);
    
    res.json(classification);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================
// Backtests
// ============================================

/**
 * Get all backtest runs
 */
router.get('/backtests', (_req: Request, res: Response) => {
  try {
    const runs = getBacktestRuns();
    res.json(runs);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get a specific backtest run
 */
router.get('/backtests/:id', (req: Request, res: Response) => {
  try {
    const run = getBacktestRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Backtest run not found' });
      return;
    }
    res.json(run);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get trades for a backtest run
 */
router.get('/backtests/:id/trades', (req: Request, res: Response) => {
  try {
    const trades = getBacktestTrades(req.params.id);
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get equity curve for a backtest run
 */
router.get('/backtests/:id/equity', (req: Request, res: Response) => {
  try {
    const trades = getBacktestTrades(req.params.id);
    const curve = calculateEquityCurve(trades);
    res.json(curve);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Run a new backtest
 */
router.post('/backtests/run', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, marketIds, dryRun } = req.body;
    
    const engine = createBacktestEngine();
    const result = await engine.run({
      startDate,
      endDate,
      marketIds,
      dryRun: dryRun === true,
    });
    
    // Convert Map to object for JSON serialization
    const classificationBreakdown = {
      byVolatility: result.classificationBreakdown.byVolatility,
      byConvergence: result.classificationBreakdown.byConvergence,
      byCategory: result.classificationBreakdown.byCategory,
    };
    
    res.json({
      runId: result.runId,
      success: result.success,
      metrics: result.metrics,
      marketsAnalyzed: result.marketsAnalyzed,
      tradesExecuted: result.trades.length,
      classificationBreakdown,
      duration: result.duration,
      errors: result.errors,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================
// Analysis
// ============================================

/**
 * Get convergence analysis for a market
 * Shows price vs time-to-resolution
 */
router.get('/analysis/convergence/:marketId', (req: Request, res: Response) => {
  try {
    const market = getMarket(req.params.marketId);
    if (!market) {
      res.status(404).json({ error: 'Market not found' });
      return;
    }
    
    if (!market.resolution_date) {
      res.status(400).json({ error: 'Market has no resolution date' });
      return;
    }
    
    const prices = getPriceHistory(req.params.marketId);
    const resolutionDate = new Date(market.resolution_date);
    
    // Calculate time to resolution for each price point
    const convergenceData = prices.map(p => {
      const priceDate = new Date(p.timestamp);
      const daysToResolution = (resolutionDate.getTime() - priceDate.getTime()) / (1000 * 60 * 60 * 24);
      
      return {
        timestamp: p.timestamp,
        daysToResolution: Math.max(0, daysToResolution),
        yesPrice: p.yes_price,
        noPrice: p.no_price,
      };
    });
    
    res.json({
      market,
      convergenceData,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get volatility analysis for a market
 */
router.get('/analysis/volatility/:marketId', (req: Request, res: Response) => {
  try {
    const market = getMarket(req.params.marketId);
    if (!market) {
      res.status(404).json({ error: 'Market not found' });
      return;
    }
    
    const prices = getPriceHistory(req.params.marketId);
    const config = getConfig();
    
    const analysis = analyzeVolatility(prices, config.classification.volatility);
    
    res.json({
      market: {
        id: market.id,
        question: market.question,
        category: market.category,
      },
      analysis,
      threshold: {
        highVolatilityThreshold: config.classification.volatility.highVolatilityThreshold,
        swingCountThreshold: config.classification.volatility.swingCountThreshold,
      },
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get category performance breakdown for a backtest run
 */
router.get('/backtests/:id/categories', (req: Request, res: Response) => {
  try {
    const trades = getBacktestTrades(req.params.id);
    
    if (trades.length === 0) {
      res.json([]);
      return;
    }
    
    const categoryMetrics = calculateCategoryMetrics(
      trades,
      (marketId) => getMarket(marketId)
    );
    
    res.json(categoryMetrics);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get full classification breakdown for a backtest run
 * Returns performance by volatility, convergence type, and category
 */
router.get('/backtests/:id/breakdown', async (req: Request, res: Response) => {
  try {
    const trades = getBacktestTrades(req.params.id);
    
    if (trades.length === 0) {
      res.json({
        byVolatility: [],
        byConvergence: [],
        byCategory: [],
      });
      return;
    }
    
    // Get unique market IDs from trades
    const marketIds = [...new Set(trades.map(t => t.market_id))];
    
    // Classify each market
    const { calculateClassificationBreakdown } = await import('../classification/index.js');
    const classifications = new Map();
    
    for (const marketId of marketIds) {
      const market = getMarket(marketId);
      if (market) {
        const prices = getPriceHistory(marketId);
        const classification = await classifyMarket(market, prices);
        classifications.set(marketId, classification);
      }
    }
    
    // Calculate breakdown
    const breakdown = calculateClassificationBreakdown(
      trades,
      classifications,
      (marketId) => getMarket(marketId)
    );
    
    res.json(breakdown);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

export default router;
