/**
 * PDF Library - Local PDF knowledge base with vector search
 *
 * Built with Effect for robust error handling and composability.
 */

import { Duration, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";

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
import { PDFExtractor, PDFExtractorLive } from "./services/PDFExtractor.js";
import {
  MarkdownExtractor,
  MarkdownExtractorLive,
} from "./services/MarkdownExtractor.js";
import { Database } from "./services/Database.js";
import { LibSQLDatabase } from "./services/LibSQLDatabase.js";

// Re-export types and services
export * from "./types.js";
export {
  Ollama,
  OllamaLive,
  probeEmbeddingDimension,
  getEmbeddingDimension,
} from "./services/Ollama.js";
export { PDFExtractor, PDFExtractorLive } from "./services/PDFExtractor.js";
export {
  MarkdownExtractor,
  MarkdownExtractorLive,
} from "./services/MarkdownExtractor.js";
export { Database } from "./services/Database.js";
export { LibSQLDatabase } from "./services/LibSQLDatabase.js";

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
    const ollama = yield* Ollama;
    const pdfExtractor = yield* PDFExtractor;
    const markdownExtractor = yield* MarkdownExtractor;
    const db = yield* Database;
    const config = LibraryConfig.fromEnv();

    return {
      /**
       * Check if Ollama is ready
       */
      checkReady: () => ollama.checkHealth(),

      /**
       * Add a PDF or Markdown file to the library
       */
      add: (pdfPath: string, options: AddOptions = new AddOptions({})) =>
        Effect.gen(function* () {
          // Resolve path
          const resolvedPath = pdfPath.startsWith("~")
            ? pdfPath.replace("~", process.env.HOME || "")
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

          // Check Ollama
          yield* ollama.checkHealth();

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
          const doc = new Document({
            id,
            title,
            path: resolvedPath,
            addedAt: new Date(),
            pageCount,
            sizeBytes: stat.size,
            tags: options.tags || [],
            fileType,
            metadata: options.metadata,
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
            const batchEmbeddings = yield* ollama.embedBatch(
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
       * Search the library
       */
      search: (query: string, options: SearchOptions = new SearchOptions({})) =>
        Effect.gen(function* () {
          const { hybrid, limit, expandChars = 0 } = options;
          const results: SearchResult[] = [];

          // Vector search
          const healthCheck = yield* Effect.either(ollama.checkHealth());
          if (healthCheck._tag === "Right") {
            const queryEmbedding = yield* ollama.embed(query);
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
                // Boost score for matches in both
                const boosted = new SearchResult({
                  ...exists,
                  score: Math.min(1, exists.score * 1.2),
                  matchType: "hybrid",
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

          // Expand context if requested
          if (expandChars > 0) {
            // Dedupe expansion: track which (docId, chunkIndex) ranges we've already expanded
            // to avoid fetching overlapping chunks multiple times
            const expandedRanges = new Map<
              string,
              { start: number; end: number; content: string }
            >();

            finalResults = yield* Effect.all(
              finalResults.map((result) =>
                Effect.gen(function* () {
                  const key = `${result.docId}`;

                  // Check if this chunk is already covered by a previous expansion
                  const existing = expandedRanges.get(key);
                  if (
                    existing &&
                    result.chunkIndex >= existing.start &&
                    result.chunkIndex <= existing.end
                  ) {
                    // Already have this context, reuse it
                    return new SearchResult({
                      ...result,
                      expandedContent: existing.content,
                      expandedRange: {
                        start: existing.start,
                        end: existing.end,
                      },
                    });
                  }

                  // Fetch expanded context
                  const expanded = yield* db.getExpandedContext(
                    result.docId,
                    result.chunkIndex,
                    { maxChars: expandChars },
                  );

                  // Cache for deduplication
                  expandedRanges.set(key, {
                    start: expanded.startIndex,
                    end: expanded.endIndex,
                    content: expanded.content,
                  });

                  return new SearchResult({
                    ...result,
                    expandedContent: expanded.content,
                    expandedRange: {
                      start: expanded.startIndex,
                      end: expanded.endIndex,
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
  dependencies: [OllamaLive, PDFExtractorLive, MarkdownExtractorLive],
}) {}

// ============================================================================
// Convenience Layer
// ============================================================================

/**
 * Known embedding dimensions for common models
 */
const MODEL_DIMENSIONS: Record<string, number> = {
  "mxbai-embed-large": 1024,
  "nomic-embed-text": 768,
  "all-minilm": 384,
  "bge-small-en": 384,
  "bge-base-en": 768,
  "bge-large-en": 1024,
};

/**
 * Get embedding dimension for a model (from known list or default)
 */
function getModelDimension(model: string): number {
  // Check exact match first
  if (MODEL_DIMENSIONS[model]) {
    return MODEL_DIMENSIONS[model];
  }
  // Check prefix match (e.g., "nomic-embed-text:latest")
  for (const [key, dim] of Object.entries(MODEL_DIMENSIONS)) {
    if (model.startsWith(key)) {
      return dim;
    }
  }
  // Default to mxbai-embed-large dimension
  return 1024;
}

/**
 * Full application layer with all services using LibSQL database
 * Automatically detects embedding dimension from configured model
 */
export const PDFLibraryLive = (() => {
  const libraryConfig = LibraryConfig.fromEnv();

  // Load config to get the embedding model
  let embeddingDim = 1024; // default
  try {
    const { loadConfig } = require("./types.js");
    const config = loadConfig();
    embeddingDim = getModelDimension(config.embedding.model);
    console.log(
      `[PDFLibrary] Using embedding dimension ${embeddingDim} for model ${config.embedding.model}`,
    );
  } catch {
    // Config not available yet, use default
  }

  const dbLayer = LibSQLDatabase.make({
    url: `file:${libraryConfig.dbPath}`,
    embeddingDimension: embeddingDim,
  });

  return PDFLibrary.Default.pipe(Layer.provide(dbLayer));
})();
