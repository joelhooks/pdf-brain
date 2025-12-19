/**
 * PGlite Database Service with pgvector
 *
 * Uses PGlite (WASM Postgres) with pgvector for proper vector similarity search.
 * No native extensions needed - pgvector is bundled with PGlite.
 */

import { Effect, Context, Layer } from "effect";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import {
  PDFDocument,
  SearchResult,
  SearchOptions,
  DatabaseError,
  LibraryConfig,
} from "../types.js";

// Embedding dimension for mxbai-embed-large
const EMBEDDING_DIM = 1024;

// ============================================================================
// Service Definition
// ============================================================================

export class Database extends Context.Tag("Database")<
  Database,
  {
    // Document operations
    readonly addDocument: (
      doc: PDFDocument
    ) => Effect.Effect<void, DatabaseError>;
    readonly getDocument: (
      id: string
    ) => Effect.Effect<PDFDocument | null, DatabaseError>;
    readonly getDocumentByPath: (
      path: string
    ) => Effect.Effect<PDFDocument | null, DatabaseError>;
    readonly listDocuments: (
      tag?: string
    ) => Effect.Effect<PDFDocument[], DatabaseError>;
    readonly deleteDocument: (id: string) => Effect.Effect<void, DatabaseError>;
    readonly updateTags: (
      id: string,
      tags: string[]
    ) => Effect.Effect<void, DatabaseError>;

    // Chunk operations
    readonly addChunks: (
      chunks: Array<{
        id: string;
        docId: string;
        page: number;
        chunkIndex: number;
        content: string;
      }>
    ) => Effect.Effect<void, DatabaseError>;
    readonly addEmbeddings: (
      embeddings: Array<{ chunkId: string; embedding: number[] }>
    ) => Effect.Effect<void, DatabaseError>;

    // Search operations
    readonly vectorSearch: (
      embedding: number[],
      options?: SearchOptions
    ) => Effect.Effect<SearchResult[], DatabaseError>;
    readonly ftsSearch: (
      query: string,
      options?: SearchOptions
    ) => Effect.Effect<SearchResult[], DatabaseError>;

    // Context expansion
    readonly getExpandedContext: (
      docId: string,
      chunkIndex: number,
      options?: { maxChars?: number; direction?: "before" | "after" | "both" }
    ) => Effect.Effect<
      { content: string; startIndex: number; endIndex: number },
      DatabaseError
    >;

    // Stats
    readonly getStats: () => Effect.Effect<
      { documents: number; chunks: number; embeddings: number },
      DatabaseError
    >;

    // Maintenance
    readonly repair: () => Effect.Effect<
      {
        orphanedChunks: number;
        orphanedEmbeddings: number;
        zeroVectorEmbeddings: number;
      },
      DatabaseError
    >;

    // WAL management
    readonly checkpoint: () => Effect.Effect<void, DatabaseError>;

    // Backup/restore
    readonly dumpDataDir: () => Effect.Effect<Blob, DatabaseError>;
  }
>() {}

// ============================================================================
// Implementation
// ============================================================================

export const DatabaseLive = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const config = LibraryConfig.fromEnv();

    // Ensure directory exists
    const dbDir = dirname(config.dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // PGlite stores data in a directory, not a single file
    const pgDataDir = config.dbPath.replace(".db", "");

    // Initialize PGlite with pgvector extension (0.3.x API)
    // Note: PGlite does not support PostgreSQL's max_wal_size configuration.
    // WAL management is handled via explicit CHECKPOINT calls (see checkpoint() method).
    const db = new PGlite(pgDataDir, { extensions: { vector } });
    yield* Effect.tryPromise({
      try: () => db.waitReady,
      catch: (e) =>
        new DatabaseError({ reason: `Failed to init PGlite: ${e}` }),
    });

    // Initialize schema
    yield* Effect.tryPromise({
      try: async () => {
        // Enable pgvector
        await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");

        // Documents table
        await db.exec(`
          CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            added_at TIMESTAMPTZ NOT NULL,
            page_count INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL,
            tags JSONB DEFAULT '[]',
            metadata JSONB DEFAULT '{}'
          )
        `);

        // Chunks table
        await db.exec(`
          CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            page INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL
          )
        `);

        // Embeddings table with vector column
        await db.exec(`
          CREATE TABLE IF NOT EXISTS embeddings (
            chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
            embedding vector(${EMBEDDING_DIM}) NOT NULL
          )
        `);

        // Create HNSW index for fast approximate nearest neighbor search
        await db.exec(`
          CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx 
          ON embeddings 
          USING hnsw (embedding vector_cosine_ops)
        `);

        // Full-text search index
        await db.exec(`
          CREATE INDEX IF NOT EXISTS chunks_content_idx 
          ON chunks 
          USING gin (to_tsvector('english', content))
        `);

        // Other indexes
        await db.exec(
          `CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id)`
        );
        await db.exec(
          `CREATE INDEX IF NOT EXISTS idx_docs_path ON documents(path)`
        );
      },
      catch: (e) => new DatabaseError({ reason: `Schema init failed: ${e}` }),
    });

    // Cleanup on scope close
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await db.close();
      })
    );

    // Helper to parse document row
    const parseDocRow = (row: any): PDFDocument =>
      new PDFDocument({
        id: row.id,
        title: row.title,
        path: row.path,
        addedAt: new Date(row.added_at),
        pageCount: row.page_count,
        sizeBytes: row.size_bytes,
        tags: row.tags,
        metadata: row.metadata,
      });

    return {
      addDocument: (doc) =>
        Effect.tryPromise({
          try: async () => {
            await db.query(
              `INSERT INTO documents (id, title, path, added_at, page_count, size_bytes, tags, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (id) DO UPDATE SET
                 title = EXCLUDED.title,
                 path = EXCLUDED.path,
                 added_at = EXCLUDED.added_at,
                 page_count = EXCLUDED.page_count,
                 size_bytes = EXCLUDED.size_bytes,
                 tags = EXCLUDED.tags,
                 metadata = EXCLUDED.metadata`,
              [
                doc.id,
                doc.title,
                doc.path,
                doc.addedAt.toISOString(),
                doc.pageCount,
                doc.sizeBytes,
                JSON.stringify(doc.tags),
                JSON.stringify(doc.metadata || {}),
              ]
            );
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      getDocument: (id) =>
        Effect.tryPromise({
          try: async () => {
            const result = await db.query(
              "SELECT * FROM documents WHERE id = $1",
              [id]
            );
            return result.rows.length > 0 ? parseDocRow(result.rows[0]) : null;
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      getDocumentByPath: (path) =>
        Effect.tryPromise({
          try: async () => {
            const result = await db.query(
              "SELECT * FROM documents WHERE path = $1",
              [path]
            );
            return result.rows.length > 0 ? parseDocRow(result.rows[0]) : null;
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      listDocuments: (tag) =>
        Effect.tryPromise({
          try: async () => {
            let query = "SELECT * FROM documents";
            const params: string[] = [];

            if (tag) {
              query += " WHERE tags @> $1::jsonb";
              params.push(JSON.stringify([tag]));
            }

            query += " ORDER BY added_at DESC";

            const result = await db.query(query, params);
            return result.rows.map(parseDocRow);
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      deleteDocument: (id) =>
        Effect.tryPromise({
          try: async () => {
            // Cascades handle chunks and embeddings
            await db.query("DELETE FROM documents WHERE id = $1", [id]);
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      updateTags: (id, tags) =>
        Effect.tryPromise({
          try: async () => {
            await db.query("UPDATE documents SET tags = $1 WHERE id = $2", [
              JSON.stringify(tags),
              id,
            ]);
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      addChunks: (chunks) =>
        Effect.tryPromise({
          try: async () => {
            // Batch insert using a transaction
            await db.exec("BEGIN");
            try {
              for (const chunk of chunks) {
                await db.query(
                  `INSERT INTO chunks (id, doc_id, page, chunk_index, content)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [
                    chunk.id,
                    chunk.docId,
                    chunk.page,
                    chunk.chunkIndex,
                    chunk.content,
                  ]
                );
              }
              await db.exec("COMMIT");
            } catch (e) {
              await db.exec("ROLLBACK");
              throw e;
            }
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      addEmbeddings: (embeddings) =>
        Effect.tryPromise({
          try: async () => {
            await db.exec("BEGIN");
            try {
              for (const item of embeddings) {
                // Format vector as pgvector expects: '[1,2,3,...]'
                const vectorStr = `[${item.embedding.join(",")}]`;
                await db.query(
                  `INSERT INTO embeddings (chunk_id, embedding)
                   VALUES ($1, $2::vector)`,
                  [item.chunkId, vectorStr]
                );
              }
              await db.exec("COMMIT");
            } catch (e) {
              await db.exec("ROLLBACK");
              throw e;
            }
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      vectorSearch: (queryEmbedding, options = new SearchOptions({})) =>
        Effect.tryPromise({
          try: async () => {
            const { limit = 10, threshold = 0.3, tags } = options;

            // Format query vector
            const vectorStr = `[${queryEmbedding.join(",")}]`;

            let query = `
              SELECT 
                c.doc_id,
                d.title,
                c.page,
                c.chunk_index,
                c.content,
                1 - (e.embedding <=> $1::vector) as score
              FROM embeddings e
              JOIN chunks c ON c.id = e.chunk_id
              JOIN documents d ON d.id = c.doc_id
            `;

            const params: any[] = [vectorStr];
            let paramIdx = 2;

            if (tags && tags.length > 0) {
              query += ` WHERE d.tags @> $${paramIdx}::jsonb`;
              params.push(JSON.stringify(tags));
              paramIdx++;
            }

            // Filter by threshold and order by similarity
            if (tags && tags.length > 0) {
              query += ` AND 1 - (e.embedding <=> $1::vector) >= $${paramIdx}`;
            } else {
              query += ` WHERE 1 - (e.embedding <=> $1::vector) >= $${paramIdx}`;
            }
            params.push(threshold);
            paramIdx++;

            query += ` ORDER BY e.embedding <=> $1::vector LIMIT $${paramIdx}`;
            params.push(limit);

            const result = await db.query(query, params);

            return result.rows.map(
              (row: any) =>
                new SearchResult({
                  docId: row.doc_id,
                  title: row.title,
                  page: row.page,
                  chunkIndex: row.chunk_index,
                  content: row.content,
                  score: row.score,
                  matchType: "vector",
                })
            );
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      ftsSearch: (query, options = new SearchOptions({})) =>
        Effect.tryPromise({
          try: async () => {
            const { limit = 10, tags } = options;

            let sql = `
              SELECT 
                c.doc_id,
                d.title,
                c.page,
                c.chunk_index,
                c.content,
                ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', $1)) as score
              FROM chunks c
              JOIN documents d ON d.id = c.doc_id
              WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', $1)
            `;

            const params: any[] = [query];
            let paramIdx = 2;

            if (tags && tags.length > 0) {
              sql += ` AND d.tags @> $${paramIdx}::jsonb`;
              params.push(JSON.stringify(tags));
              paramIdx++;
            }

            sql += ` ORDER BY score DESC LIMIT $${paramIdx}`;
            params.push(limit);

            const result = await db.query(sql, params);

            return result.rows.map(
              (row: any) =>
                new SearchResult({
                  docId: row.doc_id,
                  title: row.title,
                  page: row.page,
                  chunkIndex: row.chunk_index,
                  content: row.content,
                  score: row.score,
                  matchType: "fts",
                })
            );
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      getStats: () =>
        Effect.tryPromise({
          try: async () => {
            const docs = await db.query(
              "SELECT COUNT(*) as count FROM documents"
            );
            const chunks = await db.query(
              "SELECT COUNT(*) as count FROM chunks"
            );
            const embeddings = await db.query(
              "SELECT COUNT(*) as count FROM embeddings"
            );

            return {
              documents: Number((docs.rows[0] as { count: number }).count),
              chunks: Number((chunks.rows[0] as { count: number }).count),
              embeddings: Number(
                (embeddings.rows[0] as { count: number }).count
              ),
            };
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      repair: () =>
        Effect.tryPromise({
          try: async () => {
            // Count orphaned chunks (doc_id not in documents)
            const orphanedChunksResult = await db.query(`
              SELECT COUNT(*) as count FROM chunks c
              WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = c.doc_id)
            `);
            const orphanedChunks = Number(
              (orphanedChunksResult.rows[0] as { count: number }).count
            );

            // Count orphaned embeddings (chunk_id not in chunks)
            const orphanedEmbeddingsResult = await db.query(`
              SELECT COUNT(*) as count FROM embeddings e
              WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = e.chunk_id)
            `);
            const orphanedEmbeddings = Number(
              (orphanedEmbeddingsResult.rows[0] as { count: number }).count
            );

            // Count zero-dimension embeddings (vector_dims returns 0 or null)
            // Note: In pgvector, we check for malformed vectors
            const zeroVectorResult = await db.query(`
              SELECT COUNT(*) as count FROM embeddings 
              WHERE embedding IS NULL OR vector_dims(embedding) = 0
            `);
            const zeroVectorEmbeddings = Number(
              (zeroVectorResult.rows[0] as { count: number }).count
            );

            // Delete orphaned embeddings first (depends on chunks)
            if (orphanedEmbeddings > 0) {
              await db.query(`
                DELETE FROM embeddings e
                WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = e.chunk_id)
              `);
            }

            // Delete orphaned chunks (depends on documents)
            if (orphanedChunks > 0) {
              await db.query(`
                DELETE FROM chunks c
                WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = c.doc_id)
              `);
            }

            // Delete zero-dimension embeddings
            if (zeroVectorEmbeddings > 0) {
              await db.query(`
                DELETE FROM embeddings 
                WHERE embedding IS NULL OR vector_dims(embedding) = 0
              `);
            }

            return {
              orphanedChunks,
              orphanedEmbeddings,
              zeroVectorEmbeddings,
            };
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      getExpandedContext: (docId, chunkIndex, options = {}) =>
        Effect.tryPromise({
          try: async () => {
            const { maxChars = 2000, direction = "both" } = options;

            // Get the target chunk first
            const targetResult = await db.query(
              `SELECT chunk_index, content FROM chunks 
               WHERE doc_id = $1 AND chunk_index = $2`,
              [docId, chunkIndex]
            );

            if (targetResult.rows.length === 0) {
              return {
                content: "",
                startIndex: chunkIndex,
                endIndex: chunkIndex,
              };
            }

            const targetContent = (targetResult.rows[0] as { content: string })
              .content;
            let totalContent = targetContent;
            let startIdx = chunkIndex;
            let endIdx = chunkIndex;

            // Expand before (lower chunk indices)
            if (direction === "before" || direction === "both") {
              let beforeIdx = chunkIndex - 1;
              while (totalContent.length < maxChars && beforeIdx >= 0) {
                const beforeResult = await db.query(
                  `SELECT chunk_index, content FROM chunks 
                   WHERE doc_id = $1 AND chunk_index = $2`,
                  [docId, beforeIdx]
                );
                if (beforeResult.rows.length === 0) break;

                const beforeContent = (
                  beforeResult.rows[0] as { content: string }
                ).content;
                // Check if adding this chunk would exceed budget
                if (totalContent.length + beforeContent.length > maxChars * 1.2)
                  break;

                totalContent = beforeContent + "\n" + totalContent;
                startIdx = beforeIdx;
                beforeIdx--;
              }
            }

            // Expand after (higher chunk indices)
            if (direction === "after" || direction === "both") {
              let afterIdx = chunkIndex + 1;
              while (totalContent.length < maxChars) {
                const afterResult = await db.query(
                  `SELECT chunk_index, content FROM chunks 
                   WHERE doc_id = $1 AND chunk_index = $2`,
                  [docId, afterIdx]
                );
                if (afterResult.rows.length === 0) break;

                const afterContent = (
                  afterResult.rows[0] as { content: string }
                ).content;
                // Check if adding this chunk would exceed budget
                if (totalContent.length + afterContent.length > maxChars * 1.2)
                  break;

                totalContent = totalContent + "\n" + afterContent;
                endIdx = afterIdx;
                afterIdx++;
              }
            }

            return {
              content: totalContent,
              startIndex: startIdx,
              endIndex: endIdx,
            };
          },
          catch: (e) => new DatabaseError({ reason: String(e) }),
        }),

      checkpoint: () =>
        Effect.tryPromise({
          try: async () => {
            // Force PGlite to write WAL to data files
            // This prevents WAL accumulation that can cause WASM OOM
            await db.exec("CHECKPOINT");
          },
          catch: (e) =>
            new DatabaseError({ reason: `Checkpoint failed: ${e}` }),
        }),

      dumpDataDir: () =>
        Effect.tryPromise({
          try: async () => {
            // Run checkpoint first to ensure all data is flushed
            await db.exec("CHECKPOINT");
            // Dump the entire datadir as a gzipped tarball
            // This is a portable backup that can be restored with loadDataDir
            return await db.dumpDataDir("gzip");
          },
          catch: (e) => new DatabaseError({ reason: `Dump failed: ${e}` }),
        }),
    };
  })
);
