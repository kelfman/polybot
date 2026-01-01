/**
 * Trade Analysis Tool
 * Analyze historical trades to refine strategy
 */

import 'dotenv/config';
import { getDb } from '../db/client.js';
import { TRADE_QUERIES, LIVE_TRADING_SCHEMA } from './schema.js';

function printTable(rows: any[], title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
  
  if (rows.length === 0) {
    console.log('  No data available');
    return;
  }
  
  // Get column headers
  const headers = Object.keys(rows[0]);
  
  // Calculate column widths
  const widths = headers.map(h => {
    const values = rows.map(r => String(r[h] ?? '').length);
    return Math.max(h.length, ...values);
  });
  
  // Print header
  const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join(' | ');
  console.log(`  ${headerRow}`);
  console.log(`  ${widths.map(w => '─'.repeat(w)).join('─┼─')}`);
  
  // Print rows
  for (const row of rows) {
    const rowStr = headers.map((h, i) => String(row[h] ?? '').padEnd(widths[i])).join(' | ');
    console.log(`  ${rowStr}`);
  }
}

function main() {
  console.log('\n📊 TRADE ANALYSIS REPORT');
  console.log('Generated:', new Date().toISOString());
  
  // Get database (auto-initializes schema)
  const db = getDb();
  
  // Ensure live trading schema exists
  db.exec(LIVE_TRADING_SCHEMA);
  
  // 1. Recent trades
  try {
    const recentTrades = db.prepare(TRADE_QUERIES.recentTradesSummary).all();
    printTable(recentTrades, 'RECENT TRADES');
  } catch (e) {
    console.log('\n  No trades recorded yet');
  }
  
  // 2. Performance by category
  try {
    const byCategory = db.prepare(TRADE_QUERIES.performanceByCategory).all();
    if (byCategory.length > 0) {
      printTable(byCategory, 'PERFORMANCE BY CATEGORY');
    }
  } catch {}
  
  // 3. Performance by objective/subjective
  try {
    const byObjective = db.prepare(TRADE_QUERIES.performanceByObjective).all();
    if (byObjective.length > 0) {
      printTable(byObjective, 'OBJECTIVE vs SUBJECTIVE');
    }
  } catch {}
  
  // 4. Performance by score range
  try {
    const byScore = db.prepare(TRADE_QUERIES.performanceByScoreRange).all();
    if (byScore.length > 0) {
      printTable(byScore, 'PERFORMANCE BY SCORE RANGE');
    }
  } catch {}
  
  // 5. Performance by liquidity
  try {
    const byLiquidity = db.prepare(TRADE_QUERIES.performanceByLiquidity).all();
    if (byLiquidity.length > 0) {
      printTable(byLiquidity, 'PERFORMANCE BY LIQUIDITY');
    }
  } catch {}
  
  // 6. Overall stats
  try {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_trades,
        SUM(CASE WHEN status = 'open' OR status = 'pending' THEN 1 ELSE 0 END) as open_trades,
        ROUND(SUM(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) / NULLIF(SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END), 0) * 100, 1) as win_rate,
        ROUND(SUM(pnl), 2) as total_pnl,
        ROUND(AVG(pnl), 2) as avg_pnl
      FROM live_trades
    `).get() as any;
    
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  OVERALL SUMMARY');
    console.log('═'.repeat(60));
    console.log(`  Total trades:  ${stats.total_trades}`);
    console.log(`  Open trades:   ${stats.open_trades}`);
    console.log(`  Closed trades: ${stats.closed_trades}`);
    console.log(`  Win rate:      ${stats.win_rate ?? 'N/A'}%`);
    console.log(`  Total PnL:     $${stats.total_pnl ?? 0}`);
    console.log(`  Avg PnL:       $${stats.avg_pnl ?? 0}`);
  } catch {}
  
  console.log('\n');
}

main();

