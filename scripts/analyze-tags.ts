#!/usr/bin/env bun

/**
 * Analyze tag distribution in the library database
 * Outputs statistics useful for designing partial index strategy
 */

import { createClient, type ResultSet } from "@libsql/client";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(
  os.homedir(),
  "Documents",
  ".pdf-library",
  "library.db"
);

interface TagStats {
  tag: string;
  documentCount: number;
  percentage: number;
}

async function analyzeTagDistribution() {
  const client = createClient({
    url: `file:${DB_PATH}`,
  });

  try {
    // Get total document count
    const totalResult = await client.execute(
      "SELECT COUNT(*) as count FROM documents"
    );
    const totalDocs = Number(
      (totalResult.rows[0] as unknown as { count: number }).count
    );

    console.log(`\n📊 Database Statistics`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    console.log(`Total Documents: ${totalDocs}`);

    // Get all documents with their tags
    const docsResult = await client.execute("SELECT tags FROM documents");
    const allTags = new Map<string, number>();

    // Count tag occurrences
    for (const row of docsResult.rows) {
      const tags = JSON.parse(
        (row as unknown as { tags: string }).tags
      ) as string[];
      for (const tag of tags) {
        allTags.set(tag, (allTags.get(tag) || 0) + 1);
      }
    }

    // Calculate statistics
    const tagStats: TagStats[] = Array.from(allTags.entries())
      .map(([tag, count]) => ({
        tag,
        documentCount: count,
        percentage: (count / totalDocs) * 100,
      }))
      .sort((a, b) => b.documentCount - a.documentCount);

    // Display tag distribution
    console.log(`\nTotal Unique Tags: ${tagStats.length}`);
    console.log(`\n📈 Tag Distribution (Top 20)\n`);

    const top20 = tagStats.slice(0, 20);
    for (const stat of top20) {
      const bar = "█".repeat(Math.floor(stat.percentage / 2));
      console.log(
        `${stat.tag.padEnd(30)} ${stat.documentCount
          .toString()
          .padStart(5)} docs  ${stat.percentage
          .toFixed(1)
          .padStart(5)}%  ${bar}`
      );
    }

    // Analyze tag usage patterns
    console.log(`\n\n📊 Tag Usage Patterns\n`);

    const high = tagStats.filter((t) => t.percentage >= 20);
    const medium = tagStats.filter(
      (t) => t.percentage >= 5 && t.percentage < 20
    );
    const low = tagStats.filter((t) => t.percentage >= 1 && t.percentage < 5);
    const rare = tagStats.filter((t) => t.percentage < 1);

    console.log(`High Usage (≥20%):      ${high.length} tags`);
    if (high.length > 0) {
      console.log(`  ${high.map((t) => t.tag).join(", ")}`);
    }

    console.log(`\nMedium Usage (5-20%):   ${medium.length} tags`);
    if (medium.length > 0) {
      console.log(`  ${medium.map((t) => t.tag).join(", ")}`);
    }

    console.log(`\nLow Usage (1-5%):       ${low.length} tags`);
    if (low.length > 0) {
      console.log(`  ${low.map((t) => t.tag).join(", ")}`);
    }

    console.log(`\nRare Usage (<1%):       ${rare.length} tags`);

    // Documents without tags
    const noTagsResult = await client.execute(
      "SELECT COUNT(*) as count FROM documents WHERE tags = '[]'"
    );
    const noTags = Number(
      (noTagsResult.rows[0] as unknown as { count: number }).count
    );
    console.log(
      `\nDocuments with no tags: ${noTags} (${(
        (noTags / totalDocs) *
        100
      ).toFixed(1)}%)`
    );

    // Multiple tags analysis
    const multiTagDocs = docsResult.rows.filter(
      (row) => JSON.parse((row as unknown as { tags: string }).tags).length > 1
    );
    console.log(
      `Documents with 2+ tags:  ${multiTagDocs.length} (${(
        (multiTagDocs.length / totalDocs) *
        100
      ).toFixed(1)}%)`
    );

    // Co-occurrence analysis (top 5 tag pairs)
    const tagPairs = new Map<string, number>();
    for (const row of docsResult.rows) {
      const tags = JSON.parse(
        (row as unknown as { tags: string }).tags
      ) as string[];
      if (tags.length < 2) continue;

      const sortedTags = [...tags].sort();
      for (let i = 0; i < sortedTags.length; i++) {
        for (let j = i + 1; j < sortedTags.length; j++) {
          const pair = `${sortedTags[i]} + ${sortedTags[j]}`;
          tagPairs.set(pair, (tagPairs.get(pair) || 0) + 1);
        }
      }
    }

    const topPairs = Array.from(tagPairs.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (topPairs.length > 0) {
      console.log(`\n\n📊 Most Common Tag Combinations (Top 10)\n`);
      for (const [pair, count] of topPairs) {
        console.log(`${pair.padEnd(50)} ${count} docs`);
      }
    }

    console.log(`\n`);
  } catch (error) {
    console.error("Error analyzing tags:", error);
    process.exit(1);
  } finally {
    client.close();
  }
}

analyzeTagDistribution();
