/**
 * LibSQL Database Service
 *
 * Implements the Database interface using @libsql/client.
 * Designed for file-based and remote libSQL/Turso databases.
 */

import { Effect, Layer } from "effect";
import { createClient, type Client } from "@libsql/client";
import { Database } from "./Database.js";
import { DatabaseError, Document } from "../types.js";

// Embedding dimension for mxbai-embed-large (used for both documents and concepts)
const EMBEDDING_DIM = 1024;

// ============================================================================
// LibSQLDatabase Service
// ============================================================================

export class LibSQLDatabase {
  /**
   * Create a LibSQL Database layer
   *
   * @param config - Connection configuration
   *   - url: ":memory:" for in-memory, "file:./path.db" for local file, or remote URL
   *   - authToken: Optional auth token for Turso/remote databases
   */
  static make(config: { url: string; authToken?: string }) {
    return Layer.scoped(
      Database,
      Effect.gen(function* () {
        // Create libSQL client
        const client = createClient({
          url: config.url,
          authToken: config.authToken,
        });

        // Initialize schema
        yield* Effect.tryPromise({
          try: async () => {
            await initSchema(client);
          },
          catch: (e) =>
            new DatabaseError({ reason: `Schema init failed: ${e}` }),
        });

        // Cleanup on scope close
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            client.close();
          })
        );

        // Helper to parse document row
        const parseDocRow = (row: any): Document =>
          new Document({
            id: row.id as string,
            title: row.title as string,
            path: row.path as string,
            addedAt: new Date(row.added_at as string),
            pageCount: row.page_count as number,
            sizeBytes: row.size_bytes as number,
            tags: JSON.parse(row.tags as string) as string[],
            metadata: JSON.parse(row.metadata as string) as Record<
              string,
              unknown
            >,
          });

        // Return Database implementation
        return {
          addDocument: (doc) =>
            Effect.tryPromise({
              try: async () => {
                await client.execute({
                  sql: `INSERT INTO documents (id, title, path, added_at, page_count, size_bytes, tags, metadata)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT (id) DO UPDATE SET
                          title = excluded.title,
                          path = excluded.path,
                          added_at = excluded.added_at,
                          page_count = excluded.page_count,
                          size_bytes = excluded.size_bytes,
                          tags = excluded.tags,
                          metadata = excluded.metadata`,
                  args: [
                    doc.id,
                    doc.title,
                    doc.path,
                    doc.addedAt.toISOString(),
                    doc.pageCount,
                    doc.sizeBytes,
                    JSON.stringify(doc.tags),
                    JSON.stringify(doc.metadata || {}),
                  ],
                });
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          getDocument: (id) =>
            Effect.tryPromise({
              try: async () => {
                const result = await client.execute({
                  sql: "SELECT * FROM documents WHERE id = ?",
                  args: [id],
                });
                return result.rows.length > 0
                  ? parseDocRow(result.rows[0])
                  : null;
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          getDocumentByPath: (path) =>
            Effect.tryPromise({
              try: async () => {
                const result = await client.execute({
                  sql: "SELECT * FROM documents WHERE path = ?",
                  args: [path],
                });
                return result.rows.length > 0
                  ? parseDocRow(result.rows[0])
                  : null;
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          listDocuments: (tag) =>
            Effect.tryPromise({
              try: async () => {
                let sql = "SELECT * FROM documents";
                const args: any[] = [];

                if (tag) {
                  sql +=
                    " WHERE json_array_length(tags) > 0 AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)";
                  args.push(tag);
                }

                sql += " ORDER BY added_at DESC";

                const result = await client.execute({ sql, args });
                return result.rows.map(parseDocRow);
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          deleteDocument: (id) =>
            Effect.tryPromise({
              try: async () => {
                await client.execute({
                  sql: "DELETE FROM documents WHERE id = ?",
                  args: [id],
                });
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),
          updateTags: (id, tags) =>
            Effect.tryPromise({
              try: async () => {
                await client.execute({
                  sql: "UPDATE documents SET tags = ? WHERE id = ?",
                  args: [JSON.stringify(tags), id],
                });
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          addChunks: (chunks) =>
            Effect.tryPromise({
              try: async () => {
                // Use batch for transaction
                const statements = chunks.map((chunk) => ({
                  sql: "INSERT INTO chunks (id, doc_id, page, chunk_index, content) VALUES (?, ?, ?, ?, ?)",
                  args: [
                    chunk.id,
                    chunk.docId,
                    chunk.page,
                    chunk.chunkIndex,
                    chunk.content,
                  ],
                }));
                await client.batch(statements, "write");
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          addEmbeddings: (embeddings) =>
            Effect.tryPromise({
              try: async () => {
                // LibSQL stores vectors as F32_BLOB using vector32() function
                const statements = embeddings.map((item) => ({
                  sql: "INSERT INTO embeddings (chunk_id, embedding) VALUES (?, vector32(?))",
                  args: [item.chunkId, JSON.stringify(item.embedding)],
                }));
                await client.batch(statements, "write");
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          vectorSearch: (queryEmbedding, options) =>
            Effect.tryPromise({
              try: async () => {
                const {
                  limit = 10,
                  tags,
                  threshold = 0.0,
                  includeClusterSummaries = false,
                } = options || {};
                const queryVec = JSON.stringify(queryEmbedding);

                // RAPTOR multi-scale retrieval: query both chunks AND cluster summaries
                if (includeClusterSummaries) {
                  const fetchLimit =
                    tags && tags.length > 0 ? limit * 2 : limit;
                  const maxDistance =
                    threshold > 0 ? 2 * (1 - threshold) : null;

                  // Query chunks
                  const chunkArgs: any[] = [queryVec, queryVec, fetchLimit];
                  const chunkConditions: string[] = [];

                  if (tags && tags.length > 0) {
                    chunkConditions.push(
                      "(" +
                        tags
                          .map(
                            () =>
                              "EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)"
                          )
                          .join(" OR ") +
                        ")"
                    );
                    chunkArgs.push(...tags);
                  }

                  if (maxDistance !== null) {
                    chunkConditions.push(
                      `vector_distance_cos(e.embedding, vector32(?)) <= ?`
                    );
                    chunkArgs.push(queryVec, maxDistance);
                  }

                  const chunkResults = await client.execute({
                    sql: `
                      SELECT 
                        c.doc_id,
                        d.title,
                        c.page,
                        c.chunk_index,
                        c.content,
                        vector_distance_cos(e.embedding, vector32(?)) as distance
                      FROM vector_top_k('embeddings_idx', vector32(?), ?) AS top
                      JOIN embeddings e ON e.rowid = top.id
                      JOIN chunks c ON c.id = e.chunk_id
                      JOIN documents d ON d.id = c.doc_id
                      ${
                        chunkConditions.length > 0
                          ? " WHERE " + chunkConditions.join(" AND ")
                          : ""
                      }
                    `,
                    args: chunkArgs,
                  });

                  // Query cluster summaries
                  const clusterArgs: any[] = [queryVec, queryVec, fetchLimit];
                  const clusterConditions: string[] = [];

                  if (maxDistance !== null) {
                    clusterConditions.push(
                      `vector_distance_cos(cs.embedding, vector32(?)) <= ?`
                    );
                    clusterArgs.push(queryVec, maxDistance);
                  }

                  const clusterResults = await client.execute({
                    sql: `
                      SELECT 
                        '' as doc_id,
                        'Cluster Summary' as title,
                        0 as page,
                        cs.id as chunk_index,
                        cs.summary as content,
                        vector_distance_cos(cs.embedding, vector32(?)) as distance
                      FROM vector_top_k('cluster_summaries_idx', vector32(?), ?) AS top
                      JOIN cluster_summaries cs ON cs.rowid = top.id
                      ${
                        clusterConditions.length > 0
                          ? " WHERE " + clusterConditions.join(" AND ")
                          : ""
                      }
                    `,
                    args: clusterArgs,
                  });

                  // Merge and sort by score
                  return [...chunkResults.rows, ...clusterResults.rows]
                    .map((row: any) => ({
                      docId: row.doc_id,
                      title: row.title,
                      page: Number(row.page),
                      chunkIndex: Number(row.chunk_index),
                      content: row.content,
                      score: 1 - Number(row.distance) / 2,
                      matchType: "vector" as const,
                    }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, limit);
                }

                // Standard chunk-only search
                let sql = `
                  SELECT 
                    c.doc_id,
                    d.title,
                    c.page,
                    c.chunk_index,
                    c.content,
                    vector_distance_cos(e.embedding, vector32(?)) as distance
                  FROM vector_top_k('embeddings_idx', vector32(?), ?) AS top
                  JOIN embeddings e ON e.rowid = top.id
                  JOIN chunks c ON c.id = e.chunk_id
                  JOIN documents d ON d.id = c.doc_id
                `;

                // Fetch more than limit to allow for filtering
                const fetchLimit = tags && tags.length > 0 ? limit * 3 : limit;
                const args: any[] = [queryVec, queryVec, fetchLimit];

                const conditions: string[] = [];

                if (tags && tags.length > 0) {
                  conditions.push(
                    "(" +
                      tags
                        .map(
                          () =>
                            "EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)"
                        )
                        .join(" OR ") +
                      ")"
                  );
                  args.push(...tags);
                }

                // Filter by threshold (distance < 2*(1-threshold))
                // score = 1 - distance/2, so distance = 2*(1-score)
                // if score >= threshold, then distance <= 2*(1-threshold)
                if (threshold > 0) {
                  const maxDistance = 2 * (1 - threshold);
                  conditions.push(
                    `vector_distance_cos(e.embedding, vector32(?)) <= ?`
                  );
                  args.push(queryVec, maxDistance);
                }

                if (conditions.length > 0) {
                  sql += " WHERE " + conditions.join(" AND ");
                }

                sql += ` ORDER BY distance ASC LIMIT ${limit}`;

                const result = await client.execute({ sql, args });

                return result.rows.map(
                  (row: any) =>
                    ({
                      docId: row.doc_id,
                      title: row.title,
                      page: Number(row.page),
                      chunkIndex: Number(row.chunk_index),
                      content: row.content,
                      // Convert distance to similarity score: score = 1 - distance/2
                      score: 1 - Number(row.distance) / 2,
                      matchType: "vector",
                    } as any)
                );
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          ftsSearch: (query, options) =>
            Effect.tryPromise({
              try: async () => {
                const { limit = 10, tags } = options || {};

                // LibSQL FTS5 uses MATCH syntax
                // FTS5 rank() returns NEGATIVE scores - more negative = better match
                //
                // IMPORTANT: FTS5 has special query syntax where characters like
                // - (NOT), * (prefix), " (phrase), : (column), etc. have meaning.
                // We need to escape the query to treat it as a literal phrase search.
                // Wrap the entire query in double quotes for phrase matching,
                // and escape any internal double quotes.
                const escapedQuery = `"${query.replace(/"/g, '""')}"`;

                let sql = `
                  SELECT 
                    c.doc_id,
                    d.title,
                    c.page,
                    c.chunk_index,
                    c.content,
                    fts.rank as score
                  FROM chunks_fts fts
                  JOIN chunks c ON c.rowid = fts.rowid
                  JOIN documents d ON d.id = c.doc_id
                  WHERE fts.content MATCH ?
                `;

                const args: any[] = [escapedQuery];

                if (tags && tags.length > 0) {
                  // Filter by tags using json_each
                  sql +=
                    " AND EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value IN (" +
                    tags.map(() => "?").join(", ") +
                    "))";
                  args.push(...tags);
                }

                // Order by rank DESC (most negative = best match)
                // Note: FTS5 rank is negative, so we use DESC to get best matches first
                sql += ` ORDER BY fts.rank DESC LIMIT ?`;
                args.push(limit);

                const result = await client.execute({ sql, args });

                return result.rows.map(
                  (row: any) =>
                    ({
                      docId: row.doc_id,
                      title: row.title,
                      page: Number(row.page),
                      chunkIndex: Number(row.chunk_index),
                      content: row.content,
                      // Negate score to make it positive for consistency
                      score: Math.abs(Number(row.score)),
                      matchType: "fts",
                    } as any)
                );
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          getExpandedContext: (docId, chunkIndex, options) =>
            Effect.tryPromise({
              try: async () => {
                const { maxChars = 2000, direction = "both" } = options || {};

                // Get target chunk
                const targetResult = await client.execute({
                  sql: "SELECT chunk_index, content FROM chunks WHERE doc_id = ? AND chunk_index = ?",
                  args: [docId, chunkIndex],
                });

                if (targetResult.rows.length === 0) {
                  return {
                    content: "",
                    startIndex: chunkIndex,
                    endIndex: chunkIndex,
                  };
                }

                let totalContent = (targetResult.rows[0] as any).content;
                let startIdx = chunkIndex;
                let endIdx = chunkIndex;

                // Expand before
                if (direction === "before" || direction === "both") {
                  let beforeIdx = chunkIndex - 1;
                  while (totalContent.length < maxChars && beforeIdx >= 0) {
                    const beforeResult = await client.execute({
                      sql: "SELECT content FROM chunks WHERE doc_id = ? AND chunk_index = ?",
                      args: [docId, beforeIdx],
                    });
                    if (beforeResult.rows.length === 0) break;

                    const beforeContent = (beforeResult.rows[0] as any).content;
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

                // Expand after
                if (direction === "after" || direction === "both") {
                  let afterIdx = chunkIndex + 1;
                  while (totalContent.length < maxChars) {
                    const afterResult = await client.execute({
                      sql: "SELECT content FROM chunks WHERE doc_id = ? AND chunk_index = ?",
                      args: [docId, afterIdx],
                    });
                    if (afterResult.rows.length === 0) break;

                    const afterContent = (afterResult.rows[0] as any).content;
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

          getStats: () =>
            Effect.tryPromise({
              try: async () => {
                const docs = await client.execute(
                  "SELECT COUNT(*) as count FROM documents"
                );
                const chunks = await client.execute(
                  "SELECT COUNT(*) as count FROM chunks"
                );
                const embeddings = await client.execute(
                  "SELECT COUNT(*) as count FROM embeddings"
                );

                return {
                  documents: Number((docs.rows[0] as any).count),
                  chunks: Number((chunks.rows[0] as any).count),
                  embeddings: Number((embeddings.rows[0] as any).count),
                };
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          repair: () =>
            Effect.tryPromise({
              try: async () => {
                // Count orphaned chunks
                const orphanedChunksResult = await client.execute(`
                  SELECT COUNT(*) as count FROM chunks c
                  WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = c.doc_id)
                `);
                const orphanedChunks = Number(
                  (orphanedChunksResult.rows[0] as any).count
                );

                // Count orphaned embeddings
                const orphanedEmbeddingsResult = await client.execute(`
                  SELECT COUNT(*) as count FROM embeddings e
                  WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = e.chunk_id)
                `);
                const orphanedEmbeddings = Number(
                  (orphanedEmbeddingsResult.rows[0] as any).count
                );

                // Delete orphaned embeddings first
                if (orphanedEmbeddings > 0) {
                  await client.execute(`
                    DELETE FROM embeddings e
                    WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = e.chunk_id)
                  `);
                }

                // Delete orphaned chunks
                if (orphanedChunks > 0) {
                  await client.execute(`
                    DELETE FROM chunks c
                    WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = c.doc_id)
                  `);
                }

                return {
                  orphanedChunks,
                  orphanedEmbeddings,
                  zeroVectorEmbeddings: 0, // LibSQL doesn't expose vector validation
                };
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),

          checkpoint: () =>
            Effect.tryPromise({
              try: async () => {
                // LibSQL file DBs auto-sync via WAL, no explicit checkpoint needed
                // client.sync() is only for Turso remote replication
                // Just run a PRAGMA to ensure WAL is flushed
                await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
              },
              catch: (e) =>
                new DatabaseError({ reason: `Checkpoint failed: ${e}` }),
            }),

          dumpDataDir: () =>
            Effect.fail(
              new DatabaseError({
                reason: "dumpDataDir not supported for LibSQL",
              })
            ),

          streamEmbeddings: async function* (batchSize: number) {
            // Stream embeddings in batches to avoid loading all into memory
            // Useful for clustering large embedding sets
            let offset = 0;

            while (true) {
              const result = await client.execute({
                sql: `SELECT chunk_id, embedding FROM embeddings LIMIT ? OFFSET ?`,
                args: [batchSize, offset],
              });

              if (result.rows.length === 0) break;

              // Convert rows to expected format
              const batch = result.rows.map((row: any) => ({
                chunkId: row.chunk_id as string,
                embedding: Array.from(row.embedding as Float32Array),
              }));

              yield batch;

              if (result.rows.length < batchSize) break;
              offset += batchSize;
            }
          },

          bulkInsertClusterAssignments: (assignments) =>
            Effect.tryPromise({
              try: async () => {
                if (assignments.length === 0) return;

                // Use batch for atomic transaction
                const statements = assignments.map((a) => ({
                  sql: "INSERT INTO chunk_clusters (chunk_id, cluster_id, distance) VALUES (?, ?, ?)",
                  args: [a.chunkId, a.clusterId, a.distance],
                }));

                await client.batch(statements, "write");
              },
              catch: (e) => new DatabaseError({ reason: String(e) }),
            }),
        };
      })
    );
  }
}

// ============================================================================
// Schema Initialization
// ============================================================================

async function initSchema(client: Client): Promise<void> {
  // Set busy timeout to wait up to 30s for locks instead of failing immediately
  await client.execute("PRAGMA busy_timeout = 30000");

  // Ensure WAL mode for better concurrent access
  await client.execute("PRAGMA journal_mode = WAL");

  // Documents table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      added_at TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      tags TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}'
    )
  `);

  // Chunks table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL
    )
  `);

  // Embeddings table with F32_BLOB for vectors
  await client.execute(`
    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      embedding F32_BLOB(${EMBEDDING_DIM}) NOT NULL
    )
  `);

  // Create indexes
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id)`
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_docs_path ON documents(path)`
  );

  // Vector index for fast ANN search (DiskANN algorithm)
  // compress_neighbors=float8 reduces index size ~4x with minimal recall loss (~1-2%)
  await client.execute(
    `CREATE INDEX IF NOT EXISTS embeddings_idx ON embeddings(libsql_vector_idx(embedding, 'compress_neighbors=float8'))`
  );

  // FTS5 virtual table for full-text search
  await client.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts 
    USING fts5(content, content='chunks', content_rowid='rowid')
  `);

  // ============================================================================
  // SKOS Taxonomy Schema (W3C Knowledge Organization)
  // ============================================================================
  //
  // HIERARCHY TRAVERSAL PATTERNS (LibSQL has no graph extensions)
  // Use recursive CTEs for transitive queries:
  //
  // Get all ancestors (transitive broader):
  //   WITH RECURSIVE ancestors AS (
  //     SELECT broader_id FROM concept_hierarchy WHERE concept_id = ?
  //     UNION
  //     SELECT ch.broader_id FROM concept_hierarchy ch
  //     JOIN ancestors a ON ch.concept_id = a.broader_id
  //   )
  //   SELECT * FROM concepts WHERE id IN (SELECT broader_id FROM ancestors);
  //
  // Get all descendants (transitive narrower):
  //   WITH RECURSIVE descendants AS (
  //     SELECT concept_id FROM concept_hierarchy WHERE broader_id = ?
  //     UNION
  //     SELECT ch.concept_id FROM concept_hierarchy ch
  //     JOIN descendants d ON ch.broader_id = d.concept_id
  //   )
  //   SELECT * FROM concepts WHERE id IN (SELECT concept_id FROM descendants);

  // Concepts table - stores controlled vocabulary terms
  await client.execute(`
    CREATE TABLE IF NOT EXISTS concepts (
      id TEXT PRIMARY KEY,
      pref_label TEXT NOT NULL,
      alt_labels TEXT DEFAULT '[]',
      definition TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // Concept Hierarchy - polyhierarchy support (multiple parents)
  // Uses broader/narrower semantics from SKOS
  await client.execute(`
    CREATE TABLE IF NOT EXISTS concept_hierarchy (
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      broader_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      PRIMARY KEY(concept_id, broader_id)
    )
  `);

  // Concept Relations - associative relationships (SKOS 'related')
  await client.execute(`
    CREATE TABLE IF NOT EXISTS concept_relations (
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      related_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      relation_type TEXT DEFAULT 'related',
      PRIMARY KEY(concept_id, related_id)
    )
  `);

  // Document-Concept mappings - link documents to concepts
  await client.execute(`
    CREATE TABLE IF NOT EXISTS document_concepts (
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      confidence REAL DEFAULT 1.0,
      source TEXT DEFAULT 'llm',
      PRIMARY KEY(doc_id, concept_id)
    )
  `);

  // Concept Embeddings - vector representations of concepts (unified with document embeddings)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS concept_embeddings (
      concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
      embedding F32_BLOB(${EMBEDDING_DIM}) NOT NULL
    )
  `);

  // Taxonomy indexes for efficient hierarchy traversal
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_concept_hierarchy_concept ON concept_hierarchy(concept_id)`
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_concept_hierarchy_broader ON concept_hierarchy(broader_id)`
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_concept_relations_concept ON concept_relations(concept_id)`
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_concept_relations_related ON concept_relations(related_id)`
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_document_concepts_doc ON document_concepts(doc_id)`
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_document_concepts_concept ON document_concepts(concept_id)`
  );

  // Vector index for concept embeddings (same compression as document embeddings)
  await client.execute(
    `CREATE INDEX IF NOT EXISTS concept_embeddings_idx ON concept_embeddings(libsql_vector_idx(embedding, 'compress_neighbors=float8'))`
  );

  // ============================================================================
  // RAPTOR Clustering Schema (Hard Clustering with K-means)
  // ============================================================================
  //
  // RAPTOR-style multi-scale retrieval where queries can match:
  // 1. Individual chunks (leaf nodes)
  // 2. Cluster summaries (intermediate nodes)
  //
  // Uses hard clustering (k-means) where each chunk belongs to exactly one cluster
  // with a distance metric to the centroid.

  // Chunk-Cluster assignments (hard membership with distance to centroid)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS chunk_clusters (
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      cluster_id INTEGER NOT NULL,
      distance REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(chunk_id, cluster_id)
    )
  `);

  // Cluster summaries with embedded metadata
  // Combines cluster metadata, summary, and concept mapping in a single table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS cluster_summaries (
      id INTEGER PRIMARY KEY,
      centroid F32_BLOB(${EMBEDDING_DIM}),
      summary TEXT,
      embedding F32_BLOB(${EMBEDDING_DIM}),
      concept_id TEXT,
      concept_confidence REAL,
      chunk_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Indexes for efficient cluster queries
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_chunk_clusters_cluster ON chunk_clusters(cluster_id)`
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_cluster_summaries_concept ON cluster_summaries(concept_id)`
  );

  // Vector index for cluster summary embeddings (for multi-scale retrieval)
  await client.execute(
    `CREATE INDEX IF NOT EXISTS cluster_summaries_idx ON cluster_summaries(libsql_vector_idx(embedding, 'compress_neighbors=float8'))`
  );

  // Triggers to keep FTS5 in sync with chunks table
  await client.execute(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai 
    AFTER INSERT ON chunks 
    BEGIN 
      INSERT INTO chunks_fts(rowid, content) 
      VALUES (new.rowid, new.content); 
    END
  `);

  await client.execute(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad 
    AFTER DELETE ON chunks 
    BEGIN 
      INSERT INTO chunks_fts(chunks_fts, rowid, content) 
      VALUES('delete', old.rowid, old.content); 
    END
  `);

  await client.execute(`
    CREATE TRIGGER IF NOT EXISTS chunks_au 
    AFTER UPDATE ON chunks 
    BEGIN 
      INSERT INTO chunks_fts(chunks_fts, rowid, content) 
      VALUES('delete', old.rowid, old.content);
      INSERT INTO chunks_fts(rowid, content) 
      VALUES (new.rowid, new.content);
    END
  `);
}
