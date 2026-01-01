/**
 * API Routes for live trading dashboard
 * Read-only endpoints - no controls
 */

import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/client.js';
import { TRADE_QUERIES, LIVE_TRADING_SCHEMA } from '../trading/schema.js';

const router = Router();

// Ensure live trading schema exists
try {
  const db = getDb();
  db.exec(LIVE_TRADING_SCHEMA);
} catch {}

// ============================================
// Bot Status
// ============================================

/**
 * Get current bot status (from most recent run)
 */
router.get('/status', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    
    // Get most recent bot run
    const latestRun = db.prepare(`
      SELECT * FROM bot_runs 
      ORDER BY started_at DESC 
      LIMIT 1
    `).get() as any;
    
    // Get latest state snapshot
    const latestSnapshot = db.prepare(`
      SELECT * FROM state_snapshots 
      ORDER BY timestamp DESC 
      LIMIT 1
    `).get() as any;
    
    // Count open trades
    const openTradesCount = db.prepare(`
      SELECT COUNT(*) as count FROM live_trades 
      WHERE status IN ('open', 'pending')
    `).get() as { count: number };
    
    res.json({
      isRunning: latestRun?.status === 'running',
      mode: latestRun?.mode || 'unknown',
      runId: latestRun?.run_id || null,
      startedAt: latestRun?.started_at || null,
      balance: latestSnapshot?.balance || 0,
      totalExposure: latestSnapshot?.total_exposure || 0,
      openPositions: latestSnapshot?.open_positions || 0,
      openOrders: latestSnapshot?.open_orders || 0,
      tradesPlaced: latestRun?.trades_placed || 0,
      tradesClosed: latestRun?.trades_closed || 0,
      totalPnl: latestRun?.total_pnl || 0,
      lastUpdated: latestSnapshot?.timestamp || null,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================
// Positions
// ============================================

/**
 * Get current open positions with PnL
 */
router.get('/positions', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    
    const positions = db.prepare(`
      SELECT 
        id, market_id, token_id, question, side,
        entry_price, size, size_usd, status, entry_time,
        category, is_objective, days_to_resolution, 
        liquidity, spread, qualification_score,
        pnl
      FROM live_trades 
      WHERE status IN ('open', 'pending')
      ORDER BY entry_time DESC
    `).all();
    
    res.json(positions);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================
// Trades
// ============================================

/**
 * Get all trades with full profiles
 */
router.get('/trades', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { status, category, limit } = req.query;
    
    let sql = 'SELECT * FROM live_trades WHERE 1=1';
    const params: any[] = [];
    
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    
    sql += ' ORDER BY created_at DESC';
    
    if (limit) {
      sql += ' LIMIT ?';
      params.push(parseInt(limit as string, 10));
    } else {
      sql += ' LIMIT 100';
    }
    
    const trades = db.prepare(sql).all(...params);
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get recent trades summary
 */
router.get('/trades/recent', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    
    const trades = db.prepare(`
      SELECT 
        id, question, category, 
        CASE WHEN is_objective = 1 THEN 1 ELSE 0 END as is_objective,
        entry_price, days_to_resolution, qualification_score, liquidity,
        status, pnl, entry_time, exit_time
      FROM live_trades 
      ORDER BY created_at DESC
      LIMIT 20
    `).all();
    
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================
// Analysis
// ============================================

/**
 * Get trade analysis breakdown
 */
router.get('/analyze', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    
    // Overall stats
    const overall = db.prepare(`
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_trades,
        SUM(CASE WHEN status IN ('open', 'pending') THEN 1 ELSE 0 END) as open_trades,
        ROUND(SUM(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) / 
          NULLIF(SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END), 0) * 100, 1) as win_rate,
        ROUND(SUM(pnl), 2) as total_pnl,
        ROUND(AVG(pnl), 2) as avg_pnl
      FROM live_trades
    `).get();
    
    // By category (all trades, for visibility before resolution)
    const byCategory = db.prepare(`
      SELECT 
        category,
        COUNT(*) as trade_count,
        SUM(CASE WHEN status = 'closed' AND pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'closed' AND pnl <= 0 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
        ROUND(AVG(qualification_score), 0) as avg_score,
        ROUND(AVG(liquidity), 0) as avg_liquidity,
        ROUND(SUM(size_usd), 2) as total_exposure
      FROM live_trades 
      WHERE category IS NOT NULL
      GROUP BY category
      ORDER BY trade_count DESC
    `).all();
    
    // By objective vs subjective (all trades)
    const byObjective = db.prepare(`
      SELECT 
        CASE WHEN is_objective = 1 THEN 'Objective 📐' ELSE 'Subjective 🎲' END as outcome_type,
        COUNT(*) as trade_count,
        ROUND(AVG(qualification_score), 0) as avg_score,
        ROUND(SUM(size_usd), 2) as total_exposure
      FROM live_trades 
      WHERE is_objective IS NOT NULL
      GROUP BY is_objective
    `).all();
    
    // By score range (all trades)
    const byScore = db.prepare(`
      SELECT 
        CASE 
          WHEN qualification_score >= 100 THEN '100+'
          WHEN qualification_score >= 80 THEN '80-99'
          WHEN qualification_score >= 60 THEN '60-79'
          ELSE '<60'
        END as score_range,
        COUNT(*) as trade_count,
        ROUND(SUM(size_usd), 2) as total_exposure
      FROM live_trades 
      WHERE qualification_score IS NOT NULL
      GROUP BY score_range
      ORDER BY qualification_score DESC
    `).all();
    
    // By liquidity range (all trades)
    const byLiquidity = db.prepare(`
      SELECT 
        CASE 
          WHEN liquidity >= 5000 THEN 'High ($5k+)'
          WHEN liquidity >= 1000 THEN 'Medium ($1k-$5k)'
          ELSE 'Low (<$1k)'
        END as liquidity_range,
        COUNT(*) as trade_count,
        ROUND(SUM(size_usd), 2) as total_exposure
      FROM live_trades 
      WHERE liquidity IS NOT NULL
      GROUP BY liquidity_range
    `).all();
    
    res.json({
      overall,
      byCategory,
      byObjective,
      byScore,
      byLiquidity,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================
// Recent Scans (from state snapshots)
// ============================================

/**
 * Get recent state snapshots (shows scan history)
 */
router.get('/snapshots', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    
    const snapshots = db.prepare(`
      SELECT 
        id, run_id, timestamp, balance, total_exposure, 
        open_positions, open_orders
      FROM state_snapshots 
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit);
    
    res.json(snapshots);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Get bot run history
 */
router.get('/runs', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    
    const runs = db.prepare(`
      SELECT * FROM bot_runs 
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit);
    
    res.json(runs);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

export default router;

