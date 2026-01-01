/**
 * Migration: Add profile columns to live_trades table
 */

import 'dotenv/config';
import { getDb } from './client.js';

function main() {
  console.log('Migrating live_trades table...');
  
  const db = getDb();

  // Add new columns to live_trades if they don't exist
  const columns: [string, string][] = [
    ['question', 'TEXT'],
    ['category', 'TEXT'],
    ['is_objective', 'INTEGER'],
    ['days_to_resolution', 'REAL'],
    ['liquidity', 'REAL'],
    ['spread', 'REAL'],
    ['qualification_score', 'INTEGER'],
    ['resolution_price', 'REAL'],
    ['resolved_at', 'TEXT'],
  ];

  for (const [col, type] of columns) {
    try {
      db.exec(`ALTER TABLE live_trades ADD COLUMN ${col} ${type}`);
      console.log(`  ✅ Added column: ${col}`);
    } catch (e: any) {
      if (e.message.includes('duplicate column')) {
        console.log(`  ⏭️  Column exists: ${col}`);
      } else {
        console.error(`  ❌ Error adding ${col}:`, e.message);
      }
    }
  }

  console.log('Migration complete');
}

main();

