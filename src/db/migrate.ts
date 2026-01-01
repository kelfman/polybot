/**
 * Database migration script
 * Ensures schema is up to date
 */

import 'dotenv/config';
import { getDb, closeDb } from './client.js';
import { SCHEMA_VERSION } from './schema.js';

async function main() {
  console.log('=== Database Migration ===\n');
  
  try {
    const db = getDb();
    
    // Get current version
    const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number };
    console.log(`Current schema version: ${row.version}`);
    console.log(`Target schema version: ${SCHEMA_VERSION}`);
    
    if (row.version >= SCHEMA_VERSION) {
      console.log('\nDatabase is up to date. No migration needed.');
    } else {
      console.log('\nMigration would be needed here.');
      // Future: add migration logic here
    }
    
    // Show table info
    console.log('\nTables in database:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    tables.forEach(t => console.log(`  - ${t.name}`));
    
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();

