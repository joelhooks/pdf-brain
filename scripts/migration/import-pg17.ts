#!/usr/bin/env bun
/**
 * Import backup data into PGlite 0.3.x (PostgreSQL 17) database
 *
 * This script imports data exported from PGlite 0.2.x.
 *
 * Usage:
 *   bun run scripts/migration/import-pg17.ts [backup-dir] [db-path]
 *
 * Example:
 *   bun run scripts/migration/import-pg17.ts ~/.pdf-library ~/.pdf-library/library
 */

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { readFileSync, createReadStream, existsSync } from "fs";
import { createInterface } from "readline";
import { join } from "path";

const EMBEDDING_DIM = 1024;

const args = process.argv.slice(2);
const backupDir = args[0] || join(process.env.HOME!, "Documents/.pdf-library");
const dbPath = args[1] || join(backupDir, "library");

async function main() {
  console.log("=== PGlite 0.3.x Database Import ===\n");
  console.log(`Backup dir: ${backupDir}`);
  console.log(`Database: ${dbPath}\n`);

  // Check backup files exist
  const docsFile = join(backupDir, "backup-documents.json");
  const chunksFile = join(backupDir, "backup-chunks.jsonl");

  if (!existsSync(docsFile)) {
    console.error(`Error: Documents backup not found: ${docsFile}`);
    console.error("\nRun the export script first:");
    console.error("  node scripts/migration/export-pg16.mjs");
    process.exit(1);
  }

  if (!existsSync(chunksFile)) {
    console.error(`Error: Chunks backup not found: ${chunksFile}`);
    process.exit(1);
  }

  // Check if database already exists
  if (existsSync(dbPath)) {
    const versionFile = join(dbPath, "PG_VERSION");
    if (existsSync(versionFile)) {
      const version = readFileSync(versionFile, "utf-8").trim();
      if (version === "17") {
        console.error("Error: PG17 database already exists at this location.");
        console.error("Remove it first if you want to re-import:");
        console.error(`  rm -r "${dbPath}"`);
        process.exit(1);
      }
    }
  }

  console.log("Creating new PGlite 0.3.x database...");
  const db = new PGlite(dbPath, { extensions: { vector } });
  await db.waitReady;

  console.log("Initializing schema...");
  await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      added_at TIMESTAMPTZ NOT NULL,
      page_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      tags JSONB DEFAULT '[]',
      metadata JSONB DEFAULT '{}'
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      embedding vector(${EMBEDDING_DIM}) NOT NULL
    )
  `);

  // Create indexes
  await db.exec(`
    CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx 
    ON embeddings USING hnsw (embedding vector_cosine_ops)
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS chunks_content_idx 
    ON chunks USING gin (to_tsvector('english', content))
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_docs_path ON documents(path)`);

  console.log("Schema created!\n");

  // Import documents
  console.log("Importing documents...");
  const docs = JSON.parse(readFileSync(docsFile, "utf-8"));
  const docIds = new Set<string>();

  for (const doc of docs) {
    docIds.add(doc.id);
    await db.query(
      `INSERT INTO documents (id, title, path, added_at, page_count, size_bytes, tags, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        doc.id,
        doc.title,
        doc.path,
        doc.added_at,
        doc.page_count,
        doc.size_bytes,
        JSON.stringify(doc.tags || []),
        JSON.stringify(doc.metadata || {}),
      ],
    );
  }
  console.log(`  Imported ${docs.length} documents`);

  // Import chunks
  console.log("\nImporting chunks...");
  const rl = createInterface({
    input: createReadStream(chunksFile),
    crlfDelay: Infinity,
  });

  let chunkCount = 0;
  let skipped = 0;
  let batch: any[] = [];
  const BATCH_SIZE = 100;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line);

    // Skip orphaned chunks
    if (!docIds.has(chunk.doc_id)) {
      skipped++;
      continue;
    }

    batch.push(chunk);

    if (batch.length >= BATCH_SIZE) {
      await db.exec("BEGIN");
      for (const c of batch) {
        await db.query(
          `INSERT INTO chunks (id, doc_id, page, chunk_index, content)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [c.id, c.doc_id, c.page, c.chunk_index, c.content],
        );
      }
      await db.exec("COMMIT");
      chunkCount += batch.length;
      batch = [];

      if (chunkCount % 10000 === 0) {
        console.log(`  Progress: ${chunkCount} chunks...`);
      }
    }
  }

  // Final batch
  if (batch.length > 0) {
    await db.exec("BEGIN");
    for (const c of batch) {
      await db.query(
        `INSERT INTO chunks (id, doc_id, page, chunk_index, content)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [c.id, c.doc_id, c.page, c.chunk_index, c.content],
      );
    }
    await db.exec("COMMIT");
    chunkCount += batch.length;
  }

  console.log(`  Imported ${chunkCount} chunks`);
  if (skipped > 0) {
    console.log(`  Skipped ${skipped} orphaned chunks`);
  }

  // Import embeddings if available
  const embFile = join(backupDir, "backup-embeddings.jsonl");
  if (existsSync(embFile)) {
    console.log("\nImporting embeddings...");
    const embRl = createInterface({
      input: createReadStream(embFile),
      crlfDelay: Infinity,
    });

    let embCount = 0;
    let embBatch: any[] = [];

    for await (const line of embRl) {
      if (!line.trim()) continue;
      const emb = JSON.parse(line);
      embBatch.push(emb);

      if (embBatch.length >= 50) {
        await db.exec("BEGIN");
        for (const e of embBatch) {
          await db.query(
            `INSERT INTO embeddings (chunk_id, embedding)
             VALUES ($1, $2::vector)
             ON CONFLICT (chunk_id) DO NOTHING`,
            [e.chunk_id, e.embedding],
          );
        }
        await db.exec("COMMIT");
        embCount += embBatch.length;
        embBatch = [];

        if (embCount % 5000 === 0) {
          console.log(`  Progress: ${embCount} embeddings...`);
        }
      }
    }

    if (embBatch.length > 0) {
      await db.exec("BEGIN");
      for (const e of embBatch) {
        await db.query(
          `INSERT INTO embeddings (chunk_id, embedding)
           VALUES ($1, $2::vector)
           ON CONFLICT (chunk_id) DO NOTHING`,
          [e.chunk_id, e.embedding],
        );
      }
      await db.exec("COMMIT");
      embCount += embBatch.length;
    }

    console.log(`  Imported ${embCount} embeddings`);
  }

  // Verify
  const docResult = await db.query<{ c: number }>(
    "SELECT COUNT(*) as c FROM documents",
  );
  const chunkResult = await db.query<{ c: number }>(
    "SELECT COUNT(*) as c FROM chunks",
  );
  const embResult = await db.query<{ c: number }>(
    "SELECT COUNT(*) as c FROM embeddings",
  );

  console.log("\n=== Import Complete ===");
  console.log(`Documents:  ${docResult.rows[0]?.c}`);
  console.log(`Chunks:     ${chunkResult.rows[0]?.c}`);
  console.log(`Embeddings: ${embResult.rows[0]?.c}`);

  if (Number(embResult.rows[0]?.c) === 0) {
    console.log("\nEmbeddings need to be regenerated.");
    console.log("Run: bun run scripts/migration/regenerate-embeddings.ts");
  }

  console.log("\nVerify with: pdf-library stats");

  await db.close();
}

main().catch((e) => {
  console.error("Import failed:", e);
  process.exit(1);
});
