#!/usr/bin/env bun
/**
 * Backfill summaries for documents missing them
 *
 * Uses anthropic/claude-haiku-4-5 via Vercel AI Gateway for speed + cost efficiency
 *
 * Usage:
 *   bun run scripts/migration/backfill-summaries.ts [--limit N] [--dry-run]
 */

import { createClient } from "@libsql/client";
import { generateObject } from "ai";
import { z } from "zod";

// ============================================================================
// Config
// ============================================================================

const DB_PATH = process.env.PDF_LIBRARY_PATH
  ? `${process.env.PDF_LIBRARY_PATH}/library.db`
  : `${process.env.HOME}/Documents/.pdf-library/library.db`;

const MODEL = "anthropic/claude-haiku-4-5";
const BATCH_SIZE = 10;
const DELAY_MS = 500; // Rate limiting between batches

// ============================================================================
// Setup
// ============================================================================

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1]) : undefined;

const client = createClient({ url: `file:${DB_PATH}` });

console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║           📝 BACKFILL SUMMARIES                                   ║
╠═══════════════════════════════════════════════════════════════════╣
║  Model: ${MODEL.padEnd(54)}║
║  Database: ${DB_PATH.slice(-50).padEnd(51)}║
║  Mode: ${(dryRun ? "DRY RUN" : "LIVE").padEnd(55)}║
${
  limit ? `║  Limit: ${String(limit).padEnd(54)}║\n` : ""
}╚═══════════════════════════════════════════════════════════════════╝
`);

// ============================================================================
// Find documents needing summaries
// ============================================================================

interface DocRow {
  id: string;
  title: string;
  path: string;
  metadata: string;
}

async function getDocsNeedingSummaries(): Promise<DocRow[]> {
  const result = await client.execute(`
    SELECT id, title, path, metadata 
    FROM documents 
    WHERE metadata = '{}' 
       OR metadata IS NULL 
       OR json_extract(metadata, '$.summary') IS NULL
    ORDER BY added_at DESC
    ${limit ? `LIMIT ${limit}` : ""}
  `);

  return result.rows as unknown as DocRow[];
}

async function getFirstChunks(docId: string, maxChunks = 5): Promise<string> {
  const result = await client.execute({
    sql: `SELECT content FROM chunks WHERE doc_id = ? ORDER BY chunk_index LIMIT ?`,
    args: [docId, maxChunks],
  });

  return result.rows.map((r) => r.content as string).join("\n\n");
}

async function updateMetadata(
  docId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await client.execute({
    sql: `UPDATE documents SET metadata = ? WHERE id = ?`,
    args: [JSON.stringify(metadata), docId],
  });
}

// ============================================================================
// Generate summary
// ============================================================================

const SummarySchema = z.object({
  summary: z
    .string()
    .describe(
      "2-3 sentences describing the document's content and significance"
    ),
  documentType: z.enum([
    "paper",
    "book",
    "article",
    "tutorial",
    "documentation",
    "presentation",
    "report",
    "other",
  ]),
  category: z.enum([
    "education",
    "programming",
    "design",
    "business",
    "meta",
    "other",
  ]),
});

type Summary = z.infer<typeof SummarySchema>;

async function generateSummary(
  title: string,
  content: string
): Promise<Summary> {
  const { object } = await generateObject({
    model: MODEL,
    schema: SummarySchema,
    prompt: `Analyze this document and extract metadata.

Document title: ${title}

Content (first few sections):
${content.slice(0, 6000)}`,
  });

  return object;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const docs = await getDocsNeedingSummaries();
  console.log(`Found ${docs.length} documents needing summaries\n`);

  if (docs.length === 0) {
    console.log("✓ All documents have summaries!");
    return;
  }

  let processed = 0;
  let errors = 0;
  let skipped = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);

    for (const doc of batch) {
      processed++;
      const progress = `[${processed}/${docs.length}]`;

      try {
        // Get content from chunks
        const content = await getFirstChunks(doc.id);

        if (!content || content.length < 100) {
          console.log(`${progress} ⏭️  ${doc.title.slice(0, 50)} - no content`);
          skipped++;
          continue;
        }

        console.log(`${progress} 📝 ${doc.title.slice(0, 50)}...`);

        if (dryRun) {
          console.log(`       Would generate summary for: ${doc.title}`);
          continue;
        }

        // Generate summary
        const result = await generateSummary(doc.title, content);

        // Merge with existing metadata
        const existingMetadata = doc.metadata ? JSON.parse(doc.metadata) : {};
        const newMetadata = {
          ...existingMetadata,
          summary: result.summary,
          documentType: result.documentType,
          category: result.category,
          enrichedAt: new Date().toISOString(),
          enrichmentProvider: "anthropic/claude-haiku-4-5",
        };

        await updateMetadata(doc.id, newMetadata);

        console.log(`       ✓ "${result.summary.slice(0, 80)}..."`);
      } catch (error) {
        errors++;
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          `${progress} ❌ ${doc.title.slice(0, 40)} - ${msg.slice(0, 50)}`
        );
      }
    }

    // Rate limiting between batches
    if (i + BATCH_SIZE < docs.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║  COMPLETE                                                         ║
╠═══════════════════════════════════════════════════════════════════╣
║  Processed: ${String(processed).padEnd(52)}║
║  Skipped:   ${String(skipped).padEnd(52)}║
║  Errors:    ${String(errors).padEnd(52)}║
║  Success:   ${String(processed - errors - skipped).padEnd(52)}║
╚═══════════════════════════════════════════════════════════════════╝
`);
}

main()
  .catch(console.error)
  .finally(() => client.close());
