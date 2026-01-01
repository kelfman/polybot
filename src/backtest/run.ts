/**
 * CLI script to run backtests
 */

import 'dotenv/config';
import { createBacktestEngine } from './engine.js';
import { formatMetrics } from './metrics.js';
import { getConfig } from '../config/index.js';
import { closeDb, getDbStats } from '../db/client.js';
import type { ClassificationPerformance } from '../classification/index.js';

/**
 * Format a classification performance row
 */
function formatPerformanceRow(perf: ClassificationPerformance): string {
  const pnlSign = perf.totalPnL >= 0 ? '+' : '';
  return `  ${perf.label.padEnd(15)} ${String(perf.tradeCount).padStart(4)} trades  ${(perf.winRate * 100).toFixed(0).padStart(3)}% win  ${pnlSign}$${perf.totalPnL.toFixed(2)}`;
}

async function main() {
  console.log('=== Polymarket Backtester ===\n');
  
  try {
    const config = getConfig();
    console.log('Config loaded successfully');
    console.log(`Strategy: ${config.strategy.name}`);
    console.log(`Entry range: ${config.strategy.entryPriceMin} - ${config.strategy.entryPriceMax}`);
    console.log(`Exit: ${config.strategy.holdToResolution ? 'HOLD TO RESOLUTION' : `Target @ ${config.strategy.exitPriceTarget}`}`);
    console.log(`Time window: ${config.strategy.timeToResolutionDaysMin} - ${config.strategy.timeToResolutionDaysMax} days`);
    
    // Show classification settings
    console.log('\nClassifications:');
    if (config.classification.volatility.enabled) {
      console.log(`  Volatility: ON (threshold: ${config.classification.volatility.highVolatilityThreshold}% swing)`);
    } else {
      console.log('  Volatility: OFF');
    }
    if (config.classification.llmConvergence.enabled) {
      console.log(`  LLM Convergence: ON (${config.classification.llmConvergence.provider}/${config.classification.llmConvergence.model})`);
    } else {
      console.log('  LLM Convergence: OFF');
    }

    // Check database has data
    const stats = getDbStats();
    console.log('\nDatabase stats:');
    console.log(`  Markets: ${stats.marketCount}`);
    console.log(`  Price points: ${stats.pricePointCount}`);
    console.log(`  Previous backtest runs: ${stats.backtestRunCount}`);

    if (stats.marketCount === 0) {
      console.log('\nNo markets in database. Run `npm run ingest` first to fetch historical data.');
      process.exit(1);
    }

    if (stats.pricePointCount === 0) {
      console.log('\nNo price history in database. Run `npm run ingest` first to fetch historical data.');
      process.exit(1);
    }

    // Run backtest
    console.log('\n--- Running Backtest ---\n');
    const engine = createBacktestEngine();

    const result = await engine.run({
      dryRun: false,
      progressCallback: (progress) => {
        const percent = Math.round((progress.currentMarket / progress.totalMarkets) * 100);
        process.stdout.write(`\r[${progress.phase}] ${percent}% (${progress.currentMarket}/${progress.totalMarkets}) - ${progress.tradesFound} trades`);
      },
    });

    console.log('\n');
    
    // Show main metrics
    console.log(formatMetrics(result.metrics));

    // Show classification breakdown
    const breakdown = result.classificationBreakdown;
    
    if (breakdown.byVolatility.length > 0) {
      console.log('\n=== Performance by Volatility ===');
      for (const perf of breakdown.byVolatility) {
        console.log(formatPerformanceRow(perf));
      }
    }
    
    if (breakdown.byConvergence.length > 0 && breakdown.byConvergence.some(p => p.label !== 'unknown')) {
      console.log('\n=== Performance by Convergence Type ===');
      for (const perf of breakdown.byConvergence) {
        console.log(formatPerformanceRow(perf));
      }
    }
    
    if (breakdown.byCategory.length > 0) {
      console.log('\n=== Performance by Category ===');
      for (const perf of breakdown.byCategory.slice(0, 10)) { // Top 10 categories
        console.log(formatPerformanceRow(perf));
      }
      if (breakdown.byCategory.length > 10) {
        console.log(`  ... and ${breakdown.byCategory.length - 10} more categories`);
      }
    }

    console.log(`\n=== Run Details ===`);
    console.log(`Run ID: ${result.runId}`);
    console.log(`Markets analyzed: ${result.marketsAnalyzed}`);
    console.log(`Markets classified: ${result.classifications.size}`);
    console.log(`Duration: ${result.duration}ms`);
    
    if (result.errors.length > 0) {
      console.log(`\nErrors (${result.errors.length}):`);
      result.errors.slice(0, 5).forEach(e => console.log(`  - ${e}`));
      if (result.errors.length > 5) {
        console.log(`  ... and ${result.errors.length - 5} more`);
      }
    }

    // Show sample trades
    if (result.trades.length > 0) {
      console.log(`\n=== Sample Trades (first 5) ===`);
      result.trades.slice(0, 5).forEach((trade, i) => {
        const classification = result.classifications.get(trade.market_id);
        const volLevel = classification?.volatility.level || 'n/a';
        console.log(`${i + 1}. ${trade.market_id.substring(0, 16)}... [vol: ${volLevel}]`);
        console.log(`   ${trade.side} @ ${trade.entry_price.toFixed(3)} -> ${trade.exit_price?.toFixed(3) || 'open'}`);
        console.log(`   PnL: $${trade.pnl?.toFixed(2) || 'N/A'} (${trade.exit_reason || 'open'})`);
      });
    }

  } catch (error) {
    console.error('Backtest failed:', error);
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();
