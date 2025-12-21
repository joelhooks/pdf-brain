#!/usr/bin/env bun
/**
 * Backfill document_concepts from existing tags
 *
 * Tags are stored as the leaf part of concept IDs (e.g., "instructional-design")
 * Concepts are stored with category prefix (e.g., "education/instructional-design")
 *
 * This script:
 * 1. Builds a mapping from normalized tag -> concept ID
 * 2. For each document, matches its tags to concepts
 * 3. Inserts into document_concepts join table
 *
 * Usage:
 *   bun run scripts/migration/backfill-document-concepts.ts
 */

import { createClient } from "@libsql/client";
import { join } from "path";

const dbPath = `file:${join(
  process.env.HOME!,
  "Documents/.pdf-library/library.db"
)}`;

interface Concept {
  id: string;
  pref_label: string;
  alt_labels: string;
}

interface Document {
  id: string;
  title: string;
  tags: string;
}

function normalizeTag(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function main() {
  console.log("=== Backfill document_concepts ===\n");
  console.log(`Database: ${dbPath}\n`);

  const client = createClient({ url: dbPath });

  // Step 1: Build tag -> concept mapping
  console.log("Building tag -> concept mapping...");

  const conceptsResult = await client.execute(
    "SELECT id, pref_label, alt_labels FROM concepts"
  );

  const tagToConcept = new Map<string, string>();
  let conceptCount = 0;

  for (const row of conceptsResult.rows) {
    const concept = row as unknown as Concept;
    conceptCount++;

    // Extract leaf from concept ID (e.g., "education/instructional-design" -> "instructional-design")
    const leaf = concept.id.includes("/")
      ? concept.id.split("/").pop()!
      : concept.id;

    // Map normalized leaf to concept ID
    tagToConcept.set(normalizeTag(leaf), concept.id);

    // Also map normalized pref_label
    tagToConcept.set(normalizeTag(concept.pref_label), concept.id);

    // Map alt_labels
    const altLabels: string[] = JSON.parse(concept.alt_labels || "[]");
    for (const alt of altLabels) {
      tagToConcept.set(normalizeTag(alt), concept.id);
    }
  }

  console.log(`  ${conceptCount} concepts loaded`);
  console.log(`  ${tagToConcept.size} tag mappings created\n`);

  // Step 2: Get all documents with tags
  console.log("Processing documents...");

  const docsResult = await client.execute(
    "SELECT id, title, tags FROM documents"
  );

  let docsProcessed = 0;
  let linksCreated = 0;
  let docsWithConcepts = 0;

  for (const row of docsResult.rows) {
    const doc = row as unknown as Document;
    const tags: string[] = JSON.parse(doc.tags || "[]");

    if (tags.length === 0) continue;

    const matchedConcepts = new Set<string>();

    for (const tag of tags) {
      const normalizedTag = normalizeTag(tag);
      const conceptId = tagToConcept.get(normalizedTag);
      if (conceptId) {
        matchedConcepts.add(conceptId);
      }
    }

    if (matchedConcepts.size > 0) {
      docsWithConcepts++;

      // Insert into document_concepts
      for (const conceptId of matchedConcepts) {
        try {
          await client.execute({
            sql: `INSERT INTO document_concepts (doc_id, concept_id, confidence, source)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT (doc_id, concept_id) DO NOTHING`,
            args: [doc.id, conceptId, 0.8, "backfill"],
          });
          linksCreated++;
        } catch (e) {
          // Ignore constraint violations (concept doesn't exist)
        }
      }
    }

    docsProcessed++;
    if (docsProcessed % 100 === 0) {
      console.log(`  Processed ${docsProcessed} documents...`);
    }
  }

  // Step 3: Summary
  const finalCount = await client.execute(
    "SELECT COUNT(doc_id) as count FROM document_concepts"
  );
  const totalLinks = Number((finalCount.rows[0] as any).count || 0);

  console.log("\n=== Complete ===");
  console.log(`Documents processed: ${docsProcessed}`);
  console.log(`Documents with concepts: ${docsWithConcepts}`);
  console.log(`Links created: ${linksCreated}`);
  console.log(`Total document_concepts: ${totalLinks}`);

  // Show sample
  console.log("\nSample links:");
  const sample = await client.execute(`
    SELECT d.title, c.pref_label 
    FROM document_concepts dc
    JOIN documents d ON d.id = dc.doc_id
    JOIN concepts c ON c.id = dc.concept_id
    LIMIT 10
  `);

  for (const row of sample.rows) {
    console.log(`  "${row.title}" -> ${row.pref_label}`);
  }

  client.close();
}

main().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
