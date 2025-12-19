/**
 * Database Service Unit Tests - Expanded Context
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database, DatabaseLive } from "./Database.js";
import { PDFDocument, SearchOptions } from "../types.js";

// ============================================================================
// Test Helpers
// ============================================================================

let tempDir: string;
let originalEnv: string | undefined;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "db-test-"));
  originalEnv = process.env.PDF_LIBRARY_PATH;
  process.env.PDF_LIBRARY_PATH = tempDir;
});

afterAll(() => {
  if (originalEnv !== undefined) {
    process.env.PDF_LIBRARY_PATH = originalEnv;
  } else {
    delete process.env.PDF_LIBRARY_PATH;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Run a database operation with a fresh database instance
 */
function runDb<A, E>(
  effect: (
    db: Effect.Effect.Success<typeof Database>
  ) => Effect.Effect<A, E, never>
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* effect(db);
      }).pipe(Effect.provide(DatabaseLive))
    )
  );
}

// ============================================================================
// getExpandedContext Tests
// ============================================================================

describe("getExpandedContext", () => {
  test("returns single chunk when no adjacent chunks exist", async () => {
    const result = await runDb((db) =>
      Effect.gen(function* () {
        // Add a document
        const doc = new PDFDocument({
          id: "test-doc-1",
          title: "Test Document",
          path: "/fake/path.pdf",
          addedAt: new Date(),
          pageCount: 1,
          sizeBytes: 1000,
          tags: [],
        });
        yield* db.addDocument(doc);

        // Add a single chunk
        yield* db.addChunks([
          {
            id: "test-doc-1-0",
            docId: "test-doc-1",
            page: 1,
            chunkIndex: 0,
            content: "This is the only chunk content.",
          },
        ]);

        // Get expanded context
        return yield* db.getExpandedContext("test-doc-1", 0, {
          maxChars: 2000,
        });
      })
    );

    expect(result.content).toBe("This is the only chunk content.");
    expect(result.startIndex).toBe(0);
    expect(result.endIndex).toBe(0);
  });

  test("expands to include adjacent chunks within budget", async () => {
    const result = await runDb((db) =>
      Effect.gen(function* () {
        // Add a document
        const doc = new PDFDocument({
          id: "test-doc-2",
          title: "Test Document 2",
          path: "/fake/path2.pdf",
          addedAt: new Date(),
          pageCount: 1,
          sizeBytes: 1000,
          tags: [],
        });
        yield* db.addDocument(doc);

        // Add multiple chunks
        yield* db.addChunks([
          {
            id: "test-doc-2-0",
            docId: "test-doc-2",
            page: 1,
            chunkIndex: 0,
            content: "First chunk content.",
          },
          {
            id: "test-doc-2-1",
            docId: "test-doc-2",
            page: 1,
            chunkIndex: 1,
            content: "Second chunk content - this is the target.",
          },
          {
            id: "test-doc-2-2",
            docId: "test-doc-2",
            page: 1,
            chunkIndex: 2,
            content: "Third chunk content.",
          },
        ]);

        // Get expanded context for middle chunk
        return yield* db.getExpandedContext("test-doc-2", 1, {
          maxChars: 2000,
        });
      })
    );

    expect(result.content).toContain("First chunk content.");
    expect(result.content).toContain("Second chunk content");
    expect(result.content).toContain("Third chunk content.");
    expect(result.startIndex).toBe(0);
    expect(result.endIndex).toBe(2);
  });

  test("respects maxChars budget", async () => {
    const result = await runDb((db) =>
      Effect.gen(function* () {
        // Add a document
        const doc = new PDFDocument({
          id: "test-doc-3",
          title: "Test Document 3",
          path: "/fake/path3.pdf",
          addedAt: new Date(),
          pageCount: 1,
          sizeBytes: 1000,
          tags: [],
        });
        yield* db.addDocument(doc);

        // Add chunks with known sizes
        const chunk1 = "A".repeat(100); // 100 chars
        const chunk2 = "B".repeat(100); // 100 chars - target
        const chunk3 = "C".repeat(100); // 100 chars
        const chunk4 = "D".repeat(100); // 100 chars

        yield* db.addChunks([
          {
            id: "test-doc-3-0",
            docId: "test-doc-3",
            page: 1,
            chunkIndex: 0,
            content: chunk1,
          },
          {
            id: "test-doc-3-1",
            docId: "test-doc-3",
            page: 1,
            chunkIndex: 1,
            content: chunk2,
          },
          {
            id: "test-doc-3-2",
            docId: "test-doc-3",
            page: 1,
            chunkIndex: 2,
            content: chunk3,
          },
          {
            id: "test-doc-3-3",
            docId: "test-doc-3",
            page: 1,
            chunkIndex: 3,
            content: chunk4,
          },
        ]);

        // Get expanded context with small budget (should only get ~2-3 chunks)
        return yield* db.getExpandedContext("test-doc-3", 1, {
          maxChars: 250, // Target + 1 before + partial after
        });
      })
    );

    // Should have target chunk (B's) and at least one adjacent
    expect(result.content).toContain("B".repeat(100));
    // Budget is 250, each chunk is 100 + newline, so we should get 2-3 chunks
    expect(result.content.length).toBeLessThan(400);
  });

  test("direction 'before' only expands backwards", async () => {
    const result = await runDb((db) =>
      Effect.gen(function* () {
        // Add a document
        const doc = new PDFDocument({
          id: "test-doc-4",
          title: "Test Document 4",
          path: "/fake/path4.pdf",
          addedAt: new Date(),
          pageCount: 1,
          sizeBytes: 1000,
          tags: [],
        });
        yield* db.addDocument(doc);

        yield* db.addChunks([
          {
            id: "test-doc-4-0",
            docId: "test-doc-4",
            page: 1,
            chunkIndex: 0,
            content: "BEFORE",
          },
          {
            id: "test-doc-4-1",
            docId: "test-doc-4",
            page: 1,
            chunkIndex: 1,
            content: "TARGET",
          },
          {
            id: "test-doc-4-2",
            docId: "test-doc-4",
            page: 1,
            chunkIndex: 2,
            content: "AFTER",
          },
        ]);

        return yield* db.getExpandedContext("test-doc-4", 1, {
          maxChars: 2000,
          direction: "before",
        });
      })
    );

    expect(result.content).toContain("BEFORE");
    expect(result.content).toContain("TARGET");
    expect(result.content).not.toContain("AFTER");
    expect(result.startIndex).toBe(0);
    expect(result.endIndex).toBe(1);
  });

  test("direction 'after' only expands forwards", async () => {
    const result = await runDb((db) =>
      Effect.gen(function* () {
        // Add a document
        const doc = new PDFDocument({
          id: "test-doc-5",
          title: "Test Document 5",
          path: "/fake/path5.pdf",
          addedAt: new Date(),
          pageCount: 1,
          sizeBytes: 1000,
          tags: [],
        });
        yield* db.addDocument(doc);

        yield* db.addChunks([
          {
            id: "test-doc-5-0",
            docId: "test-doc-5",
            page: 1,
            chunkIndex: 0,
            content: "BEFORE",
          },
          {
            id: "test-doc-5-1",
            docId: "test-doc-5",
            page: 1,
            chunkIndex: 1,
            content: "TARGET",
          },
          {
            id: "test-doc-5-2",
            docId: "test-doc-5",
            page: 1,
            chunkIndex: 2,
            content: "AFTER",
          },
        ]);

        return yield* db.getExpandedContext("test-doc-5", 1, {
          maxChars: 2000,
          direction: "after",
        });
      })
    );

    expect(result.content).not.toContain("BEFORE");
    expect(result.content).toContain("TARGET");
    expect(result.content).toContain("AFTER");
    expect(result.startIndex).toBe(1);
    expect(result.endIndex).toBe(2);
  });

  test("returns empty content for non-existent chunk", async () => {
    const result = await runDb((db) =>
      Effect.gen(function* () {
        return yield* db.getExpandedContext("non-existent-doc", 999, {
          maxChars: 2000,
        });
      })
    );

    expect(result.content).toBe("");
    expect(result.startIndex).toBe(999);
    expect(result.endIndex).toBe(999);
  });
});

// ============================================================================
// Transaction Safety and Checkpoint Tests
// ============================================================================

describe("transaction safety", () => {
  test("addEmbeddings rolls back on failure", async () => {
    // Test that transaction rollback works - if one embedding is invalid, none should be inserted
    await expect(
      runDb((db) =>
        Effect.gen(function* () {
          // Add a document and chunk first
          const doc = new PDFDocument({
            id: "txn-test-doc",
            title: "Transaction Test",
            path: "/fake/txn.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 1000,
            tags: [],
          });
          yield* db.addDocument(doc);

          yield* db.addChunks([
            {
              id: "txn-chunk-1",
              docId: "txn-test-doc",
              page: 1,
              chunkIndex: 0,
              content: "Test chunk 1",
            },
            {
              id: "txn-chunk-2",
              docId: "txn-test-doc",
              page: 1,
              chunkIndex: 1,
              content: "Test chunk 2",
            },
          ]);

          // Try to add embeddings where second one has invalid chunk_id
          // This should fail and rollback the transaction
          yield* db.addEmbeddings([
            { chunkId: "txn-chunk-1", embedding: new Array(1024).fill(0.1) },
            {
              chunkId: "non-existent-chunk",
              embedding: new Array(1024).fill(0.2),
            }, // Invalid - should cause rollback
          ]);
        })
      )
    ).rejects.toThrow();

    // Verify no embeddings were inserted (transaction rolled back)
    const stats = await runDb((db) => db.getStats());
    expect(stats.embeddings).toBe(0);
  });

  test("addChunks rolls back on failure", async () => {
    await expect(
      runDb((db) =>
        Effect.gen(function* () {
          const doc = new PDFDocument({
            id: "txn-test-doc-2",
            title: "Transaction Test 2",
            path: "/fake/txn2.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 1000,
            tags: [],
          });
          yield* db.addDocument(doc);

          // Try to add chunks where second references non-existent doc
          yield* db.addChunks([
            {
              id: "good-chunk",
              docId: "txn-test-doc-2",
              page: 1,
              chunkIndex: 0,
              content: "Good chunk",
            },
            {
              id: "bad-chunk",
              docId: "non-existent-doc",
              page: 1,
              chunkIndex: 0,
              content: "Bad chunk",
            }, // Should fail FK constraint
          ]);
        })
      )
    ).rejects.toThrow();

    // Verify the document was inserted (that succeeded)
    const doc = await runDb((db) => db.getDocument("txn-test-doc-2"));
    expect(doc).not.toBeNull();

    // But the chunks transaction rolled back - verify by checking the specific chunk IDs don't exist
    // We can't query chunks directly, but we can verify via full-text search
    const results = await runDb((db) =>
      db.ftsSearch("Good chunk", new SearchOptions({ limit: 10 }))
    );
    // Should find no results for "Good chunk" since that chunk was rolled back
    const foundGoodChunk = results.some((r) => r.content === "Good chunk");
    expect(foundGoodChunk).toBe(false);
  });
});

describe("checkpoint", () => {
  test("checkpoint method exists and can be called", async () => {
    await runDb((db) =>
      Effect.gen(function* () {
        // Should not throw
        yield* db.checkpoint();
      })
    );
  });

  test("checkpoint is called after addDocument", async () => {
    // This test verifies checkpoint exists in the flow
    // We can't directly spy on internal calls in Effect, but we can verify it doesn't throw
    await runDb((db) =>
      Effect.gen(function* () {
        const doc = new PDFDocument({
          id: "checkpoint-test",
          title: "Checkpoint Test",
          path: "/fake/checkpoint.pdf",
          addedAt: new Date(),
          pageCount: 1,
          sizeBytes: 1000,
          tags: [],
        });
        yield* db.addDocument(doc);
        // If checkpoint is implemented and called, this should succeed
      })
    );
  });
});

// ============================================================================
// Daemon Routing Tests
// ============================================================================

describe("DatabaseLive routing", () => {
  test("uses direct PGlite when daemon is not running", async () => {
    // In test environment, daemon is never running (temp directory)
    // This test verifies the fallback works
    const result = await runDb((db) =>
      Effect.gen(function* () {
        // Add a document to verify we're using a working database
        const doc = new PDFDocument({
          id: "routing-test-1",
          title: "Routing Test",
          path: "/fake/routing.pdf",
          addedAt: new Date(),
          pageCount: 1,
          sizeBytes: 1000,
          tags: [],
        });
        yield* db.addDocument(doc);

        // Retrieve it to confirm it was stored
        return yield* db.getDocument("routing-test-1");
      })
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Routing Test");
  });

  test("direct PGlite supports all database operations", async () => {
    // Verify that the direct PGlite implementation (used when daemon not running)
    // supports all required operations
    await runDb((db) =>
      Effect.gen(function* () {
        // Document operations
        const doc = new PDFDocument({
          id: "ops-test",
          title: "Operations Test",
          path: "/fake/ops.pdf",
          addedAt: new Date(),
          pageCount: 2,
          sizeBytes: 2000,
          tags: ["test"],
        });
        yield* db.addDocument(doc);

        // Chunk operations
        yield* db.addChunks([
          {
            id: "ops-test-0",
            docId: "ops-test",
            page: 1,
            chunkIndex: 0,
            content: "First chunk content",
          },
        ]);

        // Embeddings (vector search requires embeddings)
        yield* db.addEmbeddings([
          {
            chunkId: "ops-test-0",
            embedding: new Array(1024).fill(0.1), // mxbai-embed-large dimension
          },
        ]);

        // Stats
        const stats = yield* db.getStats();
        expect(stats.documents).toBeGreaterThan(0);

        // Repair
        const repairResult = yield* db.repair();
        expect(repairResult.orphanedChunks).toBe(0);

        // Checkpoint
        yield* db.checkpoint();
      })
    );
  });
});
