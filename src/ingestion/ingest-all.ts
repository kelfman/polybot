/**
 * Ingest from all available Kaggle datasets
 */

import 'dotenv/config';
import { createDataSource, type DataSource } from '../datasources/index.js';
import { 
  upsertMarket, 
  insertPriceHistory, 
  getMarket,
  getPriceHistory,
  getDbStats,
  getDb 
} from '../db/client.js';
import { closeDb } from '../db/client.js';

async function ingestFromSource(source: DataSource, sourceName: string): Promise<{markets: number, pricePoints: number}> {
  console.log(`\n--- Ingesting from ${sourceName} ---`);
  
  if (!(await source.isAvailable())) {
    console.log(`  ${sourceName} not available, skipping`);
    return { markets: 0, pricePoints: 0 };
  }
  
  let marketsIngested = 0;
  let pricePointsIngested = 0;
  
  // Fetch resolved markets (DataSource returns array directly)
  let markets: Awaited<ReturnType<typeof source.fetchMarkets>>;
  try {
    markets = await source.fetchMarkets({ resolved: true });
  } catch (error) {
    console.log(`  Failed to fetch markets: ${error}`);
    return { markets: 0, pricePoints: 0 };
  }
  
  if (!markets || markets.length === 0) {
    console.log(`  No markets found`);
    return { markets: 0, pricePoints: 0 };
  }
  console.log(`  Found ${markets.length} resolved markets`);
  
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    
    // Skip if already exists with price history
    const existing = getMarket(market.id);
    const existingPrices = existing ? getPriceHistory(market.id) : [];
    
    if (existing && existingPrices.length > 0) {
      continue;
    }
    
    // Store market
    upsertMarket({
      id: market.id,
      question: market.question,
      category: market.category,
      resolution_date: market.resolutionDate,
      outcome: market.outcome,
      created_at: market.createdAt,
      is_binary: market.isBinary ? 1 : 0,
      volume_usd: market.volumeUsd,
      liquidity_usd: market.liquidityUsd,
    });
    marketsIngested++;
    
    // Fetch and store price history (DataSource returns array directly)
    const priceData = await source.fetchPriceHistory(market.id);
    if (priceData && priceData.length > 0) {
      insertPriceHistory(priceData.map(p => ({
        market_id: p.marketId,
        timestamp: p.timestamp,
        yes_price: p.yesPrice,
        no_price: p.noPrice,
        volume: p.volume,
      })));
      pricePointsIngested += priceData.length;
    }
    
    if ((i + 1) % 100 === 0 || i === markets.length - 1) {
      process.stdout.write(`\r  Progress: ${i + 1}/${markets.length} markets`);
    }
  }
  
  console.log(`\n  Added ${marketsIngested} new markets, ${pricePointsIngested} price points`);
  return { markets: marketsIngested, pricePoints: pricePointsIngested };
}

async function main() {
  console.log('=== Multi-Source Data Ingestion ===');
  
  // Ensure database is initialized
  getDb();
  
  const beforeStats = getDbStats();
  console.log(`\nBefore: ${beforeStats.marketCount} markets, ${beforeStats.pricePointCount} price points`);
  
  // Source 1: Kaggle NDJSON (larger dataset)
  const ndjsonSource = createDataSource('kaggle-ndjson', './data/kaggle/Polymarket_dataset/Polymarket_dataset');
  const ndjsonResult = await ingestFromSource(ndjsonSource, 'Kaggle NDJSON');
  
  // Source 2: Kaggle CSV (filtered_4_ML)
  const csvSource = createDataSource('kaggle', './data/kaggle/filtered_4_ML/filtered_4_ML');
  const csvResult = await ingestFromSource(csvSource, 'Kaggle CSV (filtered_4_ML)');
  
  const afterStats = getDbStats();
  console.log('\n=== Summary ===');
  console.log(`Total markets: ${afterStats.marketCount} (+${afterStats.marketCount - beforeStats.marketCount})`);
  console.log(`Total price points: ${afterStats.pricePointCount} (+${afterStats.pricePointCount - beforeStats.pricePointCount})`);
  
  closeDb();
}

main().catch(console.error);

