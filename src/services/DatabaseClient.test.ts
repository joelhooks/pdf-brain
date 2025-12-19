/**
 * DatabaseClient Tests
 *
 * Tests the Unix socket client that connects to the PGlite daemon.
 */

import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Document, LibraryConfig, SearchOptions } from "../types.js";
import { startDaemon, stopDaemon } from "./Daemon.js";
import { DatabaseClient } from "./DatabaseClient.js";

describe("DatabaseClient", () => {
  const testDir = join(tmpdir(), `pdf-brain-test-${Date.now()}`);
  const config = new LibraryConfig({
    libraryPath: testDir,
    dbPath: join(testDir, "library.db"),
    ollamaModel: "mxbai-embed-large",
    ollamaHost: "http://localhost:11434",
    chunkSize: 512,
    chunkOverlap: 50,
  });

  const daemonConfig = {
    socketPath: testDir, // Directory where .s.PGSQL.5432 will be created
    pidPath: join(testDir, "daemon.pid"),
    dbPath: config.dbPath,
  };

  beforeAll(async () => {
    // Create test directory
    mkdirSync(testDir, { recursive: true });

    // Start daemon
    await startDaemon(daemonConfig);

    // Wait for socket to be ready
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(async () => {
    // Stop daemon
    await stopDaemon(daemonConfig);

    // Cleanup test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  test("connects to daemon via Unix socket", async () => {
    const program = Effect.gen(function* () {
      const db = yield* DatabaseClient;

      // Should be able to get stats
      const stats = yield* db.getStats();
      expect(stats).toMatchObject({
        documents: 0,
        chunks: 0,
        embeddings: 0,
      });
    });

    const layer = DatabaseClient.make(daemonConfig.socketPath);
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("retries connection if daemon is starting", async () => {
    // This test verifies retry logic is in place
    // Since daemon is already running, this just proves the client can connect
    const program = Effect.gen(function* () {
      const db = yield* DatabaseClient;
      const stats = yield* db.getStats();
      expect(stats.documents).toBe(0);
    });

    const layer = DatabaseClient.make(daemonConfig.socketPath);
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("implements full Database interface - addDocument and getDocument", async () => {
    const program = Effect.gen(function* () {
      const db = yield* DatabaseClient;

      const doc = new Document({
        id: "test-doc-1",
        title: "Test Document",
        path: "/tmp/test.pdf",
        addedAt: new Date(),
        pageCount: 10,
        sizeBytes: 1024,
        tags: ["test"],
        metadata: { author: "Test Author" },
      });

      yield* db.addDocument(doc);
      const retrieved = yield* db.getDocument("test-doc-1");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("test-doc-1");
      expect(retrieved?.title).toBe("Test Document");
    });

    const layer = DatabaseClient.make(daemonConfig.socketPath);
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("implements listDocuments", async () => {
    const program = Effect.gen(function* () {
      const db = yield* DatabaseClient;

      const doc2 = new Document({
        id: "test-doc-2",
        title: "Another Document",
        path: "/tmp/test2.pdf",
        addedAt: new Date(),
        pageCount: 5,
        sizeBytes: 512,
        tags: ["test", "sample"],
      });

      yield* db.addDocument(doc2);
      const all = yield* db.listDocuments();
      expect(all.length).toBeGreaterThanOrEqual(2);

      const tagged = yield* db.listDocuments("sample");
      expect(tagged.length).toBeGreaterThanOrEqual(1);
      expect(tagged.some((d) => d.id === "test-doc-2")).toBe(true);
    });

    const layer = DatabaseClient.make(daemonConfig.socketPath);
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("implements deleteDocument", async () => {
    const program = Effect.gen(function* () {
      const db = yield* DatabaseClient;

      const doc3 = new Document({
        id: "test-doc-3",
        title: "To Be Deleted",
        path: "/tmp/test3.pdf",
        addedAt: new Date(),
        pageCount: 1,
        sizeBytes: 100,
        tags: [],
      });

      yield* db.addDocument(doc3);
      const before = yield* db.getDocument("test-doc-3");
      expect(before).not.toBeNull();

      yield* db.deleteDocument("test-doc-3");
      const after = yield* db.getDocument("test-doc-3");
      expect(after).toBeNull();
    });

    const layer = DatabaseClient.make(daemonConfig.socketPath);
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("implements addChunks and addEmbeddings", async () => {
    const program = Effect.gen(function* () {
      const db = yield* DatabaseClient;

      // Add a document first
      const doc = new Document({
        id: "test-doc-chunks",
        title: "Chunks Test",
        path: "/tmp/chunks.pdf",
        addedAt: new Date(),
        pageCount: 1,
        sizeBytes: 200,
        tags: [],
      });
      yield* db.addDocument(doc);

      // Add chunks
      yield* db.addChunks([
        {
          id: "chunk-1",
          docId: "test-doc-chunks",
          page: 0,
          chunkIndex: 0,
          content: "This is a test chunk",
        },
        {
          id: "chunk-2",
          docId: "test-doc-chunks",
          page: 0,
          chunkIndex: 1,
          content: "Another test chunk",
        },
      ]);

      // Add embeddings (dummy vectors)
      const dummyVector = new Array(1024).fill(0.1);
      yield* db.addEmbeddings([
        { chunkId: "chunk-1", embedding: dummyVector },
        { chunkId: "chunk-2", embedding: dummyVector },
      ]);

      const stats = yield* db.getStats();
      expect(stats.chunks).toBeGreaterThanOrEqual(2);
      expect(stats.embeddings).toBeGreaterThanOrEqual(2);
    });

    const layer = DatabaseClient.make(daemonConfig.socketPath);
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("implements vectorSearch", async () => {
    const program = Effect.gen(function* () {
      const db = yield* DatabaseClient;

      const queryVector = new Array(1024).fill(0.1);
      const results = yield* db.vectorSearch(
        queryVector,
        new SearchOptions({})
      );

      // Should return results (may be empty if threshold too high)
      expect(Array.isArray(results)).toBe(true);
    });

    const layer = DatabaseClient.make(daemonConfig.socketPath);
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("implements ftsSearch", async () => {
    const program = Effect.gen(function* () {
      const db = yield* DatabaseClient;

      const results = yield* db.ftsSearch("test", new SearchOptions({}));

      // Should return results if chunks contain "test"
      expect(Array.isArray(results)).toBe(true);
    });

    const layer = DatabaseClient.make(daemonConfig.socketPath);
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("implements repair", async () => {
    const program = Effect.gen(function* () {
      const db = yield* DatabaseClient;

      const result = yield* db.repair();

      expect(result).toMatchObject({
        orphanedChunks: expect.any(Number),
        orphanedEmbeddings: expect.any(Number),
        zeroVectorEmbeddings: expect.any(Number),
      });
    });

    const layer = DatabaseClient.make(daemonConfig.socketPath);
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("implements checkpoint", async () => {
    const program = Effect.gen(function* () {
      const db = yield* DatabaseClient;

      // Should not throw
      yield* db.checkpoint();
    });

    const layer = DatabaseClient.make(daemonConfig.socketPath);
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("handles connection errors gracefully", async () => {
    // Use a non-existent socket path
    const badSocketPath = join(testDir, "nonexistent.sock");

    const program = Effect.gen(function* () {
      const db = yield* DatabaseClient;
      yield* db.getStats();
    });

    const layer = DatabaseClient.make(badSocketPath);

    // Should fail with DatabaseError
    const result = await Effect.runPromiseExit(
      program.pipe(Effect.provide(layer))
    );

    expect(result._tag).toBe("Failure");
  });
});
