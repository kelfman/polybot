/**
 * Backtest metrics calculation
 * Computes PnL, win rate, max drawdown, Sharpe ratio, etc.
 */

import type { BacktestTrade, Market } from '../db/schema.js';

/**
 * Performance metrics for a category
 */
export interface CategoryMetrics {
  category: string;
  tradeCount: number;
  winningTrades: number;
  winRate: number;
  totalPnL: number;
  averagePnL: number;
}

/**
 * Summary metrics for a backtest run
 */
export interface BacktestMetrics {
  // Trade counts
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  
  // PnL metrics
  totalPnL: number;
  averagePnL: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  
  // Risk metrics
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  
  // Time metrics
  averageHoldingDays: number;
  
  // By exit reason
  exitsByReason: {
    target: number;
    resolution: number;
    stop_loss: number;
  };
  
  // By category (optional, populated when market data is provided)
  byCategory?: CategoryMetrics[];
}

/**
 * Equity curve point
 */
export interface EquityPoint {
  timestamp: string;
  equity: number;
  drawdown: number;
  tradeId?: number;
}

/**
 * Calculate metrics from completed trades
 * @param trades List of backtest trades
 * @param initialCapital Starting capital for equity calculations
 * @param marketLookup Optional function to get market data for category tracking
 */
export function calculateMetrics(
  trades: BacktestTrade[],
  initialCapital: number = 1000,
  marketLookup?: (marketId: string) => Market | undefined
): BacktestMetrics {
  // Filter to completed trades only
  const completedTrades = trades.filter(t => t.pnl !== null);
  
  if (completedTrades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnL: 0,
      averagePnL: 0,
      averageWin: 0,
      averageLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      sharpeRatio: 0,
      averageHoldingDays: 0,
      exitsByReason: { target: 0, resolution: 0, stop_loss: 0 },
      byCategory: [],
    };
  }

  // Basic counts
  const totalTrades = completedTrades.length;
  const winningTrades = completedTrades.filter(t => t.pnl! > 0).length;
  const losingTrades = completedTrades.filter(t => t.pnl! < 0).length;
  const winRate = winningTrades / totalTrades;

  // PnL calculations
  const pnls = completedTrades.map(t => t.pnl!);
  const totalPnL = pnls.reduce((sum, pnl) => sum + pnl, 0);
  const averagePnL = totalPnL / totalTrades;

  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const averageWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const averageLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;

  // Profit factor
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Calculate equity curve and drawdown
  const equityCurve = calculateEquityCurve(completedTrades, initialCapital);
  const maxDrawdown = Math.max(...equityCurve.map(p => p.drawdown), 0);
  const maxDrawdownPercent = initialCapital > 0 ? (maxDrawdown / initialCapital) * 100 : 0;

  // Sharpe ratio (simplified: daily returns approximation)
  const sharpeRatio = calculateSharpeRatio(completedTrades, initialCapital);

  // Average holding time
  const holdingDays = completedTrades
    .filter(t => t.exit_time)
    .map(t => {
      const entry = new Date(t.entry_time);
      const exit = new Date(t.exit_time!);
      return (exit.getTime() - entry.getTime()) / (1000 * 60 * 60 * 24);
    });
  const averageHoldingDays = holdingDays.length > 0 
    ? holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length 
    : 0;

  // Exit reasons
  const exitsByReason = {
    target: completedTrades.filter(t => t.exit_reason === 'target').length,
    resolution: completedTrades.filter(t => t.exit_reason === 'resolution').length,
    stop_loss: completedTrades.filter(t => t.exit_reason === 'stop_loss').length,
  };

  // Calculate category metrics if market lookup is provided
  let byCategory: CategoryMetrics[] | undefined;
  if (marketLookup) {
    byCategory = calculateCategoryMetrics(completedTrades, marketLookup);
  }

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    totalPnL,
    averagePnL,
    averageWin,
    averageLoss,
    profitFactor,
    maxDrawdown,
    maxDrawdownPercent,
    sharpeRatio,
    averageHoldingDays,
    exitsByReason,
    byCategory,
  };
}

/**
 * Calculate performance metrics by category
 */
export function calculateCategoryMetrics(
  trades: BacktestTrade[],
  marketLookup: (marketId: string) => Market | undefined
): CategoryMetrics[] {
  // Group trades by category
  const tradesByCategory = new Map<string, BacktestTrade[]>();
  
  for (const trade of trades) {
    const market = marketLookup(trade.market_id);
    const category = market?.category || 'unknown';
    
    const existing = tradesByCategory.get(category) || [];
    existing.push(trade);
    tradesByCategory.set(category, existing);
  }
  
  // Calculate metrics for each category
  const categoryMetrics: CategoryMetrics[] = [];
  
  for (const [category, categoryTrades] of tradesByCategory) {
    const tradeCount = categoryTrades.length;
    const winningTrades = categoryTrades.filter(t => t.pnl! > 0).length;
    const winRate = tradeCount > 0 ? winningTrades / tradeCount : 0;
    const totalPnL = categoryTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const averagePnL = tradeCount > 0 ? totalPnL / tradeCount : 0;
    
    categoryMetrics.push({
      category,
      tradeCount,
      winningTrades,
      winRate,
      totalPnL,
      averagePnL,
    });
  }
  
  // Sort by trade count descending
  categoryMetrics.sort((a, b) => b.tradeCount - a.tradeCount);
  
  return categoryMetrics;
}

/**
 * Calculate equity curve from trades
 */
export function calculateEquityCurve(
  trades: BacktestTrade[],
  initialCapital: number = 1000
): EquityPoint[] {
  // Sort trades by exit time
  const sortedTrades = [...trades]
    .filter(t => t.exit_time && t.pnl !== null)
    .sort((a, b) => a.exit_time!.localeCompare(b.exit_time!));

  const curve: EquityPoint[] = [{
    timestamp: sortedTrades[0]?.entry_time || new Date().toISOString(),
    equity: initialCapital,
    drawdown: 0,
  }];

  let equity = initialCapital;
  let peak = initialCapital;

  for (const trade of sortedTrades) {
    equity += trade.pnl!;
    peak = Math.max(peak, equity);
    const drawdown = peak - equity;

    curve.push({
      timestamp: trade.exit_time!,
      equity,
      drawdown,
      tradeId: trade.id,
    });
  }

  return curve;
}

/**
 * Calculate Sharpe ratio
 * Simplified version assuming daily returns
 */
function calculateSharpeRatio(
  trades: BacktestTrade[],
  initialCapital: number,
  riskFreeRate: number = 0.04 // 4% annual risk-free rate
): number {
  if (trades.length < 2) return 0;

  // Calculate returns for each trade
  const returns = trades
    .filter(t => t.pnl !== null)
    .map(t => t.pnl! / (t.size_usd || initialCapital));

  if (returns.length < 2) return 0;

  // Mean return
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

  // Standard deviation
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualize (assuming ~20 trades per month on average, 240 per year)
  const annualizedReturn = meanReturn * 240;
  const annualizedStdDev = stdDev * Math.sqrt(240);

  return (annualizedReturn - riskFreeRate) / annualizedStdDev;
}

/**
 * Format metrics as a readable string
 */
export function formatMetrics(metrics: BacktestMetrics): string {
  let output = `
=== Backtest Results ===

Trades:
  Total: ${metrics.totalTrades}
  Winners: ${metrics.winningTrades} (${(metrics.winRate * 100).toFixed(1)}%)
  Losers: ${metrics.losingTrades}

PnL:
  Total: $${metrics.totalPnL.toFixed(2)}
  Average: $${metrics.averagePnL.toFixed(2)}
  Avg Win: $${metrics.averageWin.toFixed(2)}
  Avg Loss: $${metrics.averageLoss.toFixed(2)}
  Profit Factor: ${metrics.profitFactor.toFixed(2)}

Risk:
  Max Drawdown: $${metrics.maxDrawdown.toFixed(2)} (${metrics.maxDrawdownPercent.toFixed(1)}%)
  Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)}

Timing:
  Avg Holding: ${metrics.averageHoldingDays.toFixed(1)} days

Exit Reasons:
  Target Hit: ${metrics.exitsByReason.target}
  Resolution: ${metrics.exitsByReason.resolution}
  Stop Loss: ${metrics.exitsByReason.stop_loss}`;

  // Add category breakdown if available
  if (metrics.byCategory && metrics.byCategory.length > 0) {
    output += `\n\nPerformance by Category:`;
    for (const cat of metrics.byCategory) {
      const pnlSign = cat.totalPnL >= 0 ? '+' : '';
      output += `\n  ${cat.category}: ${cat.tradeCount} trades, ${(cat.winRate * 100).toFixed(0)}% win, ${pnlSign}$${cat.totalPnL.toFixed(2)}`;
    }
  }

  return output.trim();
}

