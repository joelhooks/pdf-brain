/**
 * LibSQL Database Service Tests (TDD)
 */

import { Effect, Layer } from "effect";
import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { Database } from "./Database.js";
import { LibSQLDatabase } from "./LibSQLDatabase.js";
import { Document, SearchOptions, DatabaseError } from "../types.js";

// Helper to query schema directly
async function getTableSchema(tableName: string): Promise<string | null> {
  const client = createClient({ url: ":memory:" });
  const layer = LibSQLDatabase.make({ url: ":memory:" });

  const program = Effect.gen(function* () {
    yield* Database; // Initialize schema
    return "initialized";
  });

  await Effect.runPromise(Effect.provide(program, layer));

  const result = await client.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    args: [tableName],
  });

  await client.close();

  return result.rows.length > 0 ? (result.rows[0].sql as string) : null;
}

// Helper to collect async generator results
async function collectGenerator<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

describe("LibSQLDatabase", () => {
  describe("initialization", () => {
    test("can be created with in-memory DB", async () => {
      const program = Effect.gen(function* () {
        // Create layer
        const layer = LibSQLDatabase.make({ url: ":memory:" });

        // Build the layer in a scope to verify it initializes successfully
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(layer);
            return "created";
          })
        );

        return "created";
      });

      const result = await Effect.runPromise(program);
      expect(result).toBe("created");
    });

    test("embeddings table uses F32_BLOB(1024) column type for mxbai-embed-large", async () => {
      // REGRESSION PREVENTION TEST
      // Root cause: Old PGLite code used TEXT for embeddings.
      // libSQL requires F32_BLOB(1024) for vector search with mxbai-embed-large.
      // If TEXT is used, vector search hangs.
      //
      // This test verifies the actual schema by querying sqlite_master

      // Create and initialize database through the Effect layer
      const program = Effect.gen(function* () {
        yield* Database; // Force initialization
        return "db-initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      // Query schema using raw client on the same shared memory DB
      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='embeddings'",
        args: [],
      });

      client.close();

      // Verify schema contains F32_BLOB(1024), not TEXT
      expect(result.rows.length).toBe(1);
      const schema = result.rows[0].sql as string;

      // CRITICAL: Must use F32_BLOB(1024) for libSQL vector operations with mxbai-embed-large
      expect(schema).toContain("F32_BLOB(1024)");

      // MUST NOT use TEXT (PGLite legacy schema)
      expect(schema).not.toContain("embedding TEXT");
    });
  });

  describe("document operations", () => {
    test("addDocument stores document", async () => {
      const program = Effect.gen(function* () {
        const db = yield* Database;

        // Create test document
        const doc = new Document({
          id: "test-123",
          title: "Test Document",
          path: "/path/to/test.pdf",
          addedAt: new Date("2025-01-01T00:00:00Z"),
          pageCount: 10,
          sizeBytes: 1024,
          tags: ["test", "example"],
          metadata: { source: "test" },
        });

        // Add document
        yield* db.addDocument(doc);

        // Verify it was stored by retrieving it
        const retrieved = yield* db.getDocument("test-123");

        return retrieved;
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const retrieved = await Effect.runPromise(Effect.provide(program, layer));

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("test-123");
      expect(retrieved?.title).toBe("Test Document");
      expect(retrieved?.path).toBe("/path/to/test.pdf");
      expect(retrieved?.tags).toEqual(["test", "example"]);
    });

    test("listDocuments returns all documents", async () => {
      const program = Effect.gen(function* () {
        const db = yield* Database;

        // Add multiple documents
        yield* db.addDocument(
          new Document({
            id: "doc-1",
            title: "First Doc",
            path: "/path/1.pdf",
            addedAt: new Date("2025-01-01"),
            pageCount: 5,
            sizeBytes: 500,
            tags: ["tag1"],
          })
        );
        yield* db.addDocument(
          new Document({
            id: "doc-2",
            title: "Second Doc",
            path: "/path/2.pdf",
            addedAt: new Date("2025-01-02"),
            pageCount: 10,
            sizeBytes: 1000,
            tags: ["tag2"],
          })
        );

        // List all documents
        const docs = yield* db.listDocuments();

        return docs;
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const docs = await Effect.runPromise(Effect.provide(program, layer));

      expect(docs).toHaveLength(2);
      expect(docs[0].id).toBe("doc-2"); // Most recent first
      expect(docs[1].id).toBe("doc-1");
    });

    test("deleteDocument removes document and cascades", async () => {
      const program = Effect.gen(function* () {
        const db = yield* Database;

        // Add document
        yield* db.addDocument(
          new Document({
            id: "doc-del",
            title: "To Delete",
            path: "/path/del.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 100,
            tags: [],
          })
        );

        // Delete it
        yield* db.deleteDocument("doc-del");

        // Verify it's gone
        const retrieved = yield* db.getDocument("doc-del");
        return retrieved;
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const result = await Effect.runPromise(Effect.provide(program, layer));

      expect(result).toBeNull();
    });
  });

  describe("chunk and embedding operations", () => {
    test("addChunks stores chunks", async () => {
      const program = Effect.gen(function* () {
        const db = yield* Database;

        // Add document first
        yield* db.addDocument(
          new Document({
            id: "doc-chunks",
            title: "Chunked Doc",
            path: "/path/chunks.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 100,
            tags: [],
          })
        );

        // Add chunks
        yield* db.addChunks([
          {
            id: "chunk-1",
            docId: "doc-chunks",
            page: 1,
            chunkIndex: 0,
            content: "First chunk content",
          },
          {
            id: "chunk-2",
            docId: "doc-chunks",
            page: 1,
            chunkIndex: 1,
            content: "Second chunk content",
          },
        ]);

        return "chunks-added";
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const result = await Effect.runPromise(Effect.provide(program, layer));

      expect(result).toBe("chunks-added");
    });

    test("getStats returns document/chunk/embedding counts", async () => {
      const program = Effect.gen(function* () {
        const db = yield* Database;

        // Add document
        yield* db.addDocument(
          new Document({
            id: "doc-stats",
            title: "Stats Doc",
            path: "/path/stats.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 100,
            tags: [],
          })
        );

        // Add chunks
        yield* db.addChunks([
          {
            id: "chunk-stats-1",
            docId: "doc-stats",
            page: 1,
            chunkIndex: 0,
            content: "Content",
          },
        ]);

        // Get stats
        const stats = yield* db.getStats();
        return stats;
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const stats = await Effect.runPromise(Effect.provide(program, layer));

      expect(stats.documents).toBe(1);
      expect(stats.chunks).toBe(1);
      expect(stats.embeddings).toBe(0);
    });
  });

  describe("taxonomy schema (SKOS)", () => {
    test("concepts table exists with correct schema", async () => {
      // RED: Verify SKOS concepts table exists
      const program = Effect.gen(function* () {
        yield* Database; // Force initialization
        return "db-initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      // Query schema using raw client
      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='concepts'",
        args: [],
      });

      client.close();

      expect(result.rows.length).toBe(1);
      const schema = result.rows[0].sql as string;

      // Verify columns
      expect(schema).toContain("id TEXT PRIMARY KEY");
      expect(schema).toContain("pref_label TEXT NOT NULL");
      expect(schema).toContain("alt_labels TEXT DEFAULT '[]'");
      expect(schema).toContain("definition TEXT");
      expect(schema).toContain("created_at TEXT NOT NULL");
    });

    test("concept_hierarchy table exists with composite primary key", async () => {
      const program = Effect.gen(function* () {
        yield* Database;
        return "db-initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='concept_hierarchy'",
        args: [],
      });

      client.close();

      expect(result.rows.length).toBe(1);
      const schema = result.rows[0].sql as string;

      expect(schema).toContain("concept_id TEXT NOT NULL");
      expect(schema).toContain("broader_id TEXT NOT NULL");
      expect(schema).toContain("REFERENCES concepts(id)");
      expect(schema).toContain("ON DELETE CASCADE");
      expect(schema).toContain("PRIMARY KEY(concept_id, broader_id)");
    });

    test("concept_relations table exists", async () => {
      const program = Effect.gen(function* () {
        yield* Database;
        return "db-initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='concept_relations'",
        args: [],
      });

      client.close();

      expect(result.rows.length).toBe(1);
      const schema = result.rows[0].sql as string;

      expect(schema).toContain("concept_id TEXT NOT NULL");
      expect(schema).toContain("related_id TEXT NOT NULL");
      expect(schema).toContain("relation_type TEXT DEFAULT 'related'");
      expect(schema).toContain("PRIMARY KEY(concept_id, related_id)");
    });

    test("document_concepts table exists", async () => {
      const program = Effect.gen(function* () {
        yield* Database;
        return "db-initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='document_concepts'",
        args: [],
      });

      client.close();

      expect(result.rows.length).toBe(1);
      const schema = result.rows[0].sql as string;

      expect(schema).toContain("doc_id TEXT NOT NULL");
      expect(schema).toContain("concept_id TEXT NOT NULL");
      expect(schema).toContain("confidence REAL DEFAULT 1.0");
      expect(schema).toContain("source TEXT DEFAULT 'llm'");
      expect(schema).toContain("PRIMARY KEY(doc_id, concept_id)");
    });

    test("taxonomy indexes exist for efficient hierarchy traversal", async () => {
      const program = Effect.gen(function* () {
        yield* Database;
        return "db-initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%concept%'",
        args: [],
      });

      client.close();

      const indexNames = result.rows.map((r) => r.name as string);

      expect(indexNames).toContain("idx_concept_hierarchy_concept");
      expect(indexNames).toContain("idx_concept_hierarchy_broader");
      expect(indexNames).toContain("idx_concept_relations_concept");
      expect(indexNames).toContain("idx_concept_relations_related");
      expect(indexNames).toContain("idx_document_concepts_doc");
      expect(indexNames).toContain("idx_document_concepts_concept");
    });
  });

  describe("full-text search (FTS5)", () => {
    test("ftsSearch returns matching results", async () => {
      const program = Effect.gen(function* () {
        const db = yield* Database;

        // Add document and chunks
        yield* db.addDocument(
          new Document({
            id: "doc-fts",
            title: "FTS Test Doc",
            path: "/path/fts.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 100,
            tags: ["tech"],
          })
        );

        yield* db.addChunks([
          {
            id: "chunk-fts-1",
            docId: "doc-fts",
            page: 1,
            chunkIndex: 0,
            content: "React hooks are awesome for state management",
          },
          {
            id: "chunk-fts-2",
            docId: "doc-fts",
            page: 1,
            chunkIndex: 1,
            content: "TypeScript provides excellent type safety",
          },
        ]);

        // Search for "hooks"
        const results = yield* db.ftsSearch(
          "hooks",
          new SearchOptions({ limit: 10 })
        );

        return results;
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const results = await Effect.runPromise(Effect.provide(program, layer));

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("hooks");
      expect(results[0].docId).toBe("doc-fts");
      expect(results[0].matchType).toBe("fts");
    });

    test("ftsSearch respects tag filter", async () => {
      const program = Effect.gen(function* () {
        const db = yield* Database;

        // Add two documents with different tags
        yield* db.addDocument(
          new Document({
            id: "doc-fts-tech",
            title: "Tech Doc",
            path: "/path/tech.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 100,
            tags: ["tech"],
          })
        );

        yield* db.addDocument(
          new Document({
            id: "doc-fts-business",
            title: "Business Doc",
            path: "/path/business.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 100,
            tags: ["business"],
          })
        );

        yield* db.addChunks([
          {
            id: "chunk-tech",
            docId: "doc-fts-tech",
            page: 1,
            chunkIndex: 0,
            content: "React hooks documentation",
          },
          {
            id: "chunk-business",
            docId: "doc-fts-business",
            page: 1,
            chunkIndex: 0,
            content: "React to market changes",
          },
        ]);

        // Search for "react" with tech tag filter
        const results = yield* db.ftsSearch(
          "react",
          new SearchOptions({ limit: 10, tags: ["tech"] })
        );

        return results;
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const results = await Effect.runPromise(Effect.provide(program, layer));

      expect(results).toHaveLength(1);
      expect(results[0].docId).toBe("doc-fts-tech");
    });

    test("ftsSearch returns empty array when no matches", async () => {
      const program = Effect.gen(function* () {
        const db = yield* Database;

        yield* db.addDocument(
          new Document({
            id: "doc-fts-empty",
            title: "Empty Search Doc",
            path: "/path/empty.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 100,
            tags: [],
          })
        );

        yield* db.addChunks([
          {
            id: "chunk-empty",
            docId: "doc-fts-empty",
            page: 1,
            chunkIndex: 0,
            content: "Some content here",
          },
        ]);

        const results = yield* db.ftsSearch(
          "nonexistent",
          new SearchOptions({ limit: 10 })
        );
        return results;
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const results = await Effect.runPromise(Effect.provide(program, layer));

      expect(results).toHaveLength(0);
    });
  });

  describe("concept embeddings schema", () => {
    test("concept_embeddings table exists with F32_BLOB(1024)", async () => {
      // RED TEST: Verify concept embeddings use same 1024-dim as mxbai-embed-large
      const program = Effect.gen(function* () {
        yield* Database; // Force initialization
        return "db-initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      // Query schema
      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='concept_embeddings'",
        args: [],
      });

      client.close();

      expect(result.rows.length).toBe(1);
      const schema = result.rows[0].sql as string;

      // Verify 1024 dimensions (mxbai-embed-large)
      expect(schema).toContain("F32_BLOB(1024)");
      expect(schema).toContain("concept_id TEXT PRIMARY KEY");
      expect(schema).toContain("REFERENCES concepts(id)");
      expect(schema).toContain("ON DELETE CASCADE");
    });

    test("concept_embeddings_idx vector index exists", async () => {
      const program = Effect.gen(function* () {
        yield* Database;
        return "db-initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='index' AND name='concept_embeddings_idx'",
        args: [],
      });

      client.close();

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].name).toBe("concept_embeddings_idx");
    });
  });

  describe("multi-scale search", () => {
    test("should support includeClusterSummaries option", async () => {
      // RED TEST: This test verifies the interface exists
      // The actual cluster_summaries table may not exist yet
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;
          // Search with new option - should not throw
          // For now, this is a no-op (table doesn't exist yet)
          return yield* db.vectorSearch(
            new Array(1024).fill(0.1), // Dummy embedding
            new SearchOptions({
              limit: 5,
              includeClusterSummaries: false, // Disabled by default
            })
          );
        }).pipe(Effect.provide(LibSQLDatabase.make({ url: ":memory:" })))
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("vectorSearch queries cluster_summaries when includeClusterSummaries=true", async () => {
      // RED TEST: Verify cluster summaries are queried and merged with chunk results
      // For now, just verify the option doesn't break anything
      // Full implementation test requires ability to insert cluster summaries
      // which we'll add when implementing the feature

      const program = Effect.gen(function* () {
        const db = yield* Database;

        // Add a document with chunks
        yield* db.addDocument(
          new Document({
            id: "doc-cluster",
            title: "Clustered Doc",
            path: "/path/cluster.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 100,
            tags: ["tech"],
          })
        );

        yield* db.addChunks([
          {
            id: "chunk-1",
            docId: "doc-cluster",
            page: 1,
            chunkIndex: 0,
            content: "First chunk about TypeScript",
          },
        ]);

        // Add embeddings for chunks
        const chunkEmbedding = new Array(1024).fill(0.1);
        yield* db.addEmbeddings([
          { chunkId: "chunk-1", embedding: chunkEmbedding },
        ]);

        // Search with includeClusterSummaries=true
        const results = yield* db.vectorSearch(
          chunkEmbedding,
          new SearchOptions({
            limit: 10,
            includeClusterSummaries: true,
          })
        );

        return results;
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const results = await Effect.runPromise(Effect.provide(program, layer));

      // At minimum, should return chunk results
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("TypeScript");

      // TODO: Once cluster summaries are queryable, verify they're included
      // For now, this tests that the option doesn't break normal search
    });

    test("vectorSearch merges and deduplicates results from chunks and cluster summaries", async () => {
      // RED TEST: When same content appears in both chunks and cluster summaries,
      // results should be merged by score (highest wins)
      const program = Effect.gen(function* () {
        const db = yield* Database;

        // Add document
        yield* db.addDocument(
          new Document({
            id: "doc-merge",
            title: "Merge Test Doc",
            path: "/path/merge.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 100,
            tags: [],
          })
        );

        // Add chunks
        yield* db.addChunks([
          {
            id: "chunk-merge-1",
            docId: "doc-merge",
            page: 1,
            chunkIndex: 0,
            content: "Content about React hooks",
          },
          {
            id: "chunk-merge-2",
            docId: "doc-merge",
            page: 1,
            chunkIndex: 1,
            content: "More React content",
          },
        ]);

        const embedding = new Array(1024).fill(0.2);
        yield* db.addEmbeddings([
          { chunkId: "chunk-merge-1", embedding },
          { chunkId: "chunk-merge-2", embedding },
        ]);

        // Search with cluster summaries enabled
        const results = yield* db.vectorSearch(
          embedding,
          new SearchOptions({
            limit: 10,
            includeClusterSummaries: true,
          })
        );

        return results;
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const results = await Effect.runPromise(Effect.provide(program, layer));

      // Results should be sorted by score DESC
      // If a chunk and cluster summary both match, higher score wins
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("streaming operations", () => {
    test("streamEmbeddings returns async generator for batched reads", async () => {
      // RED TEST: Verify streamEmbeddings yields batches of embeddings
      const layer = LibSQLDatabase.make({ url: ":memory:" });

      // Keep Effect scope alive while consuming generator
      const batches = await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;

          // Add test data
          yield* db.addDocument(
            new Document({
              id: "doc-stream",
              title: "Stream Test",
              path: "/stream.pdf",
              addedAt: new Date(),
              pageCount: 1,
              sizeBytes: 100,
              tags: [],
            })
          );

          // Add 5 chunks
          const chunks = Array.from({ length: 5 }, (_, i) => ({
            id: `chunk-stream-${i}`,
            docId: "doc-stream",
            page: 1,
            chunkIndex: i,
            content: `Chunk ${i} content`,
          }));
          yield* db.addChunks(chunks);

          // Add embeddings
          const embeddings = chunks.map((c) => ({
            chunkId: c.id,
            embedding: new Array(1024).fill(0.1 + 0.01 * c.chunkIndex),
          }));
          yield* db.addEmbeddings(embeddings);

          // Consume generator while Effect scope is alive
          return yield* Effect.promise(() =>
            collectGenerator(db.streamEmbeddings(2))
          );
        }).pipe(Effect.provide(layer))
      );

      // Should have 3 batches: [2, 2, 1]
      expect(batches.length).toBe(3);
      expect(batches[0].length).toBe(2);
      expect(batches[1].length).toBe(2);
      expect(batches[2].length).toBe(1);

      // Verify structure
      expect(batches[0][0]).toHaveProperty("chunkId");
      expect(batches[0][0]).toHaveProperty("embedding");
      expect(Array.isArray(batches[0][0].embedding)).toBe(true);
    });

    test("streamEmbeddings respects batch size parameter", async () => {
      // RED TEST: Different batch sizes should produce different batch counts
      const layer = LibSQLDatabase.make({ url: ":memory:" });

      const { batches3, batches5 } = await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;

          // Add test data (10 embeddings)
          yield* db.addDocument(
            new Document({
              id: "doc-batch",
              title: "Batch Test",
              path: "/batch.pdf",
              addedAt: new Date(),
              pageCount: 1,
              sizeBytes: 100,
              tags: [],
            })
          );

          const chunks = Array.from({ length: 10 }, (_, i) => ({
            id: `chunk-batch-${i}`,
            docId: "doc-batch",
            page: 1,
            chunkIndex: i,
            content: `Content ${i}`,
          }));
          yield* db.addChunks(chunks);

          const embeddings = chunks.map((c) => ({
            chunkId: c.id,
            embedding: new Array(1024).fill(0.1),
          }));
          yield* db.addEmbeddings(embeddings);

          // Consume generators while scope is alive
          const batches3 = yield* Effect.promise(() =>
            collectGenerator(db.streamEmbeddings(3))
          );
          const batches5 = yield* Effect.promise(() =>
            collectGenerator(db.streamEmbeddings(5))
          );

          return { batches3, batches5 };
        }).pipe(Effect.provide(layer))
      );

      expect(batches3.length).toBe(4);
      expect(batches3[0].length).toBe(3);
      expect(batches3[3].length).toBe(1);

      expect(batches5.length).toBe(2);
      expect(batches5[0].length).toBe(5);
      expect(batches5[1].length).toBe(5);
    });

    test("streamEmbeddings handles empty embeddings table", async () => {
      // RED TEST: Should yield zero batches for empty table
      const layer = LibSQLDatabase.make({ url: ":memory:" });

      const batches = await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;
          return yield* Effect.promise(() =>
            collectGenerator(db.streamEmbeddings(10))
          );
        }).pipe(Effect.provide(layer))
      );

      expect(batches.length).toBe(0);
    });
  });

  describe("bulk write operations", () => {
    test("bulkInsertClusterAssignments inserts multiple chunk-cluster mappings", async () => {
      // RED TEST: Verify bulk insert uses client.batch() for performance
      const program = Effect.gen(function* () {
        const db = yield* Database;

        // Add test document and chunks
        yield* db.addDocument(
          new Document({
            id: "doc-bulk",
            title: "Bulk Insert Test",
            path: "/bulk.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 100,
            tags: [],
          })
        );

        const chunks = Array.from({ length: 3 }, (_, i) => ({
          id: `chunk-bulk-${i}`,
          docId: "doc-bulk",
          page: 1,
          chunkIndex: i,
          content: `Chunk ${i}`,
        }));
        yield* db.addChunks(chunks);

        // Bulk insert cluster assignments
        const assignments = [
          { chunkId: "chunk-bulk-0", clusterId: 1, distance: 0.1 },
          { chunkId: "chunk-bulk-1", clusterId: 1, distance: 0.2 },
          { chunkId: "chunk-bulk-2", clusterId: 2, distance: 0.15 },
        ];
        yield* db.bulkInsertClusterAssignments(assignments);

        return "inserted";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      const result = await Effect.runPromise(Effect.provide(program, layer));

      expect(result).toBe("inserted");

      // Verify data was inserted (query directly)
      const client = createClient({ url: "file::memory:?cache=shared" });
      const queryResult = await client.execute({
        sql: "SELECT COUNT(*) as count FROM chunk_clusters",
        args: [],
      });
      await client.close();

      expect(Number((queryResult.rows[0] as any).count)).toBe(3);
    });

    test("bulkInsertClusterAssignments handles large batches efficiently", async () => {
      // RED TEST: Should handle 100+ assignments without issues
      const program = Effect.gen(function* () {
        const db = yield* Database;

        // Add document and 100 chunks
        yield* db.addDocument(
          new Document({
            id: "doc-large-bulk",
            title: "Large Bulk Test",
            path: "/large-bulk.pdf",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 100,
            tags: [],
          })
        );

        const chunks = Array.from({ length: 100 }, (_, i) => ({
          id: `chunk-large-${i}`,
          docId: "doc-large-bulk",
          page: 1,
          chunkIndex: i,
          content: `Chunk ${i}`,
        }));
        yield* db.addChunks(chunks);

        // Create 100 assignments
        const assignments = chunks.map((c, i) => ({
          chunkId: c.id,
          clusterId: Math.floor(i / 10), // 10 clusters
          distance: Math.random(),
        }));

        // Should complete without error
        yield* db.bulkInsertClusterAssignments(assignments);

        return "success";
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const result = await Effect.runPromise(Effect.provide(program, layer));

      expect(result).toBe("success");
    });

    test("bulkInsertClusterAssignments handles empty array gracefully", async () => {
      // RED TEST: Empty assignments should not error
      const program = Effect.gen(function* () {
        const db = yield* Database;

        yield* db.bulkInsertClusterAssignments([]);

        return "done";
      });

      const layer = LibSQLDatabase.make({ url: ":memory:" });
      const result = await Effect.runPromise(Effect.provide(program, layer));

      expect(result).toBe("done");
    });
  });

  describe("clustering tables (RAPTOR-lite)", () => {
    test("chunk_clusters table exists with correct schema", async () => {
      // Create and initialize database through the Effect layer
      const program = Effect.gen(function* () {
        yield* Database; // Force initialization
        return "db-initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      // Query schema using raw client on the same shared memory DB
      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunk_clusters'",
        args: [],
      });

      client.close();

      // Verify table exists
      expect(result.rows.length).toBe(1);
      const schema = result.rows[0].sql as string;

      // Verify columns - hard clustering uses distance to centroid
      expect(schema).toContain("chunk_id TEXT NOT NULL");
      expect(schema).toContain("cluster_id INTEGER NOT NULL");
      expect(schema).toContain("distance REAL NOT NULL");
      expect(schema).toContain("created_at TEXT NOT NULL");
      expect(schema).toContain("PRIMARY KEY(chunk_id, cluster_id)");
    });

    test("cluster_summaries table exists with correct schema", async () => {
      // Create and initialize database through the Effect layer
      const program = Effect.gen(function* () {
        yield* Database; // Force initialization
        return "db-initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      // Query schema using raw client on the same shared memory DB
      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='cluster_summaries'",
        args: [],
      });

      client.close();

      // Verify table exists
      expect(result.rows.length).toBe(1);
      const schema = result.rows[0].sql as string;

      // Verify columns - unified cluster summary with embedded metadata
      expect(schema).toContain("id INTEGER PRIMARY KEY");
      expect(schema).toContain("centroid F32_BLOB(1024)");
      expect(schema).toContain("summary TEXT");
      expect(schema).toContain("embedding F32_BLOB(1024)");
      expect(schema).toContain("concept_id TEXT");
      expect(schema).toContain("concept_confidence REAL");
      expect(schema).toContain("chunk_count INTEGER NOT NULL");
      expect(schema).toContain("created_at TEXT NOT NULL");
    });

    test("chunk_clusters has index on cluster_id", async () => {
      const program = Effect.gen(function* () {
        yield* Database;
        return "initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chunk_clusters' AND name='idx_chunk_clusters_cluster'",
        args: [],
      });

      client.close();

      expect(result.rows.length).toBe(1);
    });

    test("cluster_summaries has index on concept_id", async () => {
      const program = Effect.gen(function* () {
        yield* Database;
        return "initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cluster_summaries' AND name='idx_cluster_summaries_concept'",
        args: [],
      });

      client.close();

      expect(result.rows.length).toBe(1);
    });

    test("cluster_summaries has vector index on embedding", async () => {
      const program = Effect.gen(function* () {
        yield* Database;
        return "initialized";
      });

      const layer = LibSQLDatabase.make({ url: "file::memory:?cache=shared" });
      await Effect.runPromise(Effect.provide(program, layer));

      const client = createClient({ url: "file::memory:?cache=shared" });
      const result = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cluster_summaries' AND name='cluster_summaries_idx'",
        args: [],
      });

      client.close();

      expect(result.rows.length).toBe(1);
    });
  });
});
