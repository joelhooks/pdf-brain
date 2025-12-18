/**
 * Database Service Unit Tests - Expanded Context
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database, DatabaseLive } from "./Database.js";
import { PDFDocument } from "../types.js";

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
    db: Effect.Effect.Success<typeof Database>,
  ) => Effect.Effect<A, E, never>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* effect(db);
      }).pipe(Effect.provide(DatabaseLive)),
    ),
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
      }),
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
      }),
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
      }),
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
      }),
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
      }),
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
      }),
    );

    expect(result.content).toBe("");
    expect(result.startIndex).toBe(999);
    expect(result.endIndex).toBe(999);
  });
});
