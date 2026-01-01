/**
 * CLI entry point for the trading bot
 */

import 'dotenv/config';
import { runBot } from './bot.js';

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const mode = args.includes('--live') ? 'live' : 'paper';

  console.log('='.repeat(60));
  console.log('  POLYMARKET TRADING BOT - Late-Stage Convergence Strategy');
  console.log('='.repeat(60));
  console.log();
  
  if (mode === 'live') {
    console.log('⚠️  WARNING: LIVE TRADING MODE ⚠️');
    console.log('Real money will be used. Press Ctrl+C to cancel within 5 seconds...');
    console.log();
    
    // Give user time to cancel
    await new Promise(resolve => setTimeout(resolve, 5000));
  } else {
    console.log('📋 PAPER TRADING MODE (no real orders)');
    console.log();
  }

  try {
    await runBot(mode);
    
    // Keep process alive
    console.log('\n[Bot] Running... Press Ctrl+C to stop\n');
    
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main();

