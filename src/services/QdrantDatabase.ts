/**
 * Qdrant Database Service
 *
 * Implements the Database interface using @qdrant/js-client-rest.
 */

import { Effect, Layer } from "effect";
import { QdrantClient } from "@qdrant/js-client-rest";
import { Database } from "./Database.js";
import {
  DatabaseError,
  Document,
  PDFChunk,
  type SearchResult,
} from "../types.js";

const DEFAULT_EMBEDDING_DIM = 1024;
const DOCUMENT_VECTOR_DIM = 1;
const SCROLL_PAGE_SIZE = 256;

/**
 * Convert a short hex ID (e.g. "ee8fe2f3c810") to a valid UUID for Qdrant.
 * Pads/truncates to 32 hex chars and formats as UUID v4-ish.
 */
function hexToUuid(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "").padEnd(32, "0").slice(0, 32);
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20, 32)}`;
}

/**
 * Convert a UUID back to the original short hex ID.
 */
function uuidToHex(uuid: string): string {
  return uuid.replace(/-/g, "").replace(/0+$/, "") || "0";
}

type QdrantPayload = Record<string, unknown>;
type QdrantPoint = {
  id: string | number;
  payload?: QdrantPayload;
  vector?: unknown;
  score?: number;
};

export class QdrantDatabase {
  static make(config: {
    url: string;
    collection: string;
    apiKey?: string;
    embeddingDimension?: number;
  }) {
    const embeddingDimension = config.embeddingDimension ?? DEFAULT_EMBEDDING_DIM;
    const documentsCollection = `${config.collection}-documents`;
    const chunksCollection = `${config.collection}-chunks`;

    const client = new QdrantClient({
      url: config.url,
      apiKey: config.apiKey,
      checkCompatibility: false,
    });

    let initialized = false;
    let initializing: Promise<void> | null = null;

    const ensureCollections = async (): Promise<void> => {
      if (initialized) return;
      if (initializing) return initializing;

      initializing = (async () => {
        const docsExists = await client.collectionExists(documentsCollection);
        if (!docsExists.exists) {
          await client.createCollection(documentsCollection, {
            vectors: {
              size: DOCUMENT_VECTOR_DIM,
              distance: "Cosine",
            },
          });

          // Fast metadata filtering for document lookups/tag queries.
          await safeCreatePayloadIndex(client, documentsCollection, "path", "keyword");
          await safeCreatePayloadIndex(client, documentsCollection, "tags", "keyword");
          await safeCreatePayloadIndex(client, documentsCollection, "addedAt", "datetime");
        }

        const chunksExists = await client.collectionExists(chunksCollection);
        if (!chunksExists.exists) {
          await client.createCollection(chunksCollection, {
            vectors: {
              size: embeddingDimension,
              distance: "Cosine",
            },
          });

          // Payload indexes for structured filters + full text on chunk content.
          await safeCreatePayloadIndex(client, chunksCollection, "docId", "keyword");
          await safeCreatePayloadIndex(client, chunksCollection, "page", "integer");
          await safeCreatePayloadIndex(
            client,
            chunksCollection,
            "chunkIndex",
            "integer",
          );
          await safeCreatePayloadIndex(client, chunksCollection, "tags", "keyword");
          await safeCreatePayloadIndex(client, chunksCollection, "content", "text");
        }

        initialized = true;
      })();

      try {
        await initializing;
      } finally {
        initializing = null;
      }
    };

    const withDb = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: async () => {
          await ensureCollections();
          return run();
        },
        catch: (error) => {
          const msg = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? error.stack : undefined;
          console.error(`[QdrantDatabase] Error:`, msg, stack ? `\n${stack}` : '');
          return new DatabaseError({ reason: msg });
        },
      });

    const readDocumentsByIds = async (docIds: string[]): Promise<Map<string, QdrantPayload>> => {
      if (docIds.length === 0) return new Map();
      const records = await client.retrieve(documentsCollection, {
        ids: docIds.map(hexToUuid),
        with_payload: true,
        with_vector: false,
      });

      const map = new Map<string, QdrantPayload>();
      for (const record of records as unknown as QdrantPoint[]) {
        if (record.payload) {
          map.set(uuidToHex(String(record.id)), record.payload);
        }
      }
      return map;
    };

    return Layer.succeed(Database, {
      addDocument: (doc) =>
        withDb(async () => {
          await client.upsert(documentsCollection, {
            wait: true,
            points: [
              {
                id: hexToUuid(doc.id),
                vector: [0],
                payload: serializeDocument(doc),
              },
            ],
          });
        }),

      getDocument: (id) =>
        withDb(async () => {
          const records = await client.retrieve(documentsCollection, {
            ids: [hexToUuid(id)],
            with_payload: true,
            with_vector: false,
          });

          const first = (records[0] as unknown as QdrantPoint | undefined) ?? null;
          if (!first?.payload) return null;
          return payloadToDocument(first.id, first.payload);
        }),

      getDocumentByPath: (path) =>
        withDb(async () => {
          const records = await scrollAll(client, documentsCollection, {
            filter: {
              must: [
                {
                  key: "path",
                  match: { value: path },
                },
              ],
            },
            with_payload: true,
            with_vector: false,
          });

          const first = records[0];
          if (!first?.payload) return null;
          return payloadToDocument(first.id, first.payload);
        }),

      listDocuments: (tag) =>
        withDb(async () => {
          const filter =
            tag && tag.length > 0
              ? {
                  must: [
                    {
                      key: "tags",
                      match: { any: [tag] },
                    },
                  ],
                }
              : undefined;

          const records = await scrollAll(client, documentsCollection, {
            filter,
            with_payload: true,
            with_vector: false,
          });

          return records
            .filter((record) => Boolean(record.payload))
            .map((record) => payloadToDocument(record.id, record.payload!))
            .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
        }),

      deleteDocument: (id) =>
        withDb(async () => {
          await client.delete(documentsCollection, {
            wait: true,
            points: [hexToUuid(id)],
          });

          await client.delete(chunksCollection, {
            wait: true,
            filter: {
              must: [
                {
                  key: "docId",
                  match: { value: id },
                },
              ],
            },
          });
        }),

      updateTags: (id, tags) =>
        withDb(async () => {
          await client.setPayload(documentsCollection, {
            points: [hexToUuid(id)],
            payload: { tags },
          });

          await client.setPayload(chunksCollection, {
            filter: {
              must: [
                {
                  key: "docId",
                  match: { value: id },
                },
              ],
            },
            payload: { tags },
          });
        }),

      addChunks: (chunks) =>
        withDb(async () => {
          if (chunks.length === 0) return;

          const docIds = [...new Set(chunks.map((chunk) => chunk.docId))];
          const docsById = await readDocumentsByIds(docIds);

          const points = chunks.map((chunk) => {
            const docPayload = docsById.get(chunk.docId);

            return {
              id: hexToUuid(chunk.id),
              vector: zeroVector(embeddingDimension),
              payload: {
                id: hexToUuid(chunk.id),
                docId: chunk.docId,
                page: chunk.page,
                chunkIndex: chunk.chunkIndex,
                content: chunk.content,
                title: asString(docPayload?.title),
                path: asString(docPayload?.path),
                tags: asStringArray(docPayload?.tags),
                hasEmbedding: false,
                embeddingOnly: false,
              },
            };
          });

          await client.upsert(chunksCollection, {
            wait: true,
            points,
          });
        }),

      getChunk: (chunkId) =>
        withDb(async () => {
          const records = await client.retrieve(chunksCollection, {
            ids: [hexToUuid(chunkId)],
            with_payload: true,
            with_vector: false,
          });

          const point = (records[0] as unknown as QdrantPoint | undefined) ?? null;
          if (!point?.payload) return null;
          return payloadToChunk(point.id, point.payload);
        }),

      listChunksByDocument: (docId, opts) =>
        withDb(async () => {
          const must: Array<Record<string, unknown>> = [
            {
              key: "docId",
              match: { value: docId },
            },
          ];

          if (typeof opts?.page === "number") {
            must.push({
              key: "page",
              match: { value: opts.page },
            });
          }

          const records = await scrollAll(client, chunksCollection, {
            filter: { must },
            with_payload: true,
            with_vector: false,
          });

          return records
            .filter((record) => Boolean(record.payload))
            .map((record) => payloadToChunk(record.id, record.payload!))
            .sort(compareChunks);
        }),

      addEmbeddings: (embeddings) =>
        withDb(async () => {
          if (embeddings.length === 0) return;

          const ids = embeddings.map((item) => hexToUuid(item.chunkId));
          const existing = await client.retrieve(chunksCollection, {
            ids,
            with_payload: true,
            with_vector: false,
          });

          const existingById = new Map<string, QdrantPayload>();
          for (const record of existing as unknown as QdrantPoint[]) {
            if (record.payload) {
              existingById.set(String(record.id), record.payload);
            }
          }

          const points = embeddings.map((item) => {
            const existingPayload = existingById.get(hexToUuid(item.chunkId));

            if (!existingPayload) {
              return {
                id: hexToUuid(item.chunkId),
                vector: item.embedding,
                payload: {
                  id: hexToUuid(item.chunkId),
                  docId: "",
                  page: 0,
                  chunkIndex: 0,
                  content: "",
                  title: "",
                  path: "",
                  tags: [],
                  hasEmbedding: true,
                  embeddingOnly: true,
                },
              };
            }

            return {
              id: hexToUuid(item.chunkId),
              vector: item.embedding,
              payload: {
                ...existingPayload,
                hasEmbedding: true,
                embeddingOnly: asBoolean(existingPayload.embeddingOnly),
              },
            };
          });

          await client.upsert(chunksCollection, {
            wait: true,
            points,
          });
        }),

      replaceDocument: (doc, chunks, embeddings) =>
        withDb(async () => {
          await client.upsert(documentsCollection, {
            wait: true,
            points: [
              {
                id: hexToUuid(doc.id),
                vector: [0],
                payload: serializeDocument(doc),
              },
            ],
          });

          await client.delete(chunksCollection, {
            wait: true,
            filter: {
              must: [
                {
                  key: "docId",
                  match: { value: doc.id },
                },
              ],
            },
          });

          if (chunks.length > 0) {
            await client.upsert(chunksCollection, {
              wait: true,
              points: chunks.map((chunk) => ({
                id: hexToUuid(chunk.id),
                vector: zeroVector(embeddingDimension),
                payload: {
                  id: hexToUuid(chunk.id),
                  docId: chunk.docId,
                  page: chunk.page,
                  chunkIndex: chunk.chunkIndex,
                  content: chunk.content,
                  title: doc.title,
                  path: doc.path,
                  tags: doc.tags,
                  hasEmbedding: false,
                  embeddingOnly: false,
                },
              })),
            });
          }

          if (embeddings.length > 0) {
            const embeddingMap = new Map<string, number[]>(
              embeddings.map((item) => [item.chunkId, item.embedding]),
            );

            await client.upsert(chunksCollection, {
              wait: true,
              points: chunks.map((chunk) => ({
                id: hexToUuid(chunk.id),
                vector:
                  embeddingMap.get(chunk.id) ?? zeroVector(embeddingDimension),
                payload: {
                  id: hexToUuid(chunk.id),
                  docId: chunk.docId,
                  page: chunk.page,
                  chunkIndex: chunk.chunkIndex,
                  content: chunk.content,
                  title: doc.title,
                  path: doc.path,
                  tags: doc.tags,
                  hasEmbedding: embeddingMap.has(chunk.id),
                  embeddingOnly: false,
                },
              })),
            });
          }
        }),

      vectorSearch: (embedding, options) =>
        withDb(async () => {
          const { limit = 10, tags, threshold = 0.0 } = options || {};

          const must: Array<Record<string, unknown>> = [
            {
              key: "hasEmbedding",
              match: { value: true },
            },
          ];

          if (tags && tags.length > 0) {
            must.push({
              key: "tags",
              match: { any: tags },
            });
          }

          const points = await client.search(chunksCollection, {
            vector: embedding,
            limit,
            with_payload: true,
            with_vector: false,
            filter: { must },
            score_threshold: threshold > 0 ? threshold : undefined,
          });

          return (points as unknown as QdrantPoint[])
            .filter((point) => Boolean(point.payload))
            .map((point) => pointToVectorResult(point));
        }),

      ftsSearch: (query, options) =>
        withDb(async () => {
          const { limit = 10, tags } = options || {};

          const must: Array<Record<string, unknown>> = [
            {
              key: "content",
              match: { text: query },
            },
          ];

          if (tags && tags.length > 0) {
            must.push({
              key: "tags",
              match: { any: tags },
            });
          }

          const points = await scrollAll(client, chunksCollection, {
            filter: { must },
            with_payload: true,
            with_vector: false,
          });

          return points
            .filter((point) => Boolean(point.payload))
            .map((point) => {
              const payload = point.payload!;
              const content = asString(payload.content);
              const raw = fullTextRank(content, query);
              const score = raw / (1 + raw);

              return {
                chunkId: String(point.id),
                docId: asString(payload.docId),
                title: asString(payload.title),
                page: asNumber(payload.page),
                chunkIndex: asNumber(payload.chunkIndex),
                content,
                score,
                rawScore: raw,
                scoreType: "fts_rank",
                ftsRank: raw,
                matchType: "fts",
              } as SearchResult;
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
        }),

      getExpandedContext: (docId, page, chunkIndex, options) =>
        withDb(async () => {
          const { maxChars = 2000, direction = "both" } = options || {};

          const points = await scrollAll(client, chunksCollection, {
            filter: {
              must: [
                {
                  key: "docId",
                  match: { value: docId },
                },
              ],
            },
            with_payload: true,
            with_vector: false,
          });

          const chunks = points
            .filter((point) => Boolean(point.payload))
            .map((point) => payloadToChunk(point.id, point.payload!))
            .sort(compareChunks);

          const targetIndex = chunks.findIndex(
            (chunk) => chunk.page === page && chunk.chunkIndex === chunkIndex,
          );

          if (targetIndex < 0) {
            return {
              content: "",
              startChunk: `p${page}c${chunkIndex}`,
              endChunk: `p${page}c${chunkIndex}`,
            };
          }

          let start = targetIndex;
          let end = targetIndex;
          let total = chunks[targetIndex]!.content;

          if (direction === "before" || direction === "both") {
            for (let i = targetIndex - 1; i >= 0; i--) {
              const next = chunks[i]!.content;
              if (total.length + next.length > maxChars * 1.2) break;
              total = `${next}\n${total}`;
              start = i;
            }
          }

          if (direction === "after" || direction === "both") {
            for (let i = targetIndex + 1; i < chunks.length; i++) {
              const next = chunks[i]!.content;
              if (total.length + next.length > maxChars * 1.2) break;
              total = `${total}\n${next}`;
              end = i;
            }
          }

          return {
            content: total,
            startChunk: `p${chunks[start]!.page}c${chunks[start]!.chunkIndex}`,
            endChunk: `p${chunks[end]!.page}c${chunks[end]!.chunkIndex}`,
          };
        }),

      getStats: () =>
        withDb(async () => {
          const [documents, chunks, embeddings] = await Promise.all([
            client.count(documentsCollection, { exact: true }),
            client.count(chunksCollection, { exact: true }),
            client.count(chunksCollection, {
              exact: true,
              filter: {
                must: [
                  {
                    key: "hasEmbedding",
                    match: { value: true },
                  },
                ],
              },
            }),
          ]);

          return {
            documents: documents.count,
            chunks: chunks.count,
            embeddings: embeddings.count,
          };
        }),

      countChunksByDocumentIds: (docIds) =>
        withDb(async () => {
          const counts: Record<string, number> = {};
          if (docIds.length === 0) return counts;

          for (const docId of docIds) {
            const result = await client.count(chunksCollection, {
              exact: true,
              filter: {
                must: [
                  {
                    key: "docId",
                    match: { value: docId },
                  },
                ],
              },
            });
            counts[docId] = result.count;
          }

          return counts;
        }),

      repair: () =>
        withDb(async () => {
          const docs = await scrollAll(client, documentsCollection, {
            with_payload: false,
            with_vector: false,
          });
          const docIds = new Set(docs.map((doc) => String(doc.id)));

          const chunks = await scrollAll(client, chunksCollection, {
            with_payload: true,
            with_vector: true,
          });

          const orphanedEmbeddingIds: Array<string | number> = [];
          const orphanedChunkIds: Array<string | number> = [];
          let zeroVectorEmbeddings = 0;

          for (const point of chunks) {
            const payload = point.payload ?? {};
            const hasEmbedding = asBoolean(payload.hasEmbedding);
            const isEmbeddingOnly = asBoolean(payload.embeddingOnly);

            if (hasEmbedding && isZeroVector(point.vector)) {
              zeroVectorEmbeddings += 1;
            }

            if (isEmbeddingOnly) {
              orphanedEmbeddingIds.push(point.id);
              continue;
            }

            const docId = asString(payload.docId);
            if (docId.length > 0 && !docIds.has(docId)) {
              orphanedChunkIds.push(point.id);
            }
          }

          if (orphanedEmbeddingIds.length > 0) {
            await client.delete(chunksCollection, {
              wait: true,
              points: orphanedEmbeddingIds,
            });
          }

          if (orphanedChunkIds.length > 0) {
            await client.delete(chunksCollection, {
              wait: true,
              points: orphanedChunkIds,
            });
          }

          return {
            orphanedChunks: orphanedChunkIds.length,
            orphanedEmbeddings: orphanedEmbeddingIds.length,
            zeroVectorEmbeddings,
          };
        }),

      checkpoint: () => withDb(async () => {}),

      dumpDataDir: () => withDb(async () => new Blob([])),

      streamEmbeddings: async function* (batchSize: number) {
        await ensureCollections();

        let offset: string | number | undefined;

        while (true) {
          const page = await client.scroll(chunksCollection, {
            limit: batchSize,
            offset,
            with_payload: false,
            with_vector: true,
            filter: {
              must: [
                {
                  key: "hasEmbedding",
                  match: { value: true },
                },
              ],
            },
          });

          const points = ((page.points ?? []) as unknown as QdrantPoint[])
            .filter((point) => Array.isArray(point.vector))
            .map((point) => ({
              chunkId: String(point.id),
              embedding: point.vector as number[],
            }));

          if (points.length > 0) {
            yield points;
          }

          if (!page.next_page_offset) break;
          offset = page.next_page_offset;
        }
      },

      bulkInsertClusterAssignments: (assignments) =>
        withDb(async () => {
          for (const assignment of assignments) {
            await client.setPayload(chunksCollection, {
              points: [assignment.chunkId],
              payload: {
                clusterId: assignment.clusterId,
                clusterDistance: assignment.distance,
              },
            });
          }
        }),
    });
  }
}

async function safeCreatePayloadIndex(
  client: QdrantClient,
  collection: string,
  field: string,
  fieldSchema: "keyword" | "integer" | "text" | "datetime",
): Promise<void> {
  try {
    await client.createPayloadIndex(collection, {
      wait: true,
      field_name: field,
      field_schema: fieldSchema,
    });
  } catch {
    // Index may already exist depending on Qdrant version/configuration.
  }
}

async function scrollAll(
  client: QdrantClient,
  collection: string,
  args: {
    filter?: Record<string, unknown>;
    with_payload?: boolean;
    with_vector?: boolean;
  },
): Promise<QdrantPoint[]> {
  const points: QdrantPoint[] = [];
  let offset: string | number | undefined;

  while (true) {
    const page = await client.scroll(collection, {
      ...args,
      limit: SCROLL_PAGE_SIZE,
      offset,
    });

    const batch = (page.points ?? []) as unknown as QdrantPoint[];
    points.push(...batch);

    if (!page.next_page_offset) {
      break;
    }

    offset = page.next_page_offset;
  }

  return points;
}

function serializeDocument(doc: Document): QdrantPayload {
  return {
    id: hexToUuid(doc.id),
    title: doc.title,
    path: doc.path,
    addedAt: doc.addedAt.toISOString(),
    pageCount: doc.pageCount,
    sizeBytes: doc.sizeBytes,
    tags: doc.tags,
    fileType: doc.fileType,
    metadata: doc.metadata ?? {},
  };
}

function payloadToDocument(id: string | number, payload: QdrantPayload): Document {
  return new Document({
    id: uuidToHex(String(id)),
    title: asString(payload.title),
    path: asString(payload.path),
    addedAt: new Date(asString(payload.addedAt)),
    pageCount: asNumber(payload.pageCount),
    sizeBytes: asNumber(payload.sizeBytes),
    tags: asStringArray(payload.tags),
    fileType: asString(payload.fileType) === "markdown" ? "markdown" : "pdf",
    metadata: asRecord(payload.metadata),
  });
}

function payloadToChunk(id: string | number, payload: QdrantPayload): PDFChunk {
  return new PDFChunk({
    id: uuidToHex(String(id)),
    docId: asString(payload.docId),
    page: asNumber(payload.page),
    chunkIndex: asNumber(payload.chunkIndex),
    content: asString(payload.content),
  });
}

function pointToVectorResult(point: QdrantPoint): SearchResult {
  const payload = point.payload ?? {};
  const score = typeof point.score === "number" ? point.score : 0;

  return {
    chunkId: String(point.id),
    docId: asString(payload.docId),
    title: asString(payload.title),
    page: asNumber(payload.page),
    chunkIndex: asNumber(payload.chunkIndex),
    content: asString(payload.content),
    score,
    rawScore: score,
    scoreType: "cosine_similarity",
    vectorScore: score,
    matchType: "vector",
  } as SearchResult;
}

function zeroVector(length: number): number[] {
  return Array.from({ length }, () => 0);
}

function compareChunks(a: PDFChunk, b: PDFChunk): number {
  if (a.page !== b.page) return a.page - b.page;
  return a.chunkIndex - b.chunkIndex;
}

function fullTextRank(content: string, query: string): number {
  if (!content || !query) return 0;

  const haystack = content.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let cursor = 0;
  while (true) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    score += 1;
    cursor = index + needle.length;
  }

  return score;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function isZeroVector(vector: unknown): boolean {
  if (!Array.isArray(vector)) return false;
  if (vector.length === 0) return true;
  return vector.every((value) => typeof value === "number" && Math.abs(value) < 1e-12);
}
