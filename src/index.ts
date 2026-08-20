/**
 * PDF Library - Local PDF knowledge base with vector search
 *
 * Built with Effect for robust error handling and composability.
 */

import { Duration, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";

import {
  AddOptions,
  Document,
  DocumentExistsError,
  DocumentNotFoundError,
  LibraryConfig,
  SearchOptions,
  SearchResult,
} from "./types.js";
import { DEFAULT_QUEUE_CONFIG } from "./services/EmbeddingQueue.js";

import {
  Ollama,
  OllamaLive,
  probeEmbeddingDimension,
  getEmbeddingDimension,
} from "./services/Ollama.js";
import {
  EmbeddingProvider,
  EmbeddingProviderLive,
  EmbeddingProviderFullLive,
} from "./services/EmbeddingProvider.js";
import type { EmbeddingError } from "./services/EmbeddingProvider.js";
import { GatewayLive } from "./services/Gateway.js";
import { PDFExtractor, PDFExtractorLive } from "./services/PDFExtractor.js";
import {
  MarkdownExtractor,
  MarkdownExtractorLive,
} from "./services/MarkdownExtractor.js";
import { Database } from "./services/Database.js";
import { LibSQLDatabase } from "./services/LibSQLDatabase.js";
import { DatabaseRegistry } from "./services/DatabaseRegistry.js";
import { logDebug } from "./logger.js";
import { buildChunkerMetadata } from "./chunking.js";

// Re-export types and services
export * from "./types.js";
export {
  Ollama,
  OllamaLive,
  probeEmbeddingDimension,
  getEmbeddingDimension,
} from "./services/Ollama.js";
export {
  EmbeddingProvider,
  EmbeddingProviderLive,
  EmbeddingProviderFullLive,
} from "./services/EmbeddingProvider.js";
export type { EmbeddingError } from "./services/EmbeddingProvider.js";
export { PDFExtractor, PDFExtractorLive } from "./services/PDFExtractor.js";
export {
  MarkdownExtractor,
  MarkdownExtractorLive,
} from "./services/MarkdownExtractor.js";
export { Database } from "./services/Database.js";
export { LibSQLDatabase } from "./services/LibSQLDatabase.js";
export { DatabaseRegistry } from "./services/DatabaseRegistry.js";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a file is a markdown file based on extension
 */
function isMarkdownFile(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown");
}

// ============================================================================
// Library Service
// ============================================================================

/**
 * Main PDF Library service that composes all dependencies
 */
export class PDFLibrary extends Effect.Service<PDFLibrary>()("PDFLibrary", {
  effect: Effect.gen(function* () {
    const embedProvider = yield* EmbeddingProvider;
    const pdfExtractor = yield* PDFExtractor;
    const markdownExtractor = yield* MarkdownExtractor;
    const db = yield* Database;
    const config = LibraryConfig.fromEnv();

    return {
      /**
       * Check if embedding provider is ready
       */
      checkReady: () => embedProvider.checkHealth(),

      /**
       * Add a PDF or Markdown file to the library
       */
      add: (pdfPath: string, options: AddOptions = new AddOptions({})) =>
        Effect.gen(function* () {
          // Resolve path
          const resolvedPath = pdfPath.startsWith("~")
            ? pdfPath.replace("~", (process.env.HOME || homedir()))
            : pdfPath;

          // Check if already exists
          const existing = yield* db.getDocumentByPath(resolvedPath);
          if (existing) {
            return yield* Effect.fail(
              new DocumentExistsError({
                title: existing.title,
                path: resolvedPath,
              }),
            );
          }

          // Check embedding provider
          yield* embedProvider.checkHealth();

          const stat = statSync(resolvedPath);
          const id = createHash("sha256")
            .update(resolvedPath)
            .digest("hex")
            .slice(0, 12);

          // Detect file type and route to appropriate extractor
          const isMarkdown = isMarkdownFile(resolvedPath);
          const fileType = isMarkdown
            ? ("markdown" as const)
            : ("pdf" as const);

          // Determine title based on file type
          let title: string;
          if (options.title) {
            title = options.title;
          } else if (isMarkdown) {
            // For markdown: try frontmatter title, then first H1, then filename
            const frontmatterResult = yield* Effect.either(
              markdownExtractor.extractFrontmatter(resolvedPath),
            );

            if (
              frontmatterResult._tag === "Right" &&
              frontmatterResult.right.title
            ) {
              // Use frontmatter title if available
              title = frontmatterResult.right.title;
            } else {
              // Try first H1 from sections
              const extractResult = yield* Effect.either(
                markdownExtractor.extract(resolvedPath),
              );
              if (
                extractResult._tag === "Right" &&
                extractResult.right.sections.length > 0
              ) {
                const firstH1 = extractResult.right.sections.find(
                  (s) => s.heading,
                );
                title =
                  firstH1?.heading ||
                  basename(resolvedPath).replace(/\.(md|markdown)$/i, "");
              } else {
                // Fallback to filename without extension
                title = basename(resolvedPath).replace(/\.(md|markdown)$/i, "");
              }
            }
          } else {
            title = basename(resolvedPath, ".pdf");
          }

          // Process file with appropriate extractor
          let pageCount: number;
          let chunks: Array<{
            page: number;
            chunkIndex: number;
            content: string;
          }>;

          if (isMarkdown) {
            const processResult = yield* Effect.either(
              markdownExtractor.process(resolvedPath),
            );
            if (processResult._tag === "Left") {
              yield* Effect.log(
                `Markdown extraction failed for ${resolvedPath}: ${processResult.left}`,
              );
              return yield* Effect.fail(processResult.left);
            }
            pageCount = processResult.right.pageCount;
            chunks = processResult.right.chunks;
          } else {
            const processResult = yield* Effect.either(
              pdfExtractor.process(resolvedPath),
            );
            if (processResult._tag === "Left") {
              yield* Effect.log(
                `PDF extraction failed for ${resolvedPath}: ${processResult.left}`,
              );
              return yield* Effect.fail(processResult.left);
            }
            pageCount = processResult.right.pageCount;
            chunks = processResult.right.chunks;
          }

          if (chunks.length === 0) {
            return yield* Effect.fail(
              new DocumentNotFoundError({
                query: `No text content extracted from ${fileType}`,
              }),
            );
          }

          // Create document
          const chunker = buildChunkerMetadata(fileType, config);
          const mergedMetadata: Record<string, unknown> = {
            ...(options.metadata ?? {}),
            // Always stamp the chunker used to generate the current chunks/embeddings.
            chunker,
          };

          const doc = new Document({
            id,
            title,
            path: resolvedPath,
            addedAt: options.addedAt ?? new Date(),
            pageCount,
            sizeBytes: stat.size,
            tags: options.tags || [],
            fileType,
            metadata: mergedMetadata,
          });

          // Add document to DB
          yield* db.addDocument(doc);

          // Add chunks
          const chunkRecords = chunks.map((chunk, i) => ({
            id: `${id}-${i}`,
            docId: id,
            page: chunk.page,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
          }));
          yield* db.addChunks(chunkRecords);

          // Generate embeddings with gated batching to prevent WASM OOM
          // This processes in batches of 50, checkpointing after each batch
          // to keep WAL size bounded and prevent daemon crashes
          const batchSize = DEFAULT_QUEUE_CONFIG.batchSize;
          yield* Effect.log(
            `Generating embeddings for ${chunks.length} chunks (batch size: ${batchSize})...`,
          );

          const contents = chunks.map((c) => c.content);

          // Process embeddings in gated batches
          // Each batch: generate embeddings → write to DB → checkpoint
          for (
            let batchIdx = 0;
            batchIdx * batchSize < contents.length;
            batchIdx++
          ) {
            const batchStart = batchIdx * batchSize;
            const batchEnd = Math.min(batchStart + batchSize, contents.length);
            const batchContents = contents.slice(batchStart, batchEnd);

            yield* Effect.log(
              `  Batch ${batchIdx}: generating embeddings for indices ${batchStart}-${batchEnd - 1}`,
            );

            // Generate embeddings for this batch with bounded concurrency
            const batchEmbeddings = yield* embedProvider.embedBatch(
              batchContents,
              DEFAULT_QUEUE_CONFIG.concurrency,
            );

            yield* Effect.log(
              `  Batch ${batchIdx}: got ${batchEmbeddings.length} embeddings`,
            );

            // Store this batch's embeddings
            // NOTE: Use explicit for-loop to avoid Effect generator closure issues
            // The .map() closure was capturing stale batchStart values
            const embeddingRecords: Array<{
              chunkId: string;
              embedding: number[];
            }> = [];
            for (let i = 0; i < batchEmbeddings.length; i++) {
              const chunkIndex = batchIdx * batchSize + i;
              embeddingRecords.push({
                chunkId: `${id}-${chunkIndex}`,
                embedding: batchEmbeddings[i],
              });
            }

            yield* Effect.log(
              `  Batch ${batchIdx}: inserting ${embeddingRecords[0]?.chunkId} to ${embeddingRecords[embeddingRecords.length - 1]?.chunkId}`,
            );
            yield* db.addEmbeddings(embeddingRecords);

            // CRITICAL: Checkpoint after each batch to flush WAL
            // This prevents WASM OOM from unbounded WAL growth
            yield* db.checkpoint();

            yield* Effect.log(
              `  Processed ${batchEnd}/${contents.length} embeddings`,
            );

            // Backpressure: small delay between batches to let GC run
            if (batchEnd < contents.length) {
              yield* Effect.sleep(
                Duration.millis(DEFAULT_QUEUE_CONFIG.batchDelayMs),
              );
            }
          }

          return doc;
        }),

      /**
       * Replace/rebuild an existing document in-place (non-destructive).
       *
       * This is the agent-safe primitive used by `pdf-brain rechunk`.
       * The DB update is performed as a single transaction: doc upsert +
       * delete old chunks + insert new chunks + insert new embeddings.
       */
      replace: (pdfPath: string, options: AddOptions = new AddOptions({})) =>
        Effect.gen(function* () {
          // Resolve path
          const resolvedPath = pdfPath.startsWith("~")
            ? pdfPath.replace("~", (process.env.HOME || homedir()))
            : pdfPath;

          // Require existing doc (this is "replace", not "add")
          const existing = yield* db.getDocumentByPath(resolvedPath);
          if (!existing) {
            return yield* Effect.fail(
              new DocumentNotFoundError({ query: resolvedPath }),
            );
          }

          // Check embedding provider before doing any work
          yield* embedProvider.checkHealth();

          const stat = statSync(resolvedPath);
          const id = existing.id;

          // Detect file type and route to appropriate extractor
          const isMarkdown = isMarkdownFile(resolvedPath);
          const fileType = isMarkdown
            ? ("markdown" as const)
            : ("pdf" as const);

          // Preserve existing title/tags/metadata by default
          const title = options.title ?? existing.title;
          const tags = options.tags ?? existing.tags;
          const baseMetadata: Record<string, unknown> =
            options.metadata ?? (existing.metadata ?? {});

          // Process file with appropriate extractor
          let pageCount: number;
          let chunks: Array<{
            page: number;
            chunkIndex: number;
            content: string;
          }>;

          if (isMarkdown) {
            const processResult = yield* Effect.either(
              markdownExtractor.process(resolvedPath),
            );
            if (processResult._tag === "Left") {
              return yield* Effect.fail(processResult.left);
            }
            pageCount = processResult.right.pageCount;
            chunks = processResult.right.chunks;
          } else {
            const processResult = yield* Effect.either(
              pdfExtractor.process(resolvedPath),
            );
            if (processResult._tag === "Left") {
              return yield* Effect.fail(processResult.left);
            }
            pageCount = processResult.right.pageCount;
            chunks = processResult.right.chunks;
          }

          if (chunks.length === 0) {
            return yield* Effect.fail(
              new DocumentNotFoundError({
                query: `No text content extracted from ${fileType}`,
              }),
            );
          }

          // Stamp current chunker metadata (always overwrite)
          const chunker = buildChunkerMetadata(fileType, config);
          const mergedMetadata: Record<string, unknown> = {
            ...baseMetadata,
            chunker,
          };

          const doc = new Document({
            id,
            title,
            path: resolvedPath,
            addedAt: options.addedAt ?? existing.addedAt,
            pageCount,
            sizeBytes: stat.size,
            tags,
            fileType,
            metadata: mergedMetadata,
          });

          const chunkRecords = chunks.map((chunk, i) => ({
            id: `${id}-${i}`,
            docId: id,
            page: chunk.page,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
          }));

          // Generate all embeddings before touching the DB (non-destructive).
          const batchSize = DEFAULT_QUEUE_CONFIG.batchSize;
          const contents = chunks.map((c) => c.content);

          const embeddingRecords: Array<{ chunkId: string; embedding: number[] }> = [];

          for (
            let batchIdx = 0;
            batchIdx * batchSize < contents.length;
            batchIdx++
          ) {
            const batchStart = batchIdx * batchSize;
            const batchEnd = Math.min(batchStart + batchSize, contents.length);
            const batchContents = contents.slice(batchStart, batchEnd);

            const batchEmbeddings = yield* embedProvider.embedBatch(
              batchContents,
              DEFAULT_QUEUE_CONFIG.concurrency,
            );

            for (let i = 0; i < batchEmbeddings.length; i++) {
              const chunkIndex = batchIdx * batchSize + i;
              embeddingRecords.push({
                chunkId: `${id}-${chunkIndex}`,
                embedding: batchEmbeddings[i],
              });
            }

            if (batchEnd < contents.length) {
              yield* Effect.sleep(
                Duration.millis(DEFAULT_QUEUE_CONFIG.batchDelayMs),
              );
            }
          }

          // Atomic DB replacement
          yield* db.replaceDocument(doc, chunkRecords, embeddingRecords);
          yield* db.checkpoint();

          return doc;
        }),

      /**
       * Re-generate embeddings for an existing document using the current
       * embedding provider and model, without touching the document row or
       * chunks (non-destructive).
       *
       * This is the agent-safe primitive used by `pdf-brain reindex`.
       *
       * Note: we upsert embeddings by chunkId, so repeated calls are safe.
       */
      reindexEmbeddings: (docId: string) =>
        Effect.gen(function* () {
          // Require embedding provider (reindex is meaningless without it)
          yield* embedProvider.checkHealth();

          const existing = yield* db.getDocument(docId);
          if (!existing) {
            return yield* Effect.fail(new DocumentNotFoundError({ query: docId }));
          }

          const chunks = yield* db.listChunksByDocument(docId);
          if (chunks.length === 0) {
            return yield* Effect.fail(
              new DocumentNotFoundError({
                query: `No chunks found for document ${docId}`,
              }),
            );
          }

          const batchSize = DEFAULT_QUEUE_CONFIG.batchSize;
          const embeddingRecords: Array<{ chunkId: string; embedding: number[] }> =
            [];

          for (
            let batchIdx = 0;
            batchIdx * batchSize < chunks.length;
            batchIdx++
          ) {
            const batchStart = batchIdx * batchSize;
            const batchEnd = Math.min(batchStart + batchSize, chunks.length);
            const batchChunks = chunks.slice(batchStart, batchEnd);
            const batchContents = batchChunks.map((c) => c.content);

            const batchEmbeddings = yield* embedProvider.embedBatch(
              batchContents,
              DEFAULT_QUEUE_CONFIG.concurrency,
            );

            for (let i = 0; i < batchEmbeddings.length; i++) {
              embeddingRecords.push({
                chunkId: batchChunks[i]!.id,
                embedding: batchEmbeddings[i]!,
              });
            }

            if (batchEnd < chunks.length) {
              yield* Effect.sleep(
                Duration.millis(DEFAULT_QUEUE_CONFIG.batchDelayMs),
              );
            }
          }

          // Atomic upsert for this document's embeddings.
          yield* db.addEmbeddings(embeddingRecords);
          yield* db.checkpoint();

          return {
            docId: existing.id,
            title: existing.title,
            chunks: chunks.length,
            embeddings: embeddingRecords.length,
          };
        }),

      /**
       * Search the library
       */
      search: (query: string, options: SearchOptions = new SearchOptions({})) =>
        Effect.gen(function* () {
          const { hybrid, limit, expandChars = 0 } = options;
          const results: SearchResult[] = [];

          // Vector search
          const healthCheck = yield* Effect.either(embedProvider.checkHealth());
          if (healthCheck._tag === "Right") {
            const queryEmbedding = yield* embedProvider.embed(query);
            const vectorResults = yield* db.vectorSearch(
              queryEmbedding,
              options,
            );
            results.push(...vectorResults);
          }

          // FTS search (if hybrid or vector unavailable)
          if (hybrid || healthCheck._tag === "Left") {
            const ftsResults = yield* db.ftsSearch(query, options);

            // Merge results, avoiding duplicates
            for (const fts of ftsResults) {
              const exists = results.find(
                (r) =>
                  r.docId === fts.docId &&
                  r.page === fts.page &&
                  r.chunkIndex === fts.chunkIndex,
              );
              if (!exists) {
                results.push(fts);
              } else {
                // Combine signals for matches found in both vector + FTS.
                const vectorScore = exists.vectorScore ?? exists.score;
                const ftsScore = fts.score; // already normalized 0..1
                const combined = Math.min(1, Math.max(vectorScore, ftsScore) * 1.05);

                const boosted = new SearchResult({
                  ...exists,
                  score: combined,
                  matchType: "hybrid",
                  scoreType: "hybrid",
                  rawScore: combined,
                  vectorScore,
                  ftsRank: fts.ftsRank ?? fts.rawScore,
                });
                const idx = results.indexOf(exists);
                results[idx] = boosted;
              }
            }
          }

          // Sort by score and limit
          let finalResults = results
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

          // Expand context if requested (default to 500 chars for useful snippets)
          const effectiveExpand = expandChars > 0 ? expandChars : 500;
          {
            // Dedupe expansion: track which (docId, page range) we've already expanded
            const expandedCache = new Map<
              string,
              { startChunk: string; endChunk: string; content: string }
            >();

            finalResults = yield* Effect.all(
              finalResults.map((result) =>
                Effect.gen(function* () {
                  // Fetch expanded context
                  const expanded = yield* db.getExpandedContext(
                    result.docId,
                    result.page,
                    result.chunkIndex,
                    { maxChars: effectiveExpand },
                  );

                  // Cache key includes page for dedup
                  const key = `${result.docId}:p${result.page}:c${result.chunkIndex}`;
                  expandedCache.set(key, {
                    startChunk: expanded.startChunk,
                    endChunk: expanded.endChunk,
                    content: expanded.content,
                  });

                  return new SearchResult({
                    ...result,
                    expandedContent: expanded.content,
                    expandedRange: {
                      start: 0,
                      end: 0,
                    },
                  });
                }),
              ),
            );
          }

          return finalResults;
        }),

      /**
       * Full-text search only (no embeddings)
       */
      ftsSearch: (
        query: string,
        options: SearchOptions = new SearchOptions({}),
      ) => db.ftsSearch(query, options),

      /**
       * Get a chunk by its unique chunk ID
       */
      getChunk: (chunkId: string) => db.getChunk(chunkId),

      /**
       * List chunks for a document (optionally filter by page)
       */
      listChunksByDocument: (docId: string, opts?: { page?: number }) =>
        db.listChunksByDocument(docId, opts),

      /**
       * List all documents
       */
      list: (tag?: string) => db.listDocuments(tag),

      /**
       * Get a document by ID or title
       */
      get: (idOrTitle: string) =>
        Effect.gen(function* () {
          // Try by ID first
          const byId = yield* db.getDocument(idOrTitle);
          if (byId) return byId;

          // Try by title (case-insensitive partial match)
          const docs = yield* db.listDocuments();
          return (
            docs.find(
              (d) =>
                d.title.toLowerCase().includes(idOrTitle.toLowerCase()) ||
                d.id.startsWith(idOrTitle),
            ) || null
          );
        }),

      /**
       * Remove a document
       */
      remove: (idOrTitle: string) =>
        Effect.gen(function* () {
          const doc = yield* Effect.flatMap(Effect.succeed(idOrTitle), (id) =>
            Effect.gen(function* () {
              const byId = yield* db.getDocument(id);
              if (byId) return byId;

              const docs = yield* db.listDocuments();
              return (
                docs.find(
                  (d) =>
                    d.title.toLowerCase().includes(id.toLowerCase()) ||
                    d.id.startsWith(id),
                ) || null
              );
            }),
          );

          if (!doc) {
            return yield* Effect.fail(
              new DocumentNotFoundError({ query: idOrTitle }),
            );
          }

          yield* db.deleteDocument(doc.id);
          return doc;
        }),

      /**
       * Update tags on a document
       */
      tag: (idOrTitle: string, tags: string[]) =>
        Effect.gen(function* () {
          const doc = yield* Effect.flatMap(Effect.succeed(idOrTitle), (id) =>
            Effect.gen(function* () {
              const byId = yield* db.getDocument(id);
              if (byId) return byId;

              const docs = yield* db.listDocuments();
              return (
                docs.find(
                  (d) =>
                    d.title.toLowerCase().includes(id.toLowerCase()) ||
                    d.id.startsWith(id),
                ) || null
              );
            }),
          );

          if (!doc) {
            return yield* Effect.fail(
              new DocumentNotFoundError({ query: idOrTitle }),
            );
          }

          yield* db.updateTags(doc.id, tags);
          return doc;
        }),

      /**
       * Get library statistics
       */
      stats: () =>
        Effect.gen(function* () {
          const dbStats = yield* db.getStats();
          return {
            ...dbStats,
            libraryPath: config.libraryPath,
          };
        }),

      /**
       * Cheap aggregation helper for agent workflows (planning/estimation).
       * Avoids loading chunk bodies into memory just to count.
       */
      countChunksByDocumentIds: (docIds: string[]) =>
        db.countChunksByDocumentIds(docIds),

      /**
       * Repair database integrity issues
       * Removes orphaned chunks and embeddings
       */
      repair: () => db.repair(),

      /**
       * Force database checkpoint to flush WAL to data files
       * Call this after batch operations to prevent WAL accumulation
       */
      checkpoint: () => db.checkpoint(),
    };
  }),
  dependencies: [EmbeddingProviderFullLive, PDFExtractorLive, MarkdownExtractorLive],
}) {}

// ============================================================================
// Convenience Layer
// ============================================================================

/**
 * Full application layer with all services using LibSQL database
 * using the configured database backend via DatabaseRegistry.
 */
export const makePDFLibraryLive = () => {
  const dbLayer = DatabaseRegistry.make();
  logDebug("Using database layer from DatabaseRegistry");

  // Provide all dependencies internally: EmbeddingProvider (with Ollama + Gateway) and database
  // This makes PDFLibraryLive a complete, self-contained layer
  const fullDeps = Layer.merge(EmbeddingProviderFullLive, dbLayer);

  return PDFLibrary.Default.pipe(Layer.provide(fullDeps));
};

export const PDFLibraryLive = makePDFLibraryLive();
