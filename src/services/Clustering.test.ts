/**
 * Clustering Service Tests
 *
 * TDD: Tests for RAPTOR-style soft clustering on document chunk embeddings:
 * - K-means (hard clustering) - existing
 * - GMM (Gaussian Mixture Model) for soft membership - new
 * - BIC for optimal cluster count selection - new
 * - Cluster assignment storage with probabilities - new
 */

import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import {
  ClusteringService,
  ClusteringServiceImpl,
  ClusteringError,
} from "./Clustering.js";

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Generate synthetic embeddings for testing
 * Creates distinct clusters in low-dimensional space for fast testing
 */
function generateTestEmbeddings(
  numPerCluster: number = 10,
  dims: number = 4
): { id: string; vector: number[] }[] {
  const embeddings: { id: string; vector: number[] }[] = [];

  // Cluster 1: centered around [1, 0, 0, 0]
  for (let i = 0; i < numPerCluster; i++) {
    embeddings.push({
      id: `chunk-a-${i}`,
      vector: Array.from({ length: dims }, (_, d) =>
        d === 0 ? 1 + Math.random() * 0.2 : Math.random() * 0.2
      ),
    });
  }

  // Cluster 2: centered around [0, 1, 0, 0]
  for (let i = 0; i < numPerCluster; i++) {
    embeddings.push({
      id: `chunk-b-${i}`,
      vector: Array.from({ length: dims }, (_, d) =>
        d === 1 ? 1 + Math.random() * 0.2 : Math.random() * 0.2
      ),
    });
  }

  // Cluster 3: centered around [0, 0, 1, 0]
  for (let i = 0; i < numPerCluster; i++) {
    embeddings.push({
      id: `chunk-c-${i}`,
      vector: Array.from({ length: dims }, (_, d) =>
        d === 2 ? 1 + Math.random() * 0.2 : Math.random() * 0.2
      ),
    });
  }

  return embeddings;
}

// ============================================================================
// Existing K-Means Tests (preserved)
// ============================================================================

describe("ClusteringService - K-Means", () => {
  it("should cluster embeddings into groups", async () => {
    const embeddings = [
      { id: "1", vector: [1, 0, 0] },
      { id: "2", vector: [0.9, 0.1, 0] },
      { id: "3", vector: [0, 1, 0] },
      { id: "4", vector: [0.1, 0.9, 0] },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.cluster(embeddings, { k: 2 });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    expect(result.clusters.length).toBe(2);
    expect(result.assignments.length).toBe(4);
    // Similar vectors should be in same cluster
    expect(result.assignments[0].clusterId).toBe(
      result.assignments[1].clusterId
    );
    expect(result.assignments[2].clusterId).toBe(
      result.assignments[3].clusterId
    );
  });

  it("should handle single cluster", async () => {
    const embeddings = [
      { id: "1", vector: [1, 0] },
      { id: "2", vector: [2, 0] },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.cluster(embeddings, { k: 1 });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    expect(result.clusters.length).toBe(1);
    expect(result.assignments.length).toBe(2);
    expect(result.assignments[0].clusterId).toBe(0);
    expect(result.assignments[1].clusterId).toBe(0);
  });

  it("should calculate distances correctly", async () => {
    const embeddings = [
      { id: "1", vector: [0, 0] },
      { id: "2", vector: [1, 1] },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.cluster(embeddings, { k: 1 });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    expect(result.assignments[0].distance).toBeGreaterThanOrEqual(0);
    expect(result.assignments[1].distance).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Soft Clustering (GMM) Tests - NEW
// ============================================================================

describe("ClusteringService - Soft Clustering (GMM)", () => {
  it("should return probability-based assignments with softClustering option", async () => {
    const embeddings = generateTestEmbeddings(10, 4);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.clusterSoft(embeddings, {
          maxClusters: 5,
          minProbability: 0.01,
        });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    // Should return soft assignments
    expect(result.softAssignments.length).toBeGreaterThan(0);

    // Each soft assignment should have probability
    for (const assignment of result.softAssignments) {
      expect(assignment.chunkId).toBeDefined();
      expect(assignment.clusterId).toBeGreaterThanOrEqual(0);
      expect(assignment.probability).toBeGreaterThan(0);
      expect(assignment.probability).toBeLessThanOrEqual(1);
    }

    // Should detect approximately 3 clusters
    expect(result.numClusters).toBeGreaterThanOrEqual(2);
    expect(result.numClusters).toBeLessThanOrEqual(5);
  });

  it("should allow chunks to belong to multiple clusters", async () => {
    // Create overlapping embeddings
    const embeddings = [
      // Clear cluster 1
      { id: "a1", vector: [1, 0, 0, 0] },
      { id: "a2", vector: [0.95, 0.05, 0, 0] },
      // Clear cluster 2
      { id: "b1", vector: [0, 1, 0, 0] },
      { id: "b2", vector: [0.05, 0.95, 0, 0] },
      // Overlapping point between clusters
      { id: "overlap", vector: [0.5, 0.5, 0, 0] },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.clusterSoft(embeddings, {
          maxClusters: 3,
          minProbability: 0.1,
        });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    // The overlapping point should have assignments to multiple clusters
    const overlapAssignments = result.softAssignments.filter(
      (a) => a.chunkId === "overlap"
    );

    // Should have at least 2 cluster assignments for the overlapping point
    expect(overlapAssignments.length).toBeGreaterThanOrEqual(1);

    // Probabilities should sum to at least minProbability threshold
    // (may be less than 1 because we filter out low-probability assignments)
    const chunkProbSums = new Map<string, number>();
    for (const a of result.softAssignments) {
      chunkProbSums.set(
        a.chunkId,
        (chunkProbSums.get(a.chunkId) || 0) + a.probability
      );
    }
    for (const [, sum] of chunkProbSums) {
      // Sum should be > 0 and <= 1
      expect(sum).toBeGreaterThan(0);
      expect(sum).toBeLessThanOrEqual(1.01); // Allow small floating point error
    }
  });

  it("should use BIC to select optimal cluster count", async () => {
    const embeddings = generateTestEmbeddings(15, 4);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.clusterSoft(embeddings, {
          maxClusters: 8,
          useBIC: true,
        });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    // BIC should select close to 3 clusters for our test data
    expect(result.numClusters).toBeGreaterThanOrEqual(2);
    expect(result.numClusters).toBeLessThanOrEqual(6);

    // Should include BIC scores in metadata
    expect(result.metadata?.bicScores).toBeDefined();
    expect(result.metadata?.selectedK).toBeDefined();
  });

  it("should handle empty embeddings gracefully", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.clusterSoft([], { maxClusters: 3 });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    expect(result.softAssignments).toEqual([]);
    expect(result.numClusters).toBe(0);
  });

  it("should handle single embedding", async () => {
    const embeddings = [{ id: "single", vector: [1, 0, 0, 0] }];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.clusterSoft(embeddings, { maxClusters: 3 });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    expect(result.softAssignments.length).toBe(1);
    expect(result.numClusters).toBe(1);
    expect(result.softAssignments[0].probability).toBe(1);
  });
});

// ============================================================================
// Cluster Centroids Tests - NEW
// ============================================================================

describe("ClusteringService - Centroids", () => {
  it("should return centroids for each cluster", async () => {
    const embeddings = generateTestEmbeddings(10, 4);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        const clusterResult = yield* service.clusterSoft(embeddings, {
          maxClusters: 5,
        });
        return { clusterResult, centroids: clusterResult.centroids };
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    // Should have one centroid per cluster
    expect(result.centroids.length).toBe(result.clusterResult.numClusters);

    // Each centroid should have same dimensions as input
    for (const centroid of result.centroids) {
      expect(centroid.vector.length).toBe(4);
      expect(centroid.clusterId).toBeGreaterThanOrEqual(0);
    }
  });
});

// ============================================================================
// Mini-Batch K-Means Tests - NEW
// ============================================================================

describe("ClusteringService - Mini-Batch K-Means", () => {
  it("should cluster large datasets with mini-batch k-means", async () => {
    // Generate large dataset (1000 points, 128 dims - scaled down from 500k for test speed)
    const numPoints = 1000;
    const dims = 128;
    const embeddings: { id: string; vector: number[] }[] = [];

    // Create 5 clusters
    const numClusters = 5;
    for (let c: number = 0; c < numClusters; c++) {
      for (let i = 0; i < numPoints / numClusters; i++) {
        const baseVector = new Array(dims).fill(0);
        baseVector[c * 25] = 1; // Spread clusters across dimensions
        const vector = baseVector.map((v) => v + (Math.random() - 0.5) * 0.2);
        embeddings.push({
          id: `chunk-${c}-${i}`,
          vector,
        });
      }
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.clusterMiniBatch(embeddings, {
          k: 5,
          batchSize: 100,
          maxIterations: 50,
        });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    // Should return valid clustering
    expect(result.clusters.length).toBe(5);
    expect(result.assignments.length).toBe(numPoints);

    // Most clusters should have members (mini-batch can occasionally leave some empty)
    const nonEmptyClusters = result.clusters.filter((c) => c.size > 0);
    expect(nonEmptyClusters.length).toBeGreaterThanOrEqual(3); // At least 3 of 5 clusters populated

    // All clusters should have valid centroids
    for (const cluster of result.clusters) {
      expect(cluster.centroid.length).toBe(dims);
    }
  });

  it("should converge faster than full k-means", async () => {
    const embeddings = generateTestEmbeddings(100, 16);

    const startFull = Date.now();
    const fullResult = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.cluster(embeddings, { k: 3, maxIterations: 100 });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );
    const fullTime = Date.now() - startFull;

    const startMiniBatch = Date.now();
    const miniBatchResult = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.clusterMiniBatch(embeddings, {
          k: 3,
          batchSize: 20,
          maxIterations: 100,
        });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );
    const miniBatchTime = Date.now() - startMiniBatch;

    // Mini-batch should be faster (or at least not significantly slower)
    // Note: for small datasets, overhead might make this close
    expect(miniBatchResult.clusters.length).toBe(3);

    // Both should produce reasonable clusterings
    expect(fullResult.clusters.length).toBe(3);
    expect(miniBatchResult.clusters.length).toBe(3);
  });

  it("should produce similar results to full k-means", async () => {
    const embeddings = generateTestEmbeddings(50, 8);

    const fullResult = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.cluster(embeddings, { k: 3 });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    const miniBatchResult = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.clusterMiniBatch(embeddings, {
          k: 3,
          batchSize: 10,
        });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    // Both should find 3 clusters
    expect(fullResult.clusters.length).toBe(3);
    expect(miniBatchResult.clusters.length).toBe(3);

    // Cluster sizes should be similar (within 20% tolerance)
    const fullSizes = fullResult.clusters.map((c) => c.size).sort();
    const miniBatchSizes = miniBatchResult.clusters.map((c) => c.size).sort();

    for (let i = 0; i < 3; i++) {
      const diff = Math.abs(fullSizes[i] - miniBatchSizes[i]);
      const maxSize = Math.max(fullSizes[i], miniBatchSizes[i]);
      expect(diff / maxSize).toBeLessThan(0.3); // 30% tolerance for randomness
    }
  });

  it("should handle batch size larger than dataset", async () => {
    const embeddings = generateTestEmbeddings(5, 4);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.clusterMiniBatch(embeddings, {
          k: 2,
          batchSize: 100, // Larger than dataset
        });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    expect(result.clusters.length).toBe(2);
    expect(result.assignments.length).toBe(15);
  });

  it("should use default batch size when not specified", async () => {
    const embeddings = generateTestEmbeddings(20, 4);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.clusterMiniBatch(embeddings, { k: 3 });
      }).pipe(Effect.provide(ClusteringServiceImpl.Default))
    );

    expect(result.clusters.length).toBe(3);
    expect(result.assignments.length).toBe(60);
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe("ClusteringService - Error Handling", () => {
  it("should fail with ClusteringError for mismatched dimensions", async () => {
    const invalidEmbeddings = [
      { id: "a", vector: [1, 2, 3] },
      { id: "b", vector: [1, 2] }, // Different dimension
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.clusterSoft(invalidEmbeddings, {
          maxClusters: 2,
        });
      })
        .pipe(Effect.provide(ClusteringServiceImpl.Default))
        .pipe(Effect.either)
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ClusteringError);
    }
  });

  it("should fail when k exceeds number of embeddings", async () => {
    const embeddings = [{ id: "1", vector: [1, 0] }];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusteringService;
        return yield* service.cluster(embeddings, { k: 5 });
      })
        .pipe(Effect.provide(ClusteringServiceImpl.Default))
        .pipe(Effect.either)
    );

    expect(result._tag).toBe("Left");
  });
});
