/**
 * SQLite database schema definitions
 */

export const SCHEMA_VERSION = 1;

/**
 * SQL statements to create the database schema
 */
export const CREATE_TABLES = `
-- Schema version tracking for migrations
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Markets table: stores market metadata
CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  category TEXT,
  resolution_date TEXT,
  outcome TEXT,           -- 'YES', 'NO', or NULL if unresolved
  created_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  -- Additional metadata for filtering
  is_binary INTEGER NOT NULL DEFAULT 1,
  volume_usd REAL,
  liquidity_usd REAL
);

-- Price history table: timestamped prices for each market
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  yes_price REAL NOT NULL,
  no_price REAL NOT NULL,
  volume REAL,
  
  FOREIGN KEY (market_id) REFERENCES markets(id),
  UNIQUE(market_id, timestamp)
);

-- Index for efficient price history queries
CREATE INDEX IF NOT EXISTS idx_price_history_market_time 
  ON price_history(market_id, timestamp);

-- Backtest trades table: simulated trades with full audit trail
CREATE TABLE IF NOT EXISTS backtest_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,           -- Group trades by backtest run
  market_id TEXT NOT NULL,
  side TEXT NOT NULL,             -- 'YES' or 'NO'
  entry_time TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_time TEXT,
  exit_price REAL,
  size_usd REAL NOT NULL,
  pnl REAL,
  exit_reason TEXT,               -- 'target', 'resolution', 'stop_loss', NULL if still open
  
  FOREIGN KEY (market_id) REFERENCES markets(id)
);

-- Index for querying trades by run
CREATE INDEX IF NOT EXISTS idx_backtest_trades_run 
  ON backtest_trades(run_id);

-- Backtest runs table: metadata about each backtest execution
CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  config_snapshot TEXT NOT NULL,  -- JSON snapshot of config used
  total_trades INTEGER,
  winning_trades INTEGER,
  total_pnl REAL,
  max_drawdown REAL,
  sharpe_ratio REAL
);
`;

/**
 * TypeScript types matching the database schema
 */
export interface Market {
  id: string;
  question: string;
  category: string | null;
  resolution_date: string | null;
  outcome: 'YES' | 'NO' | null;
  created_at: string | null;
  fetched_at: string;
  is_binary: number;
  volume_usd: number | null;
  liquidity_usd: number | null;
}

export interface PricePoint {
  id?: number;
  market_id: string;
  timestamp: string;
  yes_price: number;
  no_price: number;
  volume: number | null;
}

export interface BacktestTrade {
  id?: number;
  run_id: string;
  market_id: string;
  side: 'YES' | 'NO';
  entry_time: string;
  entry_price: number;
  exit_time: string | null;
  exit_price: number | null;
  size_usd: number;
  pnl: number | null;
  exit_reason: 'target' | 'resolution' | 'stop_loss' | null;
}

export interface BacktestRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  config_snapshot: string;
  total_trades: number | null;
  winning_trades: number | null;
  total_pnl: number | null;
  max_drawdown: number | null;
  sharpe_ratio: number | null;
}

