#!/usr/bin/env -S bun run
/**
 * Benchmark Vector Search Performance
 *
 * Measures search latency and memory usage for libSQL vector search.
 * Outputs JSON results for comparison after migration.
 */

import { Effect, Layer } from "effect";
import { Database } from "../src/services/Database.js";
import { LibSQLDatabase } from "../src/services/LibSQLDatabase.js";
import { Ollama, OllamaLive } from "../src/services/Ollama.js";
import { LibraryConfig, SearchOptions } from "../src/types.js";

// ============================================================================
// Types
// ============================================================================

interface LatencyStats {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

interface SearchBenchmark {
  k: number;
  latency_ms: LatencyStats;
  results_per_query: number;
}

interface BenchmarkResults {
  timestamp: string;
  num_queries: number;
  memory_usage_mb: {
    before: number;
    after: number;
    delta: number;
  };
  benchmarks: SearchBenchmark[];
  database_stats: {
    documents: number;
    chunks: number;
    embeddings: number;
  };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Calculate percentile from sorted array
 */
function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((sorted.length * p) / 100) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Calculate latency statistics from measurements
 */
function calculateStats(latencies: number[]): LatencyStats {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    avg: latencies.reduce((sum, val) => sum + val, 0) / latencies.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * Get current memory usage in MB
 */
function getMemoryUsageMB(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed / 1024 / 1024;
}

/**
 * Generate sample text for creating query embeddings
 */
function generateQueryText(index: number): string {
  const topics = [
    "machine learning algorithms and neural networks",
    "database optimization and indexing strategies",
    "software architecture patterns and design principles",
    "web performance optimization techniques",
    "cloud infrastructure and deployment strategies",
    "security best practices and vulnerability assessment",
    "user interface design and accessibility",
    "data structures and algorithm complexity",
    "distributed systems and microservices architecture",
    "testing methodologies and quality assurance",
  ];

  return topics[index % topics.length];
}

// ============================================================================
// Benchmark Logic
// ============================================================================

const program = Effect.gen(function* () {
  console.error("Vector Search Benchmark");
  console.error("======================\n");

  const db = yield* Database;
  const ollama = yield* Ollama;

  // Get database stats
  console.error("Fetching database statistics...");
  const stats = yield* db.getStats();
  console.error(`Documents: ${stats.documents}`);
  console.error(`Chunks: ${stats.chunks}`);
  console.error(`Embeddings: ${stats.embeddings}\n`);

  // Generate query embeddings
  const numQueries = 100;
  console.error(`Generating ${numQueries} query embeddings...`);

  const queryTexts = Array.from({ length: numQueries }, (_, i) =>
    generateQueryText(i)
  );

  const queryEmbeddings = yield* ollama.embedBatch(queryTexts, 10);
  console.error(`Generated ${queryEmbeddings.length} embeddings\n`);

  // K values to test
  const kValues = [5, 10, 20, 50];

  // Measure memory before benchmarks
  const memoryBefore = getMemoryUsageMB();

  const benchmarks: SearchBenchmark[] = [];

  // Run benchmarks for each k value
  for (const k of kValues) {
    console.error(`Benchmarking k=${k}...`);

    const latencies: number[] = [];
    let totalResults = 0;

    // Run searches for all queries
    for (const queryEmbedding of queryEmbeddings) {
      const start = performance.now();

      const results = yield* db.vectorSearch(
        queryEmbedding,
        new SearchOptions({ limit: k })
      );

      const end = performance.now();
      latencies.push(end - start);
      totalResults += results.length;
    }

    const latencyStats = calculateStats(latencies);

    benchmarks.push({
      k,
      latency_ms: latencyStats,
      results_per_query: totalResults / numQueries,
    });

    console.error(`  Avg: ${latencyStats.avg.toFixed(2)}ms`);
    console.error(`  P50: ${latencyStats.p50.toFixed(2)}ms`);
    console.error(`  P95: ${latencyStats.p95.toFixed(2)}ms`);
    console.error(`  P99: ${latencyStats.p99.toFixed(2)}ms`);
    console.error(
      `  Results/query: ${(totalResults / numQueries).toFixed(1)}\n`
    );
  }

  // Measure memory after benchmarks
  const memoryAfter = getMemoryUsageMB();

  // Construct results
  const results: BenchmarkResults = {
    timestamp: new Date().toISOString(),
    num_queries: numQueries,
    memory_usage_mb: {
      before: Math.round(memoryBefore * 100) / 100,
      after: Math.round(memoryAfter * 100) / 100,
      delta: Math.round((memoryAfter - memoryBefore) * 100) / 100,
    },
    benchmarks,
    database_stats: {
      documents: stats.documents,
      chunks: stats.chunks,
      embeddings: stats.embeddings,
    },
  };

  // Output JSON to stdout
  console.log(JSON.stringify(results, null, 2));

  console.error("\n✅ Benchmark complete!");
});

// ============================================================================
// Main
// ============================================================================

const config = LibraryConfig.fromEnv();

const MainLayer = Layer.mergeAll(
  LibSQLDatabase.make({ url: `file:${config.dbPath}` }),
  OllamaLive
);

Effect.runPromise(program.pipe(Effect.provide(MainLayer)))
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Benchmark failed:", error);
    process.exit(1);
  });
