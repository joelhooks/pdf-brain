#!/usr/bin/env node
/**
 * Export data from PGlite 0.2.x (PostgreSQL 16) database
 * 
 * This script exports your existing database using PGlite 0.2.x before upgrading.
 * 
 * Prerequisites:
 *   npm install @electric-sql/pglite@0.2.12
 * 
 * Usage:
 *   node export-pg16.mjs [db-path] [output-dir]
 * 
 * Example:
 *   node export-pg16.mjs ~/.pdf-library/library ~/.pdf-library
 */

import { PGlite } from '@electric-sql/pglite';
import { writeFileSync, appendFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const args = process.argv.slice(2);
const dbPath = args[0] || join(process.env.HOME, 'Documents/.pdf-library/library');
const outputDir = args[1] || dirname(dbPath);

async function main() {
  console.log('=== PGlite 0.2.x Database Export ===\n');
  console.log(`Database: ${dbPath}`);
  console.log(`Output: ${outputDir}\n`);

  // Check if database exists
  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    process.exit(1);
  }

  // Check PG_VERSION
  const versionFile = join(dbPath, 'PG_VERSION');
  if (existsSync(versionFile)) {
    const version = require('fs').readFileSync(versionFile, 'utf-8').trim();
    console.log(`PostgreSQL version: ${version}`);
    if (version !== '16') {
      console.warn(`Warning: Expected PG version 16, found ${version}`);
    }
  }

  console.log('\nOpening database with PGlite 0.2.x...');
  
  let db;
  try {
    db = await PGlite.create({ dataDir: dbPath });
  } catch (e) {
    console.error(`Failed to open database: ${e.message}`);
    console.error('\nMake sure you have PGlite 0.2.x installed:');
    console.error('  npm install @electric-sql/pglite@0.2.12');
    process.exit(1);
  }

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Export documents
  console.log('\nExporting documents...');
  const docs = await db.query('SELECT * FROM documents');
  console.log(`  Found ${docs.rows.length} documents`);
  
  const docsFile = join(outputDir, 'backup-documents.json');
  writeFileSync(docsFile, JSON.stringify(docs.rows, null, 2));
  console.log(`  Saved to: ${docsFile}`);

  // Count chunks
  const chunkCount = await db.query('SELECT COUNT(*) as c FROM chunks');
  const totalChunks = parseInt(chunkCount.rows[0].c);
  console.log(`\nExporting ${totalChunks} chunks...`);

  // Export chunks in batches
  const chunksFile = join(outputDir, 'backup-chunks.jsonl');
  if (existsSync(chunksFile)) unlinkSync(chunksFile);

  const batchSize = 100;
  let exported = 0;

  for (let offset = 0; offset < totalChunks; offset += batchSize) {
    const batch = await db.query(
      `SELECT * FROM chunks ORDER BY id LIMIT ${batchSize} OFFSET ${offset}`
    );
    
    for (const row of batch.rows) {
      appendFileSync(chunksFile, JSON.stringify(row) + '\n');
    }
    
    exported += batch.rows.length;
    if (exported % 10000 === 0 || exported === totalChunks) {
      console.log(`  Progress: ${exported}/${totalChunks}`);
    }
  }
  console.log(`  Saved to: ${chunksFile}`);

  // Try to export embeddings (may fail if vector extension issues)
  console.log('\nExporting embeddings...');
  try {
    const embCount = await db.query('SELECT COUNT(*) as c FROM embeddings');
    const totalEmb = parseInt(embCount.rows[0].c);
    console.log(`  Found ${totalEmb} embeddings`);

    if (totalEmb > 0) {
      const embFile = join(outputDir, 'backup-embeddings.jsonl');
      if (existsSync(embFile)) unlinkSync(embFile);

      let embExported = 0;
      for (let offset = 0; offset < totalEmb; offset += batchSize) {
        const batch = await db.query(
          `SELECT chunk_id, embedding::text as embedding FROM embeddings ORDER BY chunk_id LIMIT ${batchSize} OFFSET ${offset}`
        );
        
        for (const row of batch.rows) {
          appendFileSync(embFile, JSON.stringify(row) + '\n');
        }
        
        embExported += batch.rows.length;
        if (embExported % 5000 === 0 || embExported === totalEmb) {
          console.log(`  Progress: ${embExported}/${totalEmb}`);
        }
      }
      console.log(`  Saved to: ${embFile}`);
    }
  } catch (e) {
    console.log(`  Skipped: ${e.message}`);
    console.log('  (Embeddings can be regenerated after import)');
  }

  await db.close();

  console.log('\n=== Export Complete ===');
  console.log('\nBackup files:');
  console.log(`  - ${join(outputDir, 'backup-documents.json')}`);
  console.log(`  - ${join(outputDir, 'backup-chunks.jsonl')}`);
  if (existsSync(join(outputDir, 'backup-embeddings.jsonl'))) {
    console.log(`  - ${join(outputDir, 'backup-embeddings.jsonl')}`);
  }
  console.log('\nNext steps:');
  console.log('  1. Upgrade to PGlite 0.3.x: bun install');
  console.log('  2. Import data: bun run scripts/migration/import-pg17.ts');
}

main().catch(e => {
  console.error('Export failed:', e);
  process.exit(1);
});
