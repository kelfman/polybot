import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CREATE_TABLES, SCHEMA_VERSION } from './schema.js';
import type { Market, PricePoint, BacktestTrade, BacktestRun } from './schema.js';

// Get absolute path relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_DB_PATH = resolve(__dirname, '..', '..', 'data', 'polymarket.db');

let db: Database.Database | null = null;

/**
 * Get or create database connection
 */
export function getDb(dbPath?: string): Database.Database {
  if (db) return db;
  
  const path = dbPath || DEFAULT_DB_PATH;
  db = new Database(path);
  
  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');
  
  // Initialize schema
  initializeSchema(db);
  
  return db;
}

/**
 * Initialize database schema if not exists
 */
function initializeSchema(database: Database.Database): void {
  // Check if schema_version table exists
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  
  if (!tableExists) {
    // Fresh database - create all tables
    database.exec(CREATE_TABLES);
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    console.log(`Database initialized with schema version ${SCHEMA_VERSION}`);
  } else {
    // Check version for migrations
    const row = database.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number };
    if (row.version < SCHEMA_VERSION) {
      console.log(`Database migration needed: ${row.version} -> ${SCHEMA_VERSION}`);
      // Future: run migrations here
    }
  }
}

/**
 * Close database connection
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============================================
// Market Operations
// ============================================

/**
 * Insert or update a market
 */
export function upsertMarket(market: Omit<Market, 'fetched_at'>): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO markets (id, question, category, resolution_date, outcome, created_at, is_binary, volume_usd, liquidity_usd)
    VALUES (@id, @question, @category, @resolution_date, @outcome, @created_at, @is_binary, @volume_usd, @liquidity_usd)
    ON CONFLICT(id) DO UPDATE SET
      question = @question,
      category = @category,
      resolution_date = @resolution_date,
      outcome = @outcome,
      volume_usd = @volume_usd,
      liquidity_usd = @liquidity_usd,
      fetched_at = datetime('now')
  `);
  stmt.run(market);
}

/**
 * Get a market by ID
 */
export function getMarket(id: string): Market | undefined {
  const database = getDb();
  return database.prepare('SELECT * FROM markets WHERE id = ?').get(id) as Market | undefined;
}

/**
 * Get all resolved binary markets
 */
export function getResolvedMarkets(): Market[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM markets 
    WHERE outcome IS NOT NULL 
    AND is_binary = 1
    ORDER BY resolution_date DESC
  `).all() as Market[];
}

/**
 * Get markets matching filter criteria
 */
export function getMarketsByFilter(options: {
  resolved?: boolean;
  category?: string;
  minResolutionDate?: string;
  maxResolutionDate?: string;
}): Market[] {
  const database = getDb();
  const conditions: string[] = ['is_binary = 1'];
  const params: Record<string, unknown> = {};
  
  if (options.resolved !== undefined) {
    conditions.push(options.resolved ? 'outcome IS NOT NULL' : 'outcome IS NULL');
  }
  if (options.category) {
    conditions.push('category = @category');
    params.category = options.category;
  }
  if (options.minResolutionDate) {
    conditions.push('resolution_date >= @minResolutionDate');
    params.minResolutionDate = options.minResolutionDate;
  }
  if (options.maxResolutionDate) {
    conditions.push('resolution_date <= @maxResolutionDate');
    params.maxResolutionDate = options.maxResolutionDate;
  }
  
  const sql = `SELECT * FROM markets WHERE ${conditions.join(' AND ')} ORDER BY resolution_date DESC`;
  return database.prepare(sql).all(params) as Market[];
}

// ============================================
// Price History Operations
// ============================================

/**
 * Insert price points (batch)
 */
export function insertPriceHistory(points: Omit<PricePoint, 'id'>[]): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO price_history (market_id, timestamp, yes_price, no_price, volume)
    VALUES (@market_id, @timestamp, @yes_price, @no_price, @volume)
  `);
  
  const insertMany = database.transaction((items: Omit<PricePoint, 'id'>[]) => {
    for (const item of items) {
      stmt.run(item);
    }
  });
  
  insertMany(points);
}

/**
 * Get price history for a market
 */
export function getPriceHistory(marketId: string): PricePoint[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM price_history 
    WHERE market_id = ? 
    ORDER BY timestamp ASC
  `).all(marketId) as PricePoint[];
}

/**
 * Get the latest price for a market
 */
export function getLatestPrice(marketId: string): PricePoint | undefined {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM price_history 
    WHERE market_id = ? 
    ORDER BY timestamp DESC 
    LIMIT 1
  `).get(marketId) as PricePoint | undefined;
}

// ============================================
// Backtest Operations
// ============================================

/**
 * Create a new backtest run
 */
export function createBacktestRun(id: string, configSnapshot: object): void {
  const database = getDb();
  database.prepare(`
    INSERT INTO backtest_runs (id, config_snapshot)
    VALUES (?, ?)
  `).run(id, JSON.stringify(configSnapshot));
}

/**
 * Insert a backtest trade
 */
export function insertBacktestTrade(trade: Omit<BacktestTrade, 'id'>): number {
  const database = getDb();
  const result = database.prepare(`
    INSERT INTO backtest_trades (run_id, market_id, side, entry_time, entry_price, exit_time, exit_price, size_usd, pnl, exit_reason)
    VALUES (@run_id, @market_id, @side, @entry_time, @entry_price, @exit_time, @exit_price, @size_usd, @pnl, @exit_reason)
  `).run(trade);
  return result.lastInsertRowid as number;
}

/**
 * Update a backtest trade (e.g., when closing position)
 */
export function updateBacktestTrade(id: number, updates: Partial<BacktestTrade>): void {
  const database = getDb();
  const setClauses: string[] = [];
  const params: Record<string, unknown> = { id };
  
  if (updates.exit_time !== undefined) {
    setClauses.push('exit_time = @exit_time');
    params.exit_time = updates.exit_time;
  }
  if (updates.exit_price !== undefined) {
    setClauses.push('exit_price = @exit_price');
    params.exit_price = updates.exit_price;
  }
  if (updates.pnl !== undefined) {
    setClauses.push('pnl = @pnl');
    params.pnl = updates.pnl;
  }
  if (updates.exit_reason !== undefined) {
    setClauses.push('exit_reason = @exit_reason');
    params.exit_reason = updates.exit_reason;
  }
  
  if (setClauses.length > 0) {
    database.prepare(`UPDATE backtest_trades SET ${setClauses.join(', ')} WHERE id = @id`).run(params);
  }
}

/**
 * Get trades for a backtest run
 */
export function getBacktestTrades(runId: string): BacktestTrade[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM backtest_trades 
    WHERE run_id = ? 
    ORDER BY entry_time ASC
  `).all(runId) as BacktestTrade[];
}

/**
 * Complete a backtest run with summary metrics
 */
export function completeBacktestRun(id: string, metrics: {
  total_trades: number;
  winning_trades: number;
  total_pnl: number;
  max_drawdown: number;
  sharpe_ratio: number;
}): void {
  const database = getDb();
  database.prepare(`
    UPDATE backtest_runs SET
      completed_at = datetime('now'),
      total_trades = @total_trades,
      winning_trades = @winning_trades,
      total_pnl = @total_pnl,
      max_drawdown = @max_drawdown,
      sharpe_ratio = @sharpe_ratio
    WHERE id = @id
  `).run({ id, ...metrics });
}

/**
 * Get all backtest runs
 */
export function getBacktestRuns(): BacktestRun[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM backtest_runs 
    ORDER BY started_at DESC
  `).all() as BacktestRun[];
}

/**
 * Get a specific backtest run
 */
export function getBacktestRun(id: string): BacktestRun | undefined {
  const database = getDb();
  return database.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id) as BacktestRun | undefined;
}

// ============================================
// Utility Operations
// ============================================

/**
 * Get database statistics
 */
export function getDbStats(): {
  marketCount: number;
  pricePointCount: number;
  backtestRunCount: number;
  tradeCount: number;
} {
  const database = getDb();
  const marketCount = (database.prepare('SELECT COUNT(*) as count FROM markets').get() as { count: number }).count;
  const pricePointCount = (database.prepare('SELECT COUNT(*) as count FROM price_history').get() as { count: number }).count;
  const backtestRunCount = (database.prepare('SELECT COUNT(*) as count FROM backtest_runs').get() as { count: number }).count;
  const tradeCount = (database.prepare('SELECT COUNT(*) as count FROM backtest_trades').get() as { count: number }).count;
  
  return { marketCount, pricePointCount, backtestRunCount, tradeCount };
}

