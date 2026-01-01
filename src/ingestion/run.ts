/**
 * CLI script to run data ingestion
 */

import 'dotenv/config';
import { ingestData, getIngestionStats } from './fetcher.js';
import { getConfig } from '../config/index.js';
import { closeDb } from '../db/client.js';

async function main() {
  console.log('=== Polymarket Data Ingestion ===\n');
  
  try {
    const config = getConfig();
    console.log('Config loaded successfully');
    console.log(`Data source: primary=${config.dataSource.primary}, fallback=${config.dataSource.fallback}\n`);

    // Show current stats before ingestion
    const beforeStats = getIngestionStats();
    console.log('Database stats before ingestion:');
    console.log(`  Markets: ${beforeStats.markets}`);
    console.log(`  Price points: ${beforeStats.pricePoints}`);
    console.log(`  Backtest runs: ${beforeStats.backtestRuns}\n`);

    // Run ingestion
    console.log('Starting data ingestion...\n');
    
    const result = await ingestData({
      filter: {
        resolved: true,
        // No limit - ingest all available markets
      },
      skipExisting: true,
      fetchPriceHistory: true,
      progressCallback: (progress) => {
        const percent = Math.round((progress.current / progress.total) * 100);
        process.stdout.write(`\r[${progress.phase}] ${percent}% (${progress.current}/${progress.total}) - ${progress.currentMarketId || ''}`);
      },
    });

    console.log('\n\n=== Ingestion Result ===');
    console.log(`Success: ${result.success}`);
    console.log(`Source: ${result.source}`);
    console.log(`Duration: ${result.duration}ms`);
    console.log(`Markets ingested: ${result.marketsIngested}`);
    console.log(`Price points ingested: ${result.pricePointsIngested}`);
    
    if (result.errors.length > 0) {
      console.log(`\nErrors (${result.errors.length}):`);
      result.errors.slice(0, 10).forEach(e => console.log(`  - ${e}`));
      if (result.errors.length > 10) {
        console.log(`  ... and ${result.errors.length - 10} more`);
      }
    }

    // Show stats after ingestion
    const afterStats = getIngestionStats();
    console.log('\nDatabase stats after ingestion:');
    console.log(`  Markets: ${afterStats.markets} (+${afterStats.markets - beforeStats.markets})`);
    console.log(`  Price points: ${afterStats.pricePoints} (+${afterStats.pricePoints - beforeStats.pricePoints})`);

  } catch (error) {
    console.error('Ingestion failed:', error);
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();

