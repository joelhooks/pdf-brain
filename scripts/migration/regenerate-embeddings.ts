#!/usr/bin/env bun
/**
 * Regenerate embeddings for chunks using Ollama
 *
 * This script generates embeddings for chunks that don't have them.
 * Useful after migrating from PGlite 0.2.x where embeddings couldn't be exported.
 *
 * Prerequisites:
 *   - Ollama running: ollama serve
 *   - Embedding model: ollama pull mxbai-embed-large
 *
 * Usage:
 *   bun run scripts/migration/regenerate-embeddings.ts [db-path]
 *
 * Environment:
 *   OLLAMA_HOST - Ollama server URL (default: http://localhost:11434)
 *   OLLAMA_MODEL - Embedding model (default: mxbai-embed-large)
 */

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { join } from "path";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "mxbai-embed-large";
const BATCH_SIZE = 5; // Process 5 chunks at a time (balance speed vs memory)

const args = process.argv.slice(2);
const dbPath =
  args[0] || join(process.env.HOME!, "Documents/.pdf-library/library");

interface EmbeddingResponse {
  embedding: number[];
}

async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as EmbeddingResponse;
  return data.embedding;
}

async function checkOllama(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!response.ok) return false;

    // Test embedding generation
    const testEmb = await getEmbedding("test");
    console.log(
      `Ollama ready! Model: ${OLLAMA_MODEL}, Dimension: ${testEmb.length}`,
    );
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("=== Embedding Regeneration ===\n");
  console.log(`Database: ${dbPath}`);
  console.log(`Ollama: ${OLLAMA_HOST}`);
  console.log(`Model: ${OLLAMA_MODEL}\n`);

  // Check Ollama
  console.log("Checking Ollama...");
  if (!(await checkOllama())) {
    console.error("\nOllama not available. Make sure it's running:");
    console.error("  ollama serve");
    console.error(`  ollama pull ${OLLAMA_MODEL}`);
    process.exit(1);
  }

  // Connect to database
  console.log("\nConnecting to database...");
  const db = new PGlite(dbPath, { extensions: { vector } });
  await db.waitReady;

  // Count chunks needing embeddings
  const countResult = await db.query<{ c: string }>(`
    SELECT COUNT(*) as c FROM chunks c
    LEFT JOIN embeddings e ON e.chunk_id = c.id
    WHERE e.chunk_id IS NULL
  `);
  const total = parseInt(countResult.rows[0]?.c || "0");

  console.log(`Chunks needing embeddings: ${total}`);

  if (total === 0) {
    console.log("\nAll chunks have embeddings!");
    await db.close();
    return;
  }

  // Estimate time
  const estimatedMinutes = Math.ceil(total / 15 / 60); // ~15 embeddings/sec
  console.log(`Estimated time: ~${estimatedMinutes} minutes\n`);

  let processed = 0;
  let errors = 0;
  const startTime = Date.now();

  while (processed < total) {
    // Get batch of chunks without embeddings
    const batch = await db.query<{ id: string; content: string }>(`
      SELECT c.id, c.content FROM chunks c
      LEFT JOIN embeddings e ON e.chunk_id = c.id
      WHERE e.chunk_id IS NULL
      LIMIT ${BATCH_SIZE}
    `);

    if (batch.rows.length === 0) break;

    // Generate embeddings for batch
    for (const row of batch.rows) {
      try {
        const embedding = await getEmbedding(row.content);
        const vectorStr = `[${embedding.join(",")}]`;

        await db.query(
          `INSERT INTO embeddings (chunk_id, embedding)
           VALUES ($1, $2::vector)
           ON CONFLICT (chunk_id) DO NOTHING`,
          [row.id, vectorStr],
        );

        processed++;
      } catch (e) {
        errors++;
        console.error(`Error on chunk ${row.id}: ${e}`);
      }
    }

    // Progress update every 100 chunks
    if (processed % 100 === 0 || processed === total) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const remaining = (total - processed) / rate;
      const pct = ((processed / total) * 100).toFixed(1);

      console.log(
        `Progress: ${processed}/${total} (${pct}%) | ` +
          `${rate.toFixed(1)}/s | ` +
          `ETA: ${Math.ceil(remaining / 60)}min`,
      );
    }
  }

  // Final stats
  const embResult = await db.query<{ c: string }>(
    "SELECT COUNT(*) as c FROM embeddings",
  );
  const finalCount = parseInt(embResult.rows[0]?.c || "0");

  console.log("\n=== Complete ===");
  console.log(`Embeddings generated: ${processed}`);
  console.log(`Total embeddings: ${finalCount}`);
  console.log(`Errors: ${errors}`);
  console.log(
    `Time: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`,
  );

  await db.close();
}

main().catch((e) => {
  console.error("Regeneration failed:", e);
  process.exit(1);
});
