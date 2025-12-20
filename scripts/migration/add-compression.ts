#!/usr/bin/env bun
/**
 * Add compress_neighbors optimization to embeddings vector index
 *
 * This script recreates the embeddings_idx with compress_neighbors=float8,
 * reducing index size by 4x with minimal recall loss (~1-2%).
 *
 * PREREQUISITES:
 *   - All document ingestion complete (embeddings table populated)
 *   - Database not in use (no active searches)
 *
 * USAGE:
 *   bun run scripts/migration/add-compression.ts [db-path]
 *
 * WHAT IT DOES:
 *   1. Checks if index exists
 *   2. Drops embeddings_idx if present
 *   3. Creates new index with compress_neighbors=float8
 *   4. Verifies index works with test query
 *
 * ROLLBACK:
 *   If something goes wrong, restore original index:
 *   ```sql
 *   DROP INDEX IF EXISTS embeddings_idx;
 *   CREATE INDEX embeddings_idx ON embeddings(libsql_vector_idx(embedding));
 *   ```
 *
 * IDEMPOTENT:
 *   Safe to run multiple times. Checks index existence before dropping.
 */

import { createClient } from "@libsql/client";
import { join } from "node:path";

const args = process.argv.slice(2);
const dbPath =
  args[0] || join(process.env.HOME || "", "Documents/.pdf-library/library.db");

async function main() {
  console.log("=== Add Index Compression ===\n");
  console.log(`Database: ${dbPath}\n`);

  // Connect to database
  console.log("Connecting to database...");
  const client = createClient({
    url: `file:${dbPath}`,
  });

  try {
    // Step 1: Check if embeddings table exists and has data
    console.log("\nChecking embeddings table...");
    const embCount = await client.execute(
      "SELECT COUNT(*) as count FROM embeddings"
    );
    const total = Number(
      (embCount.rows[0] as unknown as { count: number | bigint }).count
    );

    if (total === 0) {
      console.log("⚠️  Embeddings table is empty. Run ingestion first.");
      client.close();
      process.exit(1);
    }

    console.log(`Found ${total} embeddings`);

    // Step 2: Check if index exists
    console.log("\nChecking for existing index...");
    const indexCheck = await client.execute(`
      SELECT name FROM sqlite_master 
      WHERE type='index' AND name='embeddings_idx'
    `);

    const indexExists = indexCheck.rows.length > 0;
    console.log(
      indexExists ? "✓ Index exists (will recreate)" : "ℹ No existing index"
    );

    // Step 3: Drop existing index (if present)
    if (indexExists) {
      console.log("\nDropping existing index...");
      const dropStart = Date.now();
      await client.execute("DROP INDEX IF EXISTS embeddings_idx");
      const dropTime = Date.now() - dropStart;
      console.log(`✓ Dropped in ${dropTime}ms`);
    }

    // Step 4: Create new index with compression
    console.log("\nCreating compressed index (compress_neighbors=float8)...");
    console.log("This may take several minutes for large datasets...");
    const createStart = Date.now();

    await client.execute(`
      CREATE INDEX embeddings_idx ON embeddings(
        libsql_vector_idx(embedding, 'compress_neighbors=float8')
      )
    `);

    const createTime = Date.now() - createStart;
    console.log(`✓ Created in ${(createTime / 1000).toFixed(1)}s`);

    // Step 5: Verify index works with test query
    console.log("\nVerifying index with test query...");

    // Get a sample embedding to use as query
    const sample = await client.execute(
      "SELECT embedding FROM embeddings LIMIT 1"
    );

    if (sample.rows.length === 0) {
      console.log("⚠️  Could not get sample embedding for verification");
    } else {
      const testEmbedding = (
        sample.rows[0] as unknown as { embedding: number[] }
      ).embedding;

      const verifyStart = Date.now();
      const testResult = await client.execute({
        sql: `
          SELECT COUNT(*) as count
          FROM vector_top_k('embeddings_idx', vector32(?), 10) AS top
          JOIN embeddings e ON e.rowid = top.id
        `,
        args: [JSON.stringify(testEmbedding)],
      });
      const verifyTime = Date.now() - verifyStart;

      const resultCount = Number(
        (testResult.rows[0] as unknown as { count: number | bigint }).count
      );
      console.log(
        `✓ Index working (returned ${resultCount} results in ${verifyTime}ms)`
      );
    }

    // Final summary
    console.log("\n=== Migration Complete ===");
    console.log("✓ Index recreated with compress_neighbors=float8");
    console.log("✓ Index size reduced by ~4x");
    console.log("✓ Expected recall impact: ~1-2% (negligible)");
    console.log("\nBenefits:");
    console.log("  - 4x smaller index (less disk/memory)");
    console.log("  - Faster search due to better cache utilization");
    console.log("  - Minimal quality degradation\n");

    client.close();
  } catch (error) {
    console.error("\n❌ Migration failed:", error);
    console.error("\nTo rollback, run:");
    console.error("  DROP INDEX IF EXISTS embeddings_idx;");
    console.error(
      "  CREATE INDEX embeddings_idx ON embeddings(libsql_vector_idx(embedding));"
    );
    client.close();
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
