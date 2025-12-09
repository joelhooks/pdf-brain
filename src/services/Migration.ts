/**
 * PGlite Migration Service
 *
 * Handles migration from PGlite 0.2.x (PostgreSQL 16) to 0.3.x (PostgreSQL 17).
 * Since automatic pg_dump migration isn't possible (0.2.x WASM crashes on current runtimes),
 * provides detection and manual migration paths.
 */

import { Effect, Context, Layer, Schema } from "effect";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

// ============================================================================
// Errors
// ============================================================================

export class MigrationError extends Schema.TaggedError<MigrationError>()(
  "MigrationError",
  { reason: Schema.String },
) {}

// ============================================================================
// Service Definition
// ============================================================================

export class Migration extends Context.Tag("Migration")<
  Migration,
  {
    /**
     * Check if database at given path needs migration from PG16 to PG17.
     * Returns true if migration is needed.
     */
    readonly checkMigrationNeeded: (
      dbPath: string,
    ) => Effect.Effect<boolean, MigrationError>;

    /**
     * Get helpful error message with migration options.
     */
    readonly getMigrationMessage: () => string;

    /**
     * Import SQL dump into fresh PG17 database.
     */
    readonly importFromDump: (
      dumpFile: string,
      dbPath: string,
    ) => Effect.Effect<void, MigrationError>;

    /**
     * Generate shell script for manual pg_dump with old PGlite.
     * User runs this with PGlite 0.2.x installed to export data.
     */
    readonly generateExportScript: (dbPath: string) => string;
  }
>() {}

// ============================================================================
// Implementation
// ============================================================================

export const MigrationLive = Layer.succeed(
  Migration,
  Migration.of({
    checkMigrationNeeded: (dbPath) =>
      Effect.gen(function* () {
        const pgDataDir = dbPath.replace(".db", "");

        // If directory doesn't exist, no migration needed (fresh install)
        if (!existsSync(pgDataDir)) {
          return false;
        }

        // Check for PG_VERSION file
        const versionFile = join(pgDataDir, "PG_VERSION");
        if (!existsSync(versionFile)) {
          // Directory exists but no version file - might be corrupted
          // Attempt to detect by trying to open with PG17
          return yield* Effect.tryPromise({
            try: async () => {
              try {
                const testDb = await PGlite.create({
                  dataDir: pgDataDir,
                  extensions: { vector },
                });
                await testDb.close();
                return false; // Successfully opened - no migration needed
              } catch (e) {
                // Failed to open - likely needs migration
                return true;
              }
            },
            catch: (e) =>
              new MigrationError({
                reason: `Failed to check database version: ${e}`,
              }),
          });
        }

        // Read PG_VERSION file
        const version = yield* Effect.try({
          try: () => readFileSync(versionFile, "utf8").trim(),
          catch: (e) =>
            new MigrationError({
              reason: `Failed to read PG_VERSION: ${e}`,
            }),
        });

        // If version is 16, migration is needed
        return version === "16";
      }),

    getMigrationMessage: () => `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DATABASE MIGRATION REQUIRED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your existing PDF library database uses PostgreSQL 16 (PGlite 0.2.x).
This version requires PostgreSQL 17 (PGlite 0.3.x).

Automatic migration is not possible because PGlite 0.2.x WASM crashes on
current Node.js runtimes. You have two options:

OPTION 1: Fresh Start (Easiest)
────────────────────────────────
1. Backup your database directory if desired
2. Delete the database directory to start fresh
3. Re-add your PDFs

OPTION 2: Manual Migration (Preserve Data)
───────────────────────────────────────────
Migration scripts are provided in the repository.

1. Export data using PGlite 0.2.x:
   cd /path/to/pdf-library
   npm install @electric-sql/pglite@0.2.12
   node scripts/migration/export-pg16.mjs

2. Import into PGlite 0.3.x:
   bun run scripts/migration/import-pg17.ts

3. Regenerate embeddings (if needed):
   bun run scripts/migration/regenerate-embeddings.ts

For detailed instructions, see:
https://github.com/joelhooks/pdf-library#migration

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`,

    importFromDump: (dumpFile, dbPath) =>
      Effect.gen(function* () {
        // Verify dump file exists
        if (!existsSync(dumpFile)) {
          return yield* Effect.fail(
            new MigrationError({
              reason: `Dump file not found: ${dumpFile}`,
            }),
          );
        }

        // Read SQL dump
        const sql = yield* Effect.try({
          try: () => readFileSync(dumpFile, "utf8"),
          catch: (e) =>
            new MigrationError({
              reason: `Failed to read dump file: ${e}`,
            }),
        });

        // Create fresh PG17 database
        const pgDataDir = dbPath.replace(".db", "");
        const db = yield* Effect.tryPromise({
          try: () =>
            PGlite.create({
              dataDir: pgDataDir,
              extensions: { vector },
            }),
          catch: (e) =>
            new MigrationError({
              reason: `Failed to create new database: ${e}`,
            }),
        });

        // Execute dump SQL
        yield* Effect.tryPromise({
          try: async () => {
            await db.exec(sql);
            await db.close();
          },
          catch: (e) =>
            new MigrationError({
              reason: `Failed to import dump: ${e}`,
            }),
        });
      }),

    generateExportScript: (dbPath) => {
      const pgDataDir = dbPath.replace(".db", "");
      const dumpFile = join(process.cwd(), "library-dump.sql");

      // Generate a Node.js script that uses PGlite 0.2.x to export data
      return `#!/usr/bin/env node
/**
 * PDF Library Database Export Script
 * 
 * This script exports your database using PGlite 0.2.x.
 * 
 * Prerequisites:
 * 1. Node.js 18+
 * 2. Install dependencies:
 *    npm install @electric-sql/pglite@0.2.12
 * 
 * Usage:
 *    node export.js
 */

const { PGlite } = require('@electric-sql/pglite');
const { writeFileSync } = require('fs');

(async () => {
  console.log('Opening database with PGlite 0.2.x...');
  
  const db = new PGlite('${pgDataDir}');
  
  console.log('Exporting documents table...');
  const docs = await db.query('SELECT * FROM documents');
  
  console.log('Exporting chunks table...');
  const chunks = await db.query('SELECT * FROM chunks');
  
  console.log('Exporting embeddings table...');
  const embeddings = await db.query('SELECT * FROM embeddings');
  
  // Generate SQL dump
  let sql = '-- PDF Library Database Dump\\n';
  sql += '-- Generated with PGlite 0.2.x\\n\\n';
  
  sql += 'BEGIN;\\n\\n';
  
  // Enable extensions
  sql += 'CREATE EXTENSION IF NOT EXISTS vector;\\n\\n';
  
  // Create tables
  sql += \`CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    added_at TIMESTAMPTZ NOT NULL,
    page_count INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    tags JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}'
  );\\n\\n\`;
  
  sql += \`CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL
  );\\n\\n\`;
  
  sql += \`CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    embedding vector(1024) NOT NULL
  );\\n\\n\`;
  
  // Insert documents
  for (const row of docs.rows) {
    const values = [
      row.id,
      row.title.replace(/'/g, "''"),
      row.path.replace(/'/g, "''"),
      row.added_at,
      row.page_count,
      row.size_bytes,
      JSON.stringify(row.tags),
      JSON.stringify(row.metadata)
    ];
    sql += \`INSERT INTO documents (id, title, path, added_at, page_count, size_bytes, tags, metadata) VALUES ('\${values[0]}', '\${values[1]}', '\${values[2]}', '\${values[3]}', \${values[4]}, \${values[5]}, '\${values[6]}', '\${values[7]}');\\n\`;
  }
  
  sql += '\\n';
  
  // Insert chunks
  for (const row of chunks.rows) {
    const content = row.content.replace(/'/g, "''");
    sql += \`INSERT INTO chunks (id, doc_id, page, chunk_index, content) VALUES ('\${row.id}', '\${row.doc_id}', \${row.page}, \${row.chunk_index}, '\${content}');\\n\`;
  }
  
  sql += '\\n';
  
  // Insert embeddings
  for (const row of embeddings.rows) {
    sql += \`INSERT INTO embeddings (chunk_id, embedding) VALUES ('\${row.chunk_id}', '\${row.embedding}');\\n\`;
  }
  
  sql += '\\nCOMMIT;\\n';
  
  // Write dump file
  writeFileSync('${dumpFile}', sql);
  
  await db.close();
  
  console.log(\`\\nExport complete! Dump saved to: ${dumpFile}\`);
  console.log(\`\\nNext steps:\`);
  console.log(\`  1. Upgrade to PGlite 0.3.x\`);
  console.log(\`  2. Import dump: pdf-library migration import ${dumpFile}\`);
})().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
`;
    },
  }),
);
