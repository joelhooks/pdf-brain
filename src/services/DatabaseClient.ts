/**
 * DatabaseClient Service - Unix Socket Client for PGlite Daemon
 *
 * Connects to PGlite daemon via Unix socket using node-postgres (pg).
 * Implements the same interface as Database service but proxies queries through socket.
 *
 * Key insight from pglite-socket docs:
 * > For Unix sockets, `host` should be the directory containing the socket file,
 * > NOT the socket file itself. node-postgres appends `.s.PGSQL.5432` automatically.
 *
 * Example:
 * - Socket directory: ~/.pdf-library
 * - Socket file created: ~/.pdf-library/.s.PGSQL.5432
 * - pg host: ~/.pdf-library (directory only)
 *
 * References:
 * - https://pglite.dev/docs/pglite-socket#client-connections
 * - https://node-postgres.com/features/connecting#unix-domain-sockets
 */

import { Context, Effect, Layer, Schedule } from "effect";
import pg from "pg";
import { dirname } from "node:path";
import {
  DatabaseError,
  Document,
  SearchOptions,
  SearchResult,
} from "../types.js";

const { Client } = pg;

// ============================================================================
// Service Definition
// ============================================================================

export class DatabaseClient extends Context.Tag("DatabaseClient")<
  DatabaseClient,
  {
    // Document operations
    readonly addDocument: (doc: Document) => Effect.Effect<void, DatabaseError>;
    readonly getDocument: (
      id: string
    ) => Effect.Effect<Document | null, DatabaseError>;
    readonly getDocumentByPath: (
      path: string
    ) => Effect.Effect<Document | null, DatabaseError>;
    readonly listDocuments: (
      tag?: string
    ) => Effect.Effect<Document[], DatabaseError>;
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
>() {
  /**
   * Create DatabaseClient layer with Unix socket connection
   *
   * @param socketPath - Directory containing the Unix socket (e.g., ~/.pdf-library)
   *                     Socket file .s.PGSQL.5432 will be in this directory
   * @returns Effect Layer providing DatabaseClient
   */
  static make(socketPath: string): Layer.Layer<DatabaseClient, DatabaseError> {
    return Layer.scoped(
      DatabaseClient,
      Effect.gen(function* () {
        // Create pg client with Unix socket connection
        // Daemon creates socket at: ${socketPath}/.s.PGSQL.5432
        // node-postgres expects directory as host, automatically appends /.s.PGSQL.5432
        const client = new Client({
          host: socketPath, // Directory containing .s.PGSQL.5432
          database: "template1", // PGlite default database
        });

        // Connect to daemon
        // Note: We don't retry here because pg.Client can only connect once
        // If connection fails, the error will propagate and the layer will fail
        yield* Effect.tryPromise({
          try: async () => {
            await client.connect();
          },
          catch: (e) =>
            new DatabaseError({
              reason: `Failed to connect to daemon at ${socketPath}: ${e}`,
            }),
        });

        // Cleanup on scope close
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await client.end();
          })
        );

        // Helper to parse document row
        const parseDocRow = (row: {
          id: string;
          title: string;
          path: string;
          added_at: string;
          page_count: number;
          size_bytes: number;
          tags: string[];
          metadata?: Record<string, unknown>;
        }): Document =>
          new Document({
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
                await client.query(
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
                const result = await client.query(
                  "SELECT * FROM documents WHERE id = $1",
                  [id]
                );
                return result.rows.length > 0
                  ? parseDocRow(result.rows[0])
                  : null;
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          getDocumentByPath: (path) =>
            Effect.tryPromise({
              try: async () => {
                const result = await client.query(
                  "SELECT * FROM documents WHERE path = $1",
                  [path]
                );
                return result.rows.length > 0
                  ? parseDocRow(result.rows[0])
                  : null;
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

                const result = await client.query(query, params);
                return result.rows.map(parseDocRow);
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          deleteDocument: (id) =>
            Effect.tryPromise({
              try: async () => {
                // Cascades handle chunks and embeddings
                await client.query("DELETE FROM documents WHERE id = $1", [id]);
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          updateTags: (id, tags) =>
            Effect.tryPromise({
              try: async () => {
                await client.query(
                  "UPDATE documents SET tags = $1 WHERE id = $2",
                  [JSON.stringify(tags), id]
                );
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          addChunks: (chunks) =>
            Effect.tryPromise({
              try: async () => {
                // Batch insert using a transaction
                await client.query("BEGIN");
                try {
                  for (const chunk of chunks) {
                    await client.query(
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
                  await client.query("COMMIT");
                } catch (e) {
                  await client.query("ROLLBACK");
                  throw e;
                }
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          addEmbeddings: (embeddings) =>
            Effect.tryPromise({
              try: async () => {
                await client.query("BEGIN");
                try {
                  for (const item of embeddings) {
                    // Format vector as pgvector expects: '[1,2,3,...]'
                    const vectorStr = `[${item.embedding.join(",")}]`;
                    await client.query(
                      `INSERT INTO embeddings (chunk_id, embedding)
                       VALUES ($1, $2::vector)`,
                      [item.chunkId, vectorStr]
                    );
                  }
                  await client.query("COMMIT");
                } catch (e) {
                  await client.query("ROLLBACK");
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

                const result = await client.query(query, params);

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

                const result = await client.query(sql, params);

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
                const docs = await client.query(
                  "SELECT COUNT(*) as count FROM documents"
                );
                const chunks = await client.query(
                  "SELECT COUNT(*) as count FROM chunks"
                );
                const embeddings = await client.query(
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
                const orphanedChunksResult = await client.query(`
                  SELECT COUNT(*) as count FROM chunks c
                  WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = c.doc_id)
                `);
                const orphanedChunks = Number(
                  (orphanedChunksResult.rows[0] as { count: number }).count
                );

                // Count orphaned embeddings (chunk_id not in chunks)
                const orphanedEmbeddingsResult = await client.query(`
                  SELECT COUNT(*) as count FROM embeddings e
                  WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = e.chunk_id)
                `);
                const orphanedEmbeddings = Number(
                  (orphanedEmbeddingsResult.rows[0] as { count: number }).count
                );

                // Count zero-dimension embeddings (vector_dims returns 0 or null)
                const zeroVectorResult = await client.query(`
                  SELECT COUNT(*) as count FROM embeddings 
                  WHERE embedding IS NULL OR vector_dims(embedding) = 0
                `);
                const zeroVectorEmbeddings = Number(
                  (zeroVectorResult.rows[0] as { count: number }).count
                );

                // Delete orphaned embeddings first (depends on chunks)
                if (orphanedEmbeddings > 0) {
                  await client.query(`
                    DELETE FROM embeddings e
                    WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = e.chunk_id)
                  `);
                }

                // Delete orphaned chunks (depends on documents)
                if (orphanedChunks > 0) {
                  await client.query(`
                    DELETE FROM chunks c
                    WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = c.doc_id)
                  `);
                }

                // Delete zero-dimension embeddings
                if (zeroVectorEmbeddings > 0) {
                  await client.query(`
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
                const targetResult = await client.query(
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

                const targetContent = (
                  targetResult.rows[0] as { content: string }
                ).content;
                let totalContent = targetContent;
                let startIdx = chunkIndex;
                let endIdx = chunkIndex;

                // Expand before (lower chunk indices)
                if (direction === "before" || direction === "both") {
                  let beforeIdx = chunkIndex - 1;
                  while (totalContent.length < maxChars && beforeIdx >= 0) {
                    const beforeResult = await client.query(
                      `SELECT chunk_index, content FROM chunks 
                       WHERE doc_id = $1 AND chunk_index = $2`,
                      [docId, beforeIdx]
                    );
                    if (beforeResult.rows.length === 0) break;

                    const beforeContent = (
                      beforeResult.rows[0] as { content: string }
                    ).content;
                    // Check if adding this chunk would exceed budget
                    if (
                      totalContent.length + beforeContent.length >
                      maxChars * 1.2
                    )
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
                    const afterResult = await client.query(
                      `SELECT chunk_index, content FROM chunks 
                       WHERE doc_id = $1 AND chunk_index = $2`,
                      [docId, afterIdx]
                    );
                    if (afterResult.rows.length === 0) break;

                    const afterContent = (
                      afterResult.rows[0] as { content: string }
                    ).content;
                    // Check if adding this chunk would exceed budget
                    if (
                      totalContent.length + afterContent.length >
                      maxChars * 1.2
                    )
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
                await client.query("CHECKPOINT");
              },
              catch: (e) =>
                new DatabaseError({ reason: `Checkpoint failed: ${e}` }),
            }),

          dumpDataDir: () =>
            Effect.tryPromise({
              try: async () => {
                // Run checkpoint first to ensure all data is flushed
                await client.query("CHECKPOINT");
                // Note: dumpDataDir is a PGlite-specific method, not available via pg client
                // For now, this is a stub - real implementation would need to use PGlite API directly
                throw new Error(
                  "dumpDataDir not supported via socket connection - use Database service directly"
                );
              },
              catch: (e) => new DatabaseError({ reason: `Dump failed: ${e}` }),
            }),
        };
      })
    );
  }
}
