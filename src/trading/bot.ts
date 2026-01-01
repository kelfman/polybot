/**
 * Main Trading Bot
 * Orchestrates scanning, execution, and position management
 * 
 * SAFETY FEATURES:
 * 1. Reconciliation on startup
 * 2. State verification before every action
 * 3. Kill switch for emergency stop
 * 4. Position and exposure limits
 * 5. Comprehensive logging
 */

import { ClobClient, Chain } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { randomBytes } from 'crypto';
import { StateManager, createStateManager } from './state.js';
import { MarketScanner, createScanner, type QualifyingMarket } from './scanner.js';
import { OrderExecutor, createExecutor } from './executor.js';
import { getDb } from '../db/client.js';
import { getConfig } from '../config/index.js';
import { LIVE_TRADING_SCHEMA } from './schema.js';

export interface BotConfig {
  mode: 'live' | 'paper';
  scanIntervalMs: number;     // How often to scan for opportunities
  stateCheckIntervalMs: number; // How often to verify state
  maxTradesPerDay: number;
  enableNotifications: boolean;
}

export interface BotStatus {
  isRunning: boolean;
  runId: string;
  mode: 'live' | 'paper';
  startedAt: string;
  lastScanAt: string | null;
  lastStateCheckAt: string | null;
  tradesPlaced: number;
  tradesClosed: number;
  currentExposure: number;
  openPositions: number;
  balance: number;
  errors: string[];
}

const CLOB_HOST = 'https://clob.polymarket.com';

export class TradingBot {
  private client: ClobClient | null = null;
  private stateManager: StateManager | null = null;
  private scanner: MarketScanner | null = null;
  private executor: OrderExecutor | null = null;
  
  private runId: string;
  private config: BotConfig;
  private isRunning = false;
  private killSwitch = false;
  
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private stateCheckInterval: ReturnType<typeof setInterval> | null = null;
  
  private status: BotStatus;
  private errors: string[] = [];

  constructor(config: Partial<BotConfig> = {}) {
    this.runId = `run_${Date.now()}_${randomBytes(4).toString('hex')}`;
    this.config = {
      mode: config.mode || 'paper',
      scanIntervalMs: config.scanIntervalMs || 60_000, // 1 minute
      stateCheckIntervalMs: config.stateCheckIntervalMs || 30_000, // 30 seconds
      maxTradesPerDay: config.maxTradesPerDay || 10,
      enableNotifications: config.enableNotifications || false,
    };

    this.status = {
      isRunning: false,
      runId: this.runId,
      mode: this.config.mode,
      startedAt: '',
      lastScanAt: null,
      lastStateCheckAt: null,
      tradesPlaced: 0,
      tradesClosed: 0,
      currentExposure: 0,
      openPositions: 0,
      balance: 0,
      errors: [],
    };
  }

  /**
   * Initialize the bot and all components
   */
  async initialize(): Promise<void> {
    console.log('='.repeat(60));
    console.log(`[Bot] Initializing trading bot (${this.config.mode} mode)`);
    console.log(`[Bot] Run ID: ${this.runId}`);
    console.log('='.repeat(60));

    // Initialize database schema
    this.initializeDatabase();

    // Create CLOB client
    this.client = await this.createClobClient();
    
    // Create components
    this.stateManager = createStateManager(this.client);
    this.scanner = createScanner(this.client);
    this.executor = createExecutor(this.client, this.stateManager, this.config.mode === 'paper');

    // Run initial reconciliation
    console.log('\n[Bot] Running initial reconciliation...');
    const reconciliation = await this.stateManager.reconcile();
    
    if (!reconciliation.synced) {
      console.warn('[Bot] Reconciliation found discrepancies - please review');
      for (const d of reconciliation.discrepancies) {
        console.warn(`  - ${d}`);
      }
    }

    // Get initial state
    const state = await this.stateManager.getState(true);
    this.status.balance = state.balance;
    this.status.openPositions = state.positions.length;
    this.status.currentExposure = await this.stateManager.getTotalExposure();

    console.log('\n[Bot] Initialization complete');
    console.log(`  Balance: $${state.balance.toFixed(2)}`);
    console.log(`  Open positions: ${state.positions.length}`);
    console.log(`  Open orders: ${state.openOrders.length}`);
    console.log(`  Current exposure: $${this.status.currentExposure.toFixed(2)}`);
  }

  /**
   * Start the trading bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[Bot] Already running');
      return;
    }

    if (!this.client || !this.stateManager || !this.scanner || !this.executor) {
      await this.initialize();
    }

    console.log('\n[Bot] Starting trading bot...');
    
    this.isRunning = true;
    this.killSwitch = false;
    this.status.isRunning = true;
    this.status.startedAt = new Date().toISOString();

    // Record bot run in database
    const db = getDb();
    db.prepare(`
      INSERT INTO bot_runs (run_id, started_at, mode, status)
      VALUES (?, ?, ?, 'running')
    `).run(this.runId, this.status.startedAt, this.config.mode);

    // Start scan loop
    console.log(`[Bot] Starting scan loop (every ${this.config.scanIntervalMs / 1000}s)`);
    this.scanInterval = setInterval(() => this.runScanCycle(), this.config.scanIntervalMs);
    
    // Start state check loop
    console.log(`[Bot] Starting state check loop (every ${this.config.stateCheckIntervalMs / 1000}s)`);
    this.stateCheckInterval = setInterval(() => this.runStateCheck(), this.config.stateCheckIntervalMs);

    // Run first scan immediately
    await this.runScanCycle();

    console.log('[Bot] Bot is now running\n');
  }

  /**
   * Stop the trading bot
   */
  async stop(reason = 'User requested stop'): Promise<void> {
    console.log(`\n[Bot] Stopping bot: ${reason}`);
    
    this.killSwitch = true;
    this.isRunning = false;
    this.status.isRunning = false;

    // Clear intervals
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.stateCheckInterval) {
      clearInterval(this.stateCheckInterval);
      this.stateCheckInterval = null;
    }

    // Update database
    const db = getDb();
    db.prepare(`
      UPDATE bot_runs 
      SET ended_at = CURRENT_TIMESTAMP, 
          status = 'stopped',
          trades_placed = ?,
          trades_closed = ?,
          total_pnl = ?,
          notes = ?
      WHERE run_id = ?
    `).run(
      this.status.tradesPlaced,
      this.status.tradesClosed,
      0, // TODO: Calculate total PnL
      reason,
      this.runId
    );

    console.log('[Bot] Bot stopped');
  }

  /**
   * Emergency stop - cancels all orders
   */
  async emergencyStop(): Promise<void> {
    console.error('\n[Bot] ⚠️ EMERGENCY STOP TRIGGERED ⚠️');
    
    // Cancel all orders first
    if (this.executor) {
      await this.executor.cancelAllOrders();
    }

    await this.stop('EMERGENCY STOP');
  }

  /**
   * Get current bot status
   */
  getStatus(): BotStatus {
    return { ...this.status, errors: [...this.errors] };
  }

  // ========== Private Methods ==========

  private async createClobClient(): Promise<ClobClient> {
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    const apiKey = process.env.POLYMARKET_API_KEY;
    const apiSecret = process.env.POLYMARKET_API_SECRET;
    const passphrase = process.env.POLYMARKET_API_PASSPHRASE;

    if (!privateKey) {
      throw new Error('POLYMARKET_PRIVATE_KEY not set');
    }
    if (!apiKey || !apiSecret || !passphrase) {
      throw new Error('Polymarket API credentials not set');
    }

    const wallet = new Wallet(privateKey);
    
    const client = new ClobClient(
      CLOB_HOST,
      Chain.POLYGON,
      wallet,
      { key: apiKey, secret: apiSecret, passphrase }
    );

    // Verify connection
    await client.getOk();
    console.log('[Bot] Connected to Polymarket CLOB');

    return client;
  }

  private initializeDatabase(): void {
    const db = getDb();
    db.exec(LIVE_TRADING_SCHEMA);
    console.log('[Bot] Database schema initialized');
  }

  private async runScanCycle(): Promise<void> {
    if (this.killSwitch) return;

    try {
      console.log('\n[Bot] Running market scan...');
      this.status.lastScanAt = new Date().toISOString();

      const scanResult = await this.scanner!.scan();
      
      if (scanResult.qualifyingMarkets.length === 0) {
        console.log('[Bot] No qualifying markets found');
        return;
      }

      console.log(`[Bot] Found ${scanResult.qualifyingMarkets.length} qualifying markets`);

      // Process top opportunities
      for (const market of scanResult.qualifyingMarkets.slice(0, 3)) {
        if (this.killSwitch) break;
        
        await this.processOpportunity(market);
      }

    } catch (error) {
      this.logError(`Scan cycle failed: ${error}`);
    }
  }

  private async processOpportunity(market: QualifyingMarket): Promise<void> {
    console.log(`\n[Bot] Evaluating: ${market.question.slice(0, 60)}...`);
    console.log(`  Price: ${market.currentYesPrice.toFixed(3)} | Days: ${market.daysToResolution.toFixed(1)} | Score: ${market.qualificationScore}`);

    // Additional validation before placing order
    const state = await this.stateManager!.getState();
    const config = getConfig();

    // Check daily trade limit
    if (this.status.tradesPlaced >= this.config.maxTradesPerDay) {
      console.log('[Bot] Daily trade limit reached');
      return;
    }

    // Place order
    const result = await this.executor!.placeBuyOrder({
      marketId: market.conditionId,
      tokenId: market.yesTokenId,
      side: 'YES',
      sizeUsd: config.risk.positionSizeUsd,
      price: market.currentYesPrice,
    });

    if (result.success) {
      console.log(`[Bot] ✅ Order placed: ${result.orderId}`);
      this.status.tradesPlaced++;
      
      // Log trade with full market profile
      this.logTrade(market, result.orderId || null, config.risk.positionSizeUsd);
    } else {
      console.log(`[Bot] ❌ Order failed: ${result.error}`);
    }
  }

  /**
   * Log a trade to the database with full market profile for later analysis
   */
  private logTrade(market: QualifyingMarket, orderId: string | null, sizeUsd: number): void {
    const db = getDb();
    
    db.prepare(`
      INSERT INTO live_trades (
        market_id, token_id, question, side,
        entry_price, size, size_usd, status, entry_time, order_id,
        category, is_objective, days_to_resolution, liquidity, spread, qualification_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      market.conditionId,
      market.yesTokenId,
      market.question,
      'YES',
      market.currentYesPrice,
      sizeUsd / market.currentYesPrice, // size in shares
      sizeUsd,
      'pending',
      new Date().toISOString(),
      orderId,
      market.category,
      market.isObjective ? 1 : 0,
      market.daysToResolution,
      market.liquidity,
      market.spread,
      market.qualificationScore
    );
    
    console.log(`[Bot] Trade logged: ${market.category} | ${market.isObjective ? 'Objective' : 'Subjective'} | Liq: $${market.liquidity.toFixed(0)} | Score: ${market.qualificationScore}`);
  }

  private async runStateCheck(): Promise<void> {
    if (this.killSwitch) return;

    try {
      this.status.lastStateCheckAt = new Date().toISOString();
      
      const state = await this.stateManager!.getState(true);
      
      this.status.balance = state.balance;
      this.status.openPositions = state.positions.length;
      this.status.currentExposure = await this.stateManager!.getTotalExposure();

      // Check for positions that need to be closed (near resolution)
      for (const position of state.positions) {
        // TODO: Check if market has resolved and close position
      }

      // Take periodic state snapshot
      const db = getDb();
      db.prepare(`
        INSERT INTO state_snapshots (run_id, timestamp, balance, total_exposure, open_positions, open_orders, state_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.runId,
        this.status.lastStateCheckAt,
        state.balance,
        this.status.currentExposure,
        state.positions.length,
        state.openOrders.length,
        JSON.stringify(state)
      );

    } catch (error) {
      this.logError(`State check failed: ${error}`);
    }
  }

  private logError(message: string): void {
    console.error(`[Bot] ERROR: ${message}`);
    this.errors.push(`${new Date().toISOString()}: ${message}`);
    
    // Keep only last 100 errors
    if (this.errors.length > 100) {
      this.errors = this.errors.slice(-100);
    }
  }
}

/**
 * Create and run the trading bot
 */
export async function runBot(mode: 'live' | 'paper' = 'paper'): Promise<TradingBot> {
  const bot = new TradingBot({ mode });
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Bot] Received SIGINT, stopping...');
    await bot.stop('SIGINT received');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Bot] Received SIGTERM, stopping...');
    await bot.stop('SIGTERM received');
    process.exit(0);
  });

  await bot.start();
  
  return bot;
}

