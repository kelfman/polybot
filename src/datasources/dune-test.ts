/**
 * Test script to explore Dune Analytics for Polymarket data
 * 
 * Dune has curated "Spellbook" tables for many protocols.
 * Let's check what Polymarket data is available.
 * 
 * Known Polymarket-related tables on Dune:
 * - polymarket_polygon.market_trades (if exists)
 * - Or raw polygon transaction data filtered by Polymarket contracts
 * 
 * Polymarket CLOB Contract (Polygon): 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
 */

import { DuneClient } from '@duneanalytics/client-sdk';
import 'dotenv/config';

async function exploreDuneData() {
  const apiKey = process.env.DUNE_API_KEY;
  
  if (!apiKey) {
    console.log('DUNE_API_KEY not found in .env');
    console.log('\nTo use Dune Analytics:');
    console.log('1. Sign up at https://dune.com');
    console.log('2. Go to Settings > API');
    console.log('3. Create an API key');
    console.log('4. Add DUNE_API_KEY=your_key to .env');
    console.log('\nDune has a free tier with 2,500 credits/month.');
    return;
  }
  
  const client = new DuneClient(apiKey);
  
  console.log('=== Dune Analytics Polymarket Exploration ===\n');
  
  // Query to find Polymarket-related tables in Dune's Spellbook
  // This is a meta-query to explore available data
  const explorationQuery = `
    -- Find Polymarket related decoded tables
    SELECT 
      namespace,
      name,
      schema_id
    FROM dune.spellbook.tables
    WHERE LOWER(namespace) LIKE '%polymarket%'
       OR LOWER(name) LIKE '%polymarket%'
    LIMIT 50
  `;
  
  try {
    console.log('Searching for Polymarket tables in Dune Spellbook...');
    
    // Execute a simple query to check Polymarket data availability
    // Using query ID 0 means we need to run an ad-hoc query
    // Dune SDK may require using existing saved queries
    
    // Let's try to find existing public Polymarket queries
    // Common query IDs for Polymarket (these would need to be discovered)
    
    console.log('\nNote: Dune requires either:');
    console.log('1. A saved query ID to execute');
    console.log('2. Premium tier for ad-hoc SQL queries via API');
    console.log('\nRecommended approach:');
    console.log('1. Go to https://dune.com/browse/dashboards?q=polymarket');
    console.log('2. Find queries with historical trade data');
    console.log('3. Note the query ID from the URL');
    console.log('4. Use that query ID with this SDK');
    
    console.log('\n--- Sample Query IDs to try (if they exist) ---');
    
    // Try a known public query if one exists
    // This would need to be replaced with actual Polymarket query IDs
    const sampleQueryId = 3539277; // Example - may not be valid
    
    console.log(`\nAttempting to fetch results from query ID ${sampleQueryId}...`);
    
    try {
      const results = await client.getLatestResult({ queryId: sampleQueryId });
      console.log('Query found! Results:');
      console.log(JSON.stringify(results.result?.rows?.slice(0, 5), null, 2));
    } catch (error) {
      console.log(`Query ${sampleQueryId} not found or not accessible.`);
      console.log('You need to find valid Polymarket query IDs on dune.com');
    }
    
  } catch (error) {
    console.error('Dune API error:', error);
  }
}

exploreDuneData();

