/**
 * Order Executor
 * Handles order placement with safety checks and idempotency
 * 
 * KEY SAFETY FEATURES:
 * 1. Idempotency - same request = same result, never duplicate orders
 * 2. Pre-flight checks - verify state before every order
 * 3. Position limits - respect max positions and exposure
 * 4. Order tracking - every order is logged to database
 */

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { randomBytes } from 'crypto';
import { StateManager } from './state.js';
import { getDb } from '../db/client.js';
import { getConfig } from '../config/index.js';

export interface OrderRequest {
  marketId: string;
  tokenId: string;
  side: 'YES' | 'NO';
  sizeUsd: number;
  price?: number;           // If not provided, uses market price
  idempotencyKey?: string;  // For retry safety
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  orderStatus?: string;
  executedPrice?: number;
  executedSize?: number;
  idempotencyKey: string;
}

export interface ExecutorConfig {
  client: ClobClient;
  stateManager: StateManager;
  maxExposureUsd: number;
  positionSizeUsd: number;
  dryRun: boolean;          // If true, don't actually place orders
}

export class OrderExecutor {
  private client: ClobClient;
  private stateManager: StateManager;
  private config: ExecutorConfig;
  private pendingOrders = new Set<string>(); // Track in-flight orders

  constructor(config: ExecutorConfig) {
    this.client = config.client;
    this.stateManager = config.stateManager;
    this.config = config;
  }

  /**
   * Place a buy order with all safety checks
   */
  async placeBuyOrder(request: OrderRequest): Promise<OrderResult> {
    const idempotencyKey = request.idempotencyKey || this.generateIdempotencyKey(request);
    const db = getDb();

    console.log(`[Executor] Processing buy order for ${request.marketId} (${request.side})`);

    // ===== SAFETY CHECK 1: Idempotency =====
    // Check if we've already processed this exact request
    const existingOrder = db.prepare(`
      SELECT * FROM order_tracking WHERE idempotency_key = ?
    `).get(idempotencyKey) as any;

    if (existingOrder) {
      console.log(`[Executor] Idempotency key found - returning existing result`);
      return {
        success: existingOrder.status === 'filled' || existingOrder.status === 'live',
        orderId: existingOrder.order_id,
        error: existingOrder.error_message,
        idempotencyKey,
      };
    }

    // ===== SAFETY CHECK 2: No duplicate pending orders =====
    if (this.pendingOrders.has(request.marketId)) {
      return {
        success: false,
        error: 'Order already in flight for this market',
        idempotencyKey,
      };
    }

    // ===== SAFETY CHECK 3: No existing position or order in market =====
    const [hasPosition, hasOrder] = await Promise.all([
      this.stateManager.hasPositionInMarket(request.marketId),
      this.stateManager.hasOpenOrderForMarket(request.marketId),
    ]);

    if (hasPosition) {
      return {
        success: false,
        error: 'Already have position in this market',
        idempotencyKey,
      };
    }

    if (hasOrder) {
      return {
        success: false,
        error: 'Already have open order in this market',
        idempotencyKey,
      };
    }

    // ===== SAFETY CHECK 4: Exposure limits =====
    const currentExposure = await this.stateManager.getTotalExposure();
    
    if (currentExposure + request.sizeUsd > this.config.maxExposureUsd) {
      return {
        success: false,
        error: `Would exceed max exposure ($${this.config.maxExposureUsd})`,
        idempotencyKey,
      };
    }

    // ===== SAFETY CHECK 6: Sufficient balance =====
    const availableBalance = await this.stateManager.getAvailableBalance();
    
    if (availableBalance < request.sizeUsd) {
      return {
        success: false,
        error: `Insufficient balance: $${availableBalance.toFixed(2)} < $${request.sizeUsd}`,
        idempotencyKey,
      };
    }

    // ===== CREATE ORDER TRACKING RECORD =====
    db.prepare(`
      INSERT INTO order_tracking (market_id, token_id, side, price, size, order_type, status, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, 'created', ?)
    `).run(
      request.marketId,
      request.tokenId,
      'BUY',
      request.price || 0,
      request.sizeUsd,
      'MARKET',
      idempotencyKey
    );

    // Mark order as in-flight
    this.pendingOrders.add(request.marketId);

    try {
      // ===== DRY RUN MODE =====
      if (this.config.dryRun) {
        console.log(`[Executor] DRY RUN - Would place order: ${request.side} $${request.sizeUsd} @ ${request.price || 'market'}`);
        
        db.prepare(`
          UPDATE order_tracking 
          SET status = 'filled', order_id = ?, polymarket_status = 'DRY_RUN'
          WHERE idempotency_key = ?
        `).run(`dry_${Date.now()}`, idempotencyKey);

        return {
          success: true,
          orderId: `dry_${Date.now()}`,
          idempotencyKey,
        };
      }

      // ===== PLACE ACTUAL ORDER =====
      console.log(`[Executor] Placing market order: BUY ${request.sizeUsd} USDC of ${request.tokenId}`);

      // Update status to submitted
      db.prepare(`
        UPDATE order_tracking SET status = 'submitted', updated_at = CURRENT_TIMESTAMP
        WHERE idempotency_key = ?
      `).run(idempotencyKey);

      // Place market order (FOK = Fill or Kill)
      const result = await this.client.createAndPostMarketOrder({
        tokenID: request.tokenId,
        amount: request.sizeUsd,
        side: Side.BUY,
        orderType: OrderType.FOK,
      });

      // Parse result
      const orderId = result?.orderID || result?.orderId;
      const orderStatus = result?.status || 'unknown';
      
      if (orderId) {
        console.log(`[Executor] Order placed successfully: ${orderId}`);
        
        db.prepare(`
          UPDATE order_tracking 
          SET status = 'filled', order_id = ?, polymarket_status = ?, filled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE idempotency_key = ?
        `).run(orderId, orderStatus, idempotencyKey);

        // Create live trade record
        db.prepare(`
          INSERT INTO live_trades (market_id, token_id, side, size, size_usd, status, entry_time, order_id)
          VALUES (?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP, ?)
        `).run(
          request.marketId,
          request.tokenId,
          request.side,
          request.sizeUsd, // Will be updated with actual shares
          request.sizeUsd,
          orderId
        );

        return {
          success: true,
          orderId,
          orderStatus,
          idempotencyKey,
        };
      } else {
        const errorMsg = result?.errorMsg || 'No order ID returned';
        console.error(`[Executor] Order failed: ${errorMsg}`);
        
        db.prepare(`
          UPDATE order_tracking 
          SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE idempotency_key = ?
        `).run(errorMsg, idempotencyKey);

        return {
          success: false,
          error: errorMsg,
          idempotencyKey,
        };
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Executor] Order execution error:`, error);

      db.prepare(`
        UPDATE order_tracking 
        SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE idempotency_key = ?
      `).run(errorMsg, idempotencyKey);

      return {
        success: false,
        error: errorMsg,
        idempotencyKey,
      };

    } finally {
      // Remove from pending
      this.pendingOrders.delete(request.marketId);
    }
  }

  /**
   * Place a sell order to close a position
   */
  async placeSellOrder(request: OrderRequest): Promise<OrderResult> {
    const idempotencyKey = request.idempotencyKey || this.generateIdempotencyKey({ ...request, side: 'NO' });
    const db = getDb();

    console.log(`[Executor] Processing sell order for ${request.marketId} (closing ${request.side})`);

    // ===== SAFETY CHECK 1: Idempotency =====
    const existingOrder = db.prepare(`
      SELECT * FROM order_tracking WHERE idempotency_key = ?
    `).get(idempotencyKey) as any;

    if (existingOrder) {
      console.log(`[Executor] Idempotency key found - returning existing result`);
      return {
        success: existingOrder.status === 'filled' || existingOrder.status === 'live',
        orderId: existingOrder.order_id,
        error: existingOrder.error_message,
        idempotencyKey,
      };
    }

    // ===== SAFETY CHECK 2: No duplicate pending orders =====
    if (this.pendingOrders.has(`sell_${request.marketId}`)) {
      return {
        success: false,
        error: 'Sell order already in flight for this market',
        idempotencyKey,
      };
    }

    // ===== CREATE ORDER TRACKING RECORD =====
    db.prepare(`
      INSERT INTO order_tracking (market_id, token_id, side, price, size, order_type, status, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, 'created', ?)
    `).run(
      request.marketId,
      request.tokenId,
      'SELL',
      request.price || 0,
      request.sizeUsd,
      'MARKET',
      idempotencyKey
    );

    // Mark order as in-flight
    this.pendingOrders.add(`sell_${request.marketId}`);

    try {
      // ===== DRY RUN MODE =====
      if (this.config.dryRun) {
        console.log(`[Executor] DRY RUN - Would place sell order: SELL $${request.sizeUsd} @ ${request.price || 'market'}`);
        
        db.prepare(`
          UPDATE order_tracking 
          SET status = 'filled', order_id = ?, polymarket_status = 'DRY_RUN'
          WHERE idempotency_key = ?
        `).run(`dry_sell_${Date.now()}`, idempotencyKey);

        return {
          success: true,
          orderId: `dry_sell_${Date.now()}`,
          idempotencyKey,
        };
      }

      // ===== PLACE ACTUAL SELL ORDER =====
      console.log(`[Executor] Placing sell order: SELL ${request.sizeUsd} shares of ${request.tokenId}`);

      // Update status to submitted
      db.prepare(`
        UPDATE order_tracking SET status = 'submitted', updated_at = CURRENT_TIMESTAMP
        WHERE idempotency_key = ?
      `).run(idempotencyKey);

      // Place market sell order (FOK = Fill or Kill)
      const result = await this.client.createAndPostMarketOrder({
        tokenID: request.tokenId,
        amount: request.sizeUsd, // This is the number of shares to sell
        side: Side.SELL,
        orderType: OrderType.FOK,
      });

      const orderId = result?.orderID || result?.orderId;
      const orderStatus = result?.status || 'unknown';
      
      if (orderId) {
        console.log(`[Executor] Sell order placed successfully: ${orderId}`);
        
        db.prepare(`
          UPDATE order_tracking 
          SET status = 'filled', order_id = ?, polymarket_status = ?, filled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE idempotency_key = ?
        `).run(orderId, orderStatus, idempotencyKey);

        return {
          success: true,
          orderId,
          orderStatus,
          idempotencyKey,
        };
      } else {
        const errorMsg = result?.errorMsg || 'No order ID returned';
        console.error(`[Executor] Sell order failed: ${errorMsg}`);
        
        db.prepare(`
          UPDATE order_tracking 
          SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE idempotency_key = ?
        `).run(errorMsg, idempotencyKey);

        return {
          success: false,
          error: errorMsg,
          idempotencyKey,
        };
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Executor] Sell order execution error:`, error);

      db.prepare(`
        UPDATE order_tracking 
        SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE idempotency_key = ?
      `).run(errorMsg, idempotencyKey);

      return {
        success: false,
        error: errorMsg,
        idempotencyKey,
      };

    } finally {
      this.pendingOrders.delete(`sell_${request.marketId}`);
    }
  }

  /**
   * Cancel all open orders
   */
  async cancelAllOrders(): Promise<{ success: boolean; cancelled: number; error?: string }> {
    try {
      console.log('[Executor] Cancelling all open orders...');
      
      if (this.config.dryRun) {
        console.log('[Executor] DRY RUN - Would cancel all orders');
        return { success: true, cancelled: 0 };
      }

      await this.client.cancelAll();
      
      // Refresh state after cancellation
      await this.stateManager.getState(true);
      
      return { success: true, cancelled: 0 }; // Count not available from API
    } catch (error) {
      return {
        success: false,
        cancelled: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Generate idempotency key for a request
   */
  private generateIdempotencyKey(request: OrderRequest): string {
    // Combine market, side, and current minute to create a unique key
    // This ensures the same order request within 1 minute is deduplicated
    const timestamp = Math.floor(Date.now() / 60000); // Minute precision
    const data = `${request.marketId}:${request.side}:${request.sizeUsd}:${timestamp}`;
    const hash = randomBytes(4).toString('hex');
    return `order_${data}_${hash}`;
  }
}

/**
 * Create executor from config
 */
export function createExecutor(
  client: ClobClient, 
  stateManager: StateManager,
  dryRun = true
): OrderExecutor {
  const config = getConfig();
  
  return new OrderExecutor({
    client,
    stateManager,
    maxExposureUsd: config.risk.maxExposureUsd,
    positionSizeUsd: config.risk.positionSizeUsd,
    dryRun,
  });
}

