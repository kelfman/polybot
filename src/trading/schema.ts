/**
 * Database schema for live trading
 * Tracks trades, orders, and bot state
 */

export const LIVE_TRADING_SCHEMA = `
-- Live trades table - tracks all bot trades with full market profile
CREATE TABLE IF NOT EXISTS live_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  token_id TEXT,
  question TEXT,
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  entry_price REAL,
  exit_price REAL,
  size REAL NOT NULL,
  size_usd REAL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'open', 'closed', 'cancelled', 'unknown')),
  entry_time TEXT,
  exit_time TEXT,
  order_id TEXT,
  pnl REAL,
  exit_reason TEXT,
  
  -- Market profile (for analysis)
  category TEXT,
  is_objective INTEGER,
  days_to_resolution REAL,
  liquidity REAL,
  spread REAL,
  qualification_score INTEGER,
  
  -- Resolution outcome
  resolution_price REAL,
  resolved_at TEXT,
  
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Order tracking table - prevents duplicates and tracks order lifecycle
CREATE TABLE IF NOT EXISTS order_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE,
  market_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  price REAL NOT NULL,
  size REAL NOT NULL,
  order_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'submitted', 'live', 'filled', 'cancelled', 'failed')),
  polymarket_status TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  filled_at TEXT,
  error_message TEXT
);

-- Bot run log - tracks bot sessions
CREATE TABLE IF NOT EXISTS bot_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT UNIQUE NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'paper')),
  status TEXT NOT NULL CHECK (status IN ('running', 'stopped', 'crashed')),
  trades_placed INTEGER DEFAULT 0,
  trades_closed INTEGER DEFAULT 0,
  total_pnl REAL DEFAULT 0,
  notes TEXT
);

-- State snapshots - periodic state captures for debugging
CREATE TABLE IF NOT EXISTS state_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  balance REAL,
  total_exposure REAL,
  open_positions INTEGER,
  open_orders INTEGER,
  state_json TEXT,
  FOREIGN KEY (run_id) REFERENCES bot_runs(run_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_live_trades_market ON live_trades(market_id);
CREATE INDEX IF NOT EXISTS idx_live_trades_status ON live_trades(status);
CREATE INDEX IF NOT EXISTS idx_order_tracking_market ON order_tracking(market_id);
CREATE INDEX IF NOT EXISTS idx_order_tracking_status ON order_tracking(status);
CREATE INDEX IF NOT EXISTS idx_order_tracking_idempotency ON order_tracking(idempotency_key);
`;

export interface LiveTrade {
  id: number;
  market_id: string;
  token_id: string | null;
  question: string | null;
  side: 'YES' | 'NO';
  entry_price: number | null;
  exit_price: number | null;
  size: number;
  size_usd: number | null;
  status: 'pending' | 'open' | 'closed' | 'cancelled' | 'unknown';
  entry_time: string | null;
  exit_time: string | null;
  order_id: string | null;
  pnl: number | null;
  exit_reason: string | null;
  
  // Market profile
  category: string | null;
  is_objective: number | null;  // 1 = true, 0 = false
  days_to_resolution: number | null;
  liquidity: number | null;
  spread: number | null;
  qualification_score: number | null;
  
  // Resolution
  resolution_price: number | null;
  resolved_at: string | null;
  
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderTracking {
  id: number;
  order_id: string | null;
  market_id: string;
  token_id: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  order_type: string;
  status: 'created' | 'submitted' | 'live' | 'filled' | 'cancelled' | 'failed';
  polymarket_status: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  filled_at: string | null;
  error_message: string | null;
}

export interface BotRun {
  id: number;
  run_id: string;
  started_at: string;
  ended_at: string | null;
  mode: 'live' | 'paper';
  status: 'running' | 'stopped' | 'crashed';
  trades_placed: number;
  trades_closed: number;
  total_pnl: number;
  notes: string | null;
}

// Trade analysis queries
export interface TradeAnalysis {
  category: string;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  avgScore: number;
  avgLiquidity: number;
}

export const TRADE_QUERIES = {
  // Get all trades with full profile
  allTrades: `
    SELECT * FROM live_trades 
    ORDER BY created_at DESC
  `,
  
  // Performance by category
  performanceByCategory: `
    SELECT 
      category,
      COUNT(*) as trade_count,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as win_count,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as loss_count,
      ROUND(AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as win_rate,
      ROUND(AVG(pnl), 2) as avg_pnl,
      ROUND(SUM(pnl), 2) as total_pnl,
      ROUND(AVG(qualification_score), 0) as avg_score,
      ROUND(AVG(liquidity), 0) as avg_liquidity
    FROM live_trades 
    WHERE status = 'closed'
    GROUP BY category
    ORDER BY total_pnl DESC
  `,
  
  // Performance by objective vs subjective
  performanceByObjective: `
    SELECT 
      CASE WHEN is_objective = 1 THEN 'Objective' ELSE 'Subjective' END as outcome_type,
      COUNT(*) as trade_count,
      ROUND(AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as win_rate,
      ROUND(AVG(pnl), 2) as avg_pnl,
      ROUND(SUM(pnl), 2) as total_pnl
    FROM live_trades 
    WHERE status = 'closed'
    GROUP BY is_objective
  `,
  
  // Performance by score range
  performanceByScoreRange: `
    SELECT 
      CASE 
        WHEN qualification_score >= 100 THEN '100+'
        WHEN qualification_score >= 80 THEN '80-99'
        WHEN qualification_score >= 60 THEN '60-79'
        ELSE '<60'
      END as score_range,
      COUNT(*) as trade_count,
      ROUND(AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as win_rate,
      ROUND(AVG(pnl), 2) as avg_pnl,
      ROUND(SUM(pnl), 2) as total_pnl
    FROM live_trades 
    WHERE status = 'closed'
    GROUP BY score_range
    ORDER BY score_range DESC
  `,
  
  // Performance by liquidity range
  performanceByLiquidity: `
    SELECT 
      CASE 
        WHEN liquidity >= 5000 THEN 'High ($5k+)'
        WHEN liquidity >= 1000 THEN 'Medium ($1k-$5k)'
        ELSE 'Low (<$1k)'
      END as liquidity_range,
      COUNT(*) as trade_count,
      ROUND(AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as win_rate,
      ROUND(AVG(pnl), 2) as avg_pnl,
      ROUND(SUM(pnl), 2) as total_pnl
    FROM live_trades 
    WHERE status = 'closed'
    GROUP BY liquidity_range
  `,
  
  // Recent trades summary
  recentTradesSummary: `
    SELECT 
      id, question, category, 
      CASE WHEN is_objective = 1 THEN '📐' ELSE '🎲' END as obj,
      ROUND(entry_price * 100, 0) || '¢' as entry,
      ROUND(days_to_resolution, 1) || 'd' as days,
      qualification_score as score,
      ROUND(liquidity, 0) as liq,
      status,
      ROUND(pnl, 2) as pnl
    FROM live_trades 
    ORDER BY created_at DESC
    LIMIT 20
  `
};

