/**
 * Robust State Manager for Polymarket Trading
 * 
 * DESIGN PRINCIPLES:
 * 1. Truth lives on Polymarket - local state is just a cache
 * 2. Always verify before acting
 * 3. Reconcile on every major operation
 * 4. Never trust stale data
 * 
 * DATA SOURCES:
 * - CLOB API: Orders, trading operations
 * - Data API: Positions, portfolio value (more accurate)
 */

import { ClobClient, type OpenOrder, type Trade, AssetType } from '@polymarket/clob-client';
import { getDb } from '../db/client.js';

const DATA_API_URL = 'https://data-api.polymarket.com';

export interface Position {
  marketId: string;       // Condition ID
  tokenId: string;        // Asset ID (YES or NO token)
  side: 'YES' | 'NO';
  size: number;           // Number of shares
  avgEntryPrice: number;
  currentValue: number;
  currentPrice: number;   // Current price of the position (for auto-close)
  unrealizedPnl: number;
  entryTime: string;
  question?: string;      // Market question (for logging)
}

export interface AccountState {
  balance: number;              // USDC balance
  allowance: number;            // Trading allowance
  positions: Position[];        // Current positions
  openOrders: OpenOrder[];      // Pending orders
  lastSyncTime: string;         // When state was last verified
  syncSource: 'api' | 'cache';  // Where data came from
}

export interface StateManagerConfig {
  client: ClobClient;
  proxyAddress: string;
  staleThresholdMs: number;     // How old before we force refresh (default 30s)
}

/**
 * State Manager - handles all account state with built-in verification
 */
export class StateManager {
  private client: ClobClient;
  private proxyAddress: string;
  private staleThresholdMs: number;
  private cachedState: AccountState | null = null;
  private lastError: Error | null = null;

  constructor(config: StateManagerConfig) {
    this.client = config.client;
    this.proxyAddress = config.proxyAddress;
    this.staleThresholdMs = config.staleThresholdMs || 30_000;
  }

  /**
   * Get current account state - always fresh from API
   * This is the PRIMARY method for getting state
   */
  async getState(forceRefresh = false): Promise<AccountState> {
    const now = new Date().toISOString();
    
    // Check if cached state is still valid
    if (!forceRefresh && this.cachedState) {
      const lastSync = new Date(this.cachedState.lastSyncTime).getTime();
      const age = Date.now() - lastSync;
      
      if (age < this.staleThresholdMs) {
        return { ...this.cachedState, syncSource: 'cache' };
      }
    }

    // Fetch fresh state from Polymarket
    console.log('[StateManager] Fetching fresh state from Polymarket...');
    
    try {
      // Parallel fetch for efficiency
      const [balanceResult, openOrdersResult, positions] = await Promise.all([
        this.fetchBalance(),
        this.fetchOpenOrders(),
        this.fetchPositionsFromDataAPI(), // Use Data API for accurate positions
      ]);

      const state: AccountState = {
        balance: balanceResult.balance,
        allowance: balanceResult.allowance,
        positions,
        openOrders: openOrdersResult,
        lastSyncTime: now,
        syncSource: 'api',
      };

      this.cachedState = state;
      this.lastError = null;

      console.log(`[StateManager] State synced: $${state.balance.toFixed(2)} balance, ${state.positions.length} positions, ${state.openOrders.length} open orders`);
      
      return state;

    } catch (error) {
      this.lastError = error as Error;
      console.error('[StateManager] Failed to fetch state:', error);
      
      // Return stale cache if available, but mark it
      if (this.cachedState) {
        console.warn('[StateManager] Returning stale cached state');
        return { ...this.cachedState, syncSource: 'cache' };
      }
      
      throw new Error(`Failed to fetch account state: ${error}`);
    }
  }

  /**
   * Verify a specific order exists and matches expected state
   */
  async verifyOrder(orderId: string): Promise<OpenOrder | null> {
    try {
      const order = await this.client.getOrder(orderId);
      return order;
    } catch (error) {
      // Order not found or error
      console.warn(`[StateManager] Order ${orderId} not found:`, error);
      return null;
    }
  }

  /**
   * Verify we have a position in a market before taking action
   */
  async verifyPosition(marketId: string): Promise<Position | null> {
    const state = await this.getState(true); // Force refresh
    return state.positions.find(p => p.marketId === marketId) || null;
  }

  /**
   * Check if we already have an open order for a market
   * CRITICAL: Prevents duplicate orders
   */
  async hasOpenOrderForMarket(marketId: string): Promise<boolean> {
    const state = await this.getState(true); // Force refresh
    return state.openOrders.some(o => o.market === marketId);
  }

  /**
   * Check if we already have a position in a market
   */
  async hasPositionInMarket(marketId: string): Promise<boolean> {
    const state = await this.getState(true); // Force refresh
    return state.positions.some(p => p.marketId === marketId);
  }

  /**
   * Get available balance for trading
   */
  async getAvailableBalance(): Promise<number> {
    const state = await this.getState();
    
    // Calculate exposure from open orders
    const openOrderExposure = state.openOrders.reduce((sum, order) => {
      const size = parseFloat(order.original_size) - parseFloat(order.size_matched);
      const price = parseFloat(order.price);
      return sum + (size * price);
    }, 0);

    return Math.max(0, state.balance - openOrderExposure);
  }

  /**
   * Get total exposure (positions + open orders)
   */
  async getTotalExposure(): Promise<number> {
    const state = await this.getState();
    
    const positionExposure = state.positions.reduce((sum, pos) => {
      return sum + pos.currentValue;
    }, 0);

    const orderExposure = state.openOrders.reduce((sum, order) => {
      const size = parseFloat(order.original_size) - parseFloat(order.size_matched);
      const price = parseFloat(order.price);
      return sum + (size * price);
    }, 0);

    return positionExposure + orderExposure;
  }

  /**
   * Reconcile local database with actual Polymarket state
   * Call this on startup and periodically
   */
  async reconcile(): Promise<{
    synced: boolean;
    discrepancies: string[];
  }> {
    console.log('[StateManager] Running full reconciliation...');
    
    const discrepancies: string[] = [];
    const state = await this.getState(true);

    // Get local trade records from database
    const db = getDb();
    const localTrades = db.prepare(`
      SELECT * FROM live_trades 
      WHERE status IN ('open', 'pending')
    `).all() as any[];

    // Check each local trade against actual positions
    for (const localTrade of localTrades) {
      const hasPosition = state.positions.some(p => p.marketId === localTrade.market_id);
      const hasOrder = state.openOrders.some(o => o.market === localTrade.market_id);

      if (!hasPosition && !hasOrder && localTrade.status === 'open') {
        discrepancies.push(`Local trade ${localTrade.id} shows 'open' but no position/order on Polymarket`);
        
        // Update local record to match reality
        db.prepare(`
          UPDATE live_trades SET status = 'unknown', notes = 'Reconciliation: position not found on Polymarket'
          WHERE id = ?
        `).run(localTrade.id);
      }
    }

    // Check for positions on Polymarket not in local database
    for (const position of state.positions) {
      const localRecord = localTrades.find(t => t.market_id === position.marketId);
      if (!localRecord) {
        discrepancies.push(`Position in ${position.marketId} exists on Polymarket but not in local database`);
        
        // Create local record to match reality
        db.prepare(`
          INSERT INTO live_trades (market_id, side, entry_price, size, status, entry_time, notes)
          VALUES (?, ?, ?, ?, 'open', ?, 'Reconciliation: found on Polymarket')
        `).run(
          position.marketId,
          position.side,
          position.avgEntryPrice,
          position.size,
          position.entryTime
        );
      }
    }

    const synced = discrepancies.length === 0;
    
    if (synced) {
      console.log('[StateManager] Reconciliation complete - no discrepancies');
    } else {
      console.warn(`[StateManager] Reconciliation found ${discrepancies.length} discrepancies:`);
      discrepancies.forEach(d => console.warn(`  - ${d}`));
    }

    return { synced, discrepancies };
  }

  /**
   * Get last error if any
   */
  getLastError(): Error | null {
    return this.lastError;
  }

  // ========== Private Methods ==========

  private async fetchBalance(): Promise<{ balance: number; allowance: number }> {
    // Fetch both CLOB balance and on-chain balance
    let clobBalance = 0;
    let onChainBalance = 0;
    
    // Try CLOB API first
    try {
      const result = await this.client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });
      clobBalance = parseFloat(result.balance) / 1e6;
    } catch (error) {
      console.warn('[StateManager] Failed to fetch CLOB balance:', error);
    }
    
    // Also check on-chain USDC in proxy wallet
    onChainBalance = await this.fetchOnChainUSDC();
    
    // Use whichever is higher (CLOB API has a known bug where it reports 0)
    // If on-chain has funds and approvals are set, the funds ARE tradeable
    const effectiveBalance = Math.max(clobBalance, onChainBalance);
    
    if (clobBalance === 0 && onChainBalance > 0) {
      console.log(`[StateManager] CLOB reports $0 but on-chain has $${onChainBalance.toFixed(2)} - using on-chain balance`);
    }
    
    return {
      balance: effectiveBalance,
      allowance: effectiveBalance,
    };
  }

  /**
   * Fetch on-chain USDC balance from proxy wallet (not deposited to CLOB)
   */
  private async fetchOnChainUSDC(): Promise<number> {
    try {
      const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC on Polygon
      const data = '0x70a08231' + this.proxyAddress.slice(2).toLowerCase().padStart(64, '0');
      
      const response = await fetch('https://polygon-rpc.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to: USDC_CONTRACT, data }, 'latest'],
          id: 1
        })
      });
      
      const result = await response.json();
      if (result.result) {
        const balanceWei = BigInt(result.result);
        return Number(balanceWei) / 1e6;
      }
      return 0;
    } catch (error) {
      console.warn('[StateManager] Failed to fetch on-chain USDC:', error);
      return 0;
    }
  }

  private async fetchOpenOrders(): Promise<OpenOrder[]> {
    try {
      const result = await this.client.getOpenOrders();
      return result || [];
    } catch (error) {
      console.warn('[StateManager] Failed to fetch open orders:', error);
      return [];
    }
  }

  private async fetchRecentTrades(): Promise<Trade[]> {
    try {
      const afterTs = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
      const trades = await this.client.getTrades({ after: String(afterTs) });
      return trades || [];
    } catch (error) {
      console.warn('[StateManager] Failed to fetch trades:', error);
      return [];
    }
  }

  /**
   * Fetch positions from the Data API (more accurate than calculating from trades)
   */
  private async fetchPositionsFromDataAPI(): Promise<Position[]> {
    try {
      const url = `${DATA_API_URL}/positions?user=${this.proxyAddress}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        console.warn('[StateManager] Data API positions request failed:', response.status);
        return [];
      }

      const data = await response.json();
      
      return (data || []).map((pos: any) => ({
        marketId: pos.conditionId,
        tokenId: pos.asset,
        side: (pos.outcome || 'YES').toUpperCase() as 'YES' | 'NO',
        size: pos.size || 0,
        avgEntryPrice: pos.avgPrice || 0,
        currentValue: pos.currentValue || (pos.size * pos.curPrice) || 0,
        currentPrice: pos.curPrice || 0,  // Current market price
        unrealizedPnl: pos.cashPnl || 0,
        entryTime: new Date().toISOString(), // Data API doesn't provide entry time
        question: pos.title || undefined,    // Market question if available
      }));
    } catch (error) {
      console.warn('[StateManager] Failed to fetch positions from Data API:', error);
      return [];
    }
  }

  /**
   * Calculate positions from trades (fallback if Data API fails)
   */
  private async calculatePositionsFromTrades(trades: Trade[]): Promise<Position[]> {
    const positionMap = new Map<string, {
      marketId: string;
      tokenId: string;
      side: 'YES' | 'NO';
      totalSize: number;
      totalCost: number;
      firstTradeTime: string;
    }>();

    for (const trade of trades) {
      if (trade.status !== 'MATCHED' && trade.status !== 'MINED' && trade.status !== 'CONFIRMED') continue;

      const key = `${trade.market}:${trade.asset_id}`;
      const existing = positionMap.get(key);
      
      const size = parseFloat(trade.size);
      const price = parseFloat(trade.price);
      const cost = size * price;
      const isBuy = trade.side === 'BUY';
      const adjustedSize = isBuy ? size : -size;
      const adjustedCost = isBuy ? cost : -cost;

      if (existing) {
        existing.totalSize += adjustedSize;
        existing.totalCost += adjustedCost;
      } else {
        positionMap.set(key, {
          marketId: trade.market,
          tokenId: trade.asset_id,
          side: trade.outcome as 'YES' | 'NO',
          totalSize: adjustedSize,
          totalCost: adjustedCost,
          firstTradeTime: trade.match_time,
        });
      }
    }

    const positions: Position[] = [];
    
    for (const [, pos] of positionMap) {
      if (Math.abs(pos.totalSize) < 0.001) continue;
      
      const avgEntryPrice = Math.abs(pos.totalCost / pos.totalSize);
      let currentPrice = avgEntryPrice;
      
      try {
        const priceResult = await this.client.getLastTradePrice(pos.tokenId);
        if (priceResult?.price) {
          currentPrice = parseFloat(priceResult.price);
        }
      } catch {}

      const currentValue = pos.totalSize * currentPrice;
      const unrealizedPnl = currentValue - pos.totalCost;

      positions.push({
        marketId: pos.marketId,
        tokenId: pos.tokenId,
        side: pos.side,
        size: pos.totalSize,
        avgEntryPrice,
        currentValue,
        currentPrice,  // Current market price
        unrealizedPnl,
        entryTime: pos.firstTradeTime,
        question: undefined,  // Not available from trades
      });
    }

    return positions;
  }
}

/**
 * Create state manager from environment
 */
export function createStateManager(client: ClobClient): StateManager {
  const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS || '';
  
  if (!proxyAddress) {
    throw new Error('POLYMARKET_PROXY_ADDRESS not set in environment');
  }

  return new StateManager({
    client,
    proxyAddress,
    staleThresholdMs: 30_000, // 30 seconds
  });
}

