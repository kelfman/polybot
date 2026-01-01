/**
 * Parameter sweep for backtesting
 * Tests different parameter combinations to find optimal settings
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { BacktestEngine } from './engine.js';
import { clearConfigCache } from '../config/index.js';

interface SweepResult {
  params: {
    entryPriceMin: number;
    entryPriceMax: number;
    timeToResolutionDaysMax: number;
    positionSizeUsd: number;
    maxPositions: number;
  };
  trades: number;
  winners: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  maxDrawdown: number;
  sharpe: number;
  roi: number; // Return on max exposure
}

// Store original config globally for restoration
let originalConfigBackup: string | null = null;

async function runSweep() {
  const configPath = resolve(process.cwd(), 'config.json');
  originalConfigBackup = readFileSync(configPath, 'utf-8');
  const baseConfig = JSON.parse(originalConfigBackup);
  
  const results: SweepResult[] = [];
  
  // Parameter ranges to test
  const entryRanges = [
    { min: 0.70, max: 0.90 },
    { min: 0.75, max: 0.90 },
    { min: 0.80, max: 0.95 },
  ];
  
  const daysToResolution = [3, 5, 7, 14];
  
  // Risk parameters to test
  const positionSizes = [5, 10, 25, 50];
  const maxPositionsCounts = [5, 10, 20, 50];
  
  let totalTests = entryRanges.length * daysToResolution.length * positionSizes.length * maxPositionsCounts.length;
  let currentTest = 0;
  
  console.log(`Running ${totalTests} parameter combinations...\n`);
  
  for (const entryRange of entryRanges) {
    for (const days of daysToResolution) {
      for (const posSize of positionSizes) {
        for (const maxPos of maxPositionsCounts) {
          currentTest++;
          
          const maxExposure = posSize * maxPos;
          
          // Update config
          const testConfig = {
            ...baseConfig,
            strategy: {
              ...baseConfig.strategy,
              entryPriceMin: entryRange.min,
              entryPriceMax: entryRange.max,
              timeToResolutionDaysMax: days,
              holdToResolution: true,
              maxVolatility: 'low',
            },
            risk: {
              ...baseConfig.risk,
              positionSizeUsd: posSize,
              maxPositions: maxPos,
              maxExposureUsd: maxExposure,
            },
          };
          
          writeFileSync(configPath, JSON.stringify(testConfig, null, 2));
          clearConfigCache();
          
          // Run backtest (suppress console output)
          let result;
          const originalLog = console.log;
          console.log = () => {};
          try {
            const engine = new BacktestEngine();
            result = await engine.run({ dryRun: true });
          } catch (error) {
            // Skip invalid configurations
            console.log = originalLog;
            continue;
          }
          console.log = originalLog;
          
          if (result && result.trades.length > 0) {
            const winners = result.trades.filter(t => (t.pnl || 0) > 0).length;
            const totalPnl = result.trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
            
            results.push({
              params: {
                entryPriceMin: entryRange.min,
                entryPriceMax: entryRange.max,
                timeToResolutionDaysMax: days,
                positionSizeUsd: posSize,
                maxPositions: maxPos,
              },
              trades: result.trades.length,
              winners,
              winRate: (winners / result.trades.length) * 100,
              totalPnl,
              avgPnl: totalPnl / result.trades.length,
              maxDrawdown: result.metrics?.maxDrawdown || 0,
              sharpe: result.metrics?.sharpeRatio || 0,
              roi: (totalPnl / maxExposure) * 100,
            });
          }
          
          process.stdout.write(`\r[${currentTest}/${totalTests}] Entry: ${entryRange.min}-${entryRange.max}, Days: ${days}, Size: $${posSize}, Max: ${maxPos}`);
        }
      }
    }
  }
  
  // Restore original config
  writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));
  clearConfigCache();
  
  console.log('\n\n=== PARAMETER SWEEP RESULTS ===\n');
  
  // Sort by different criteria
  console.log('--- TOP 15 BY TOTAL PnL ---');
  const byPnl = [...results].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 15);
  printResults(byPnl);
  
  console.log('\n--- TOP 15 BY ROI (PnL / Max Exposure) ---');
  const byRoi = [...results]
    .filter(r => r.trades >= 5)
    .sort((a, b) => b.roi - a.roi)
    .slice(0, 15);
  printResults(byRoi);
  
  console.log('\n--- TOP 15 BY SHARPE RATIO (min 10 trades) ---');
  const bySharpe = [...results]
    .filter(r => r.trades >= 10)
    .sort((a, b) => b.sharpe - a.sharpe)
    .slice(0, 15);
  printResults(bySharpe);
  
  console.log('\n--- TOP 15 BY TRADE COUNT ---');
  const byTrades = [...results].sort((a, b) => b.trades - a.trades).slice(0, 15);
  printResults(byTrades);
  
  console.log('\n--- 100% WIN RATE CONFIGURATIONS (min 5 trades) ---');
  const perfect = results.filter(r => r.winRate === 100 && r.trades >= 5).slice(0, 20);
  printResults(perfect);
}

function printResults(results: SweepResult[]) {
  if (results.length === 0) {
    console.log('  (no results)');
    return;
  }
  
  console.log('  Entry Range | Days | Size | MaxPos | Trades | Win%   | PnL       | ROI%   | Sharpe');
  console.log('  ------------|------|------|--------|--------|--------|-----------|--------|-------');
  
  for (const r of results) {
    const entry = `${r.params.entryPriceMin.toFixed(2)}-${r.params.entryPriceMax.toFixed(2)}`;
    const size = ('$' + r.params.positionSizeUsd).padStart(4);
    const maxPos = r.params.maxPositions.toString().padStart(6);
    const trades = r.trades.toString().padStart(6);
    const winRate = r.winRate.toFixed(1).padStart(5) + '%';
    const pnl = (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(2);
    const roi = r.roi.toFixed(1) + '%';
    const sharpe = r.sharpe.toFixed(2);
    
    console.log(`  ${entry.padEnd(11)} | ${r.params.timeToResolutionDaysMax.toString().padStart(4)} | ${size} | ${maxPos} | ${trades} | ${winRate} | ${pnl.padStart(9)} | ${roi.padStart(6)} | ${sharpe.padStart(6)}`);
  }
}

runSweep()
  .catch(console.error)
  .finally(() => {
    // Always restore original config, even on error
    if (originalConfigBackup) {
      const configPath = resolve(process.cwd(), 'config.json');
      writeFileSync(configPath, originalConfigBackup);
      console.log('\nConfig restored.');
    }
  });
