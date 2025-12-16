/**
 * PDF Library - Local PDF knowledge base with vector search
 *
 * Built with Effect for robust error handling and composability.
 */

import { Effect, Layer, Chunk, Stream } from "effect";
import { createHash } from "crypto";
import { statSync } from "fs";
import { basename } from "path";

import {
  PDFDocument,
  SearchResult,
  SearchOptions,
  AddOptions,
  LibraryConfig,
  DocumentExistsError,
  DocumentNotFoundError,
} from "./types.js";

import { Ollama, OllamaLive } from "./services/Ollama.js";
import { PDFExtractor, PDFExtractorLive } from "./services/PDFExtractor.js";
import { MarkdownExtractor, MarkdownExtractorLive } from "./services/MarkdownExtractor.js";
import { Database, DatabaseLive } from "./services/Database.js";

// Re-export types and services
export * from "./types.js";
export { Ollama, OllamaLive } from "./services/Ollama.js";
export { PDFExtractor, PDFExtractorLive } from "./services/PDFExtractor.js";
export { MarkdownExtractor, MarkdownExtractorLive } from "./services/MarkdownExtractor.js";
export { Database, DatabaseLive } from "./services/Database.js";

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

/**
 * Extract first H1 heading from markdown content
 */
function extractFirstH1(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
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
          const fileType = isMarkdown ? ("markdown" as const) : ("pdf" as const);
          
          // Determine title based on file type
          let title: string;
          if (options.title) {
            title = options.title;
          } else if (isMarkdown) {
            // For markdown, try to extract first H1, fallback to filename
            const { extract } = markdownExtractor;
            const extracted = yield* Effect.either(extract(resolvedPath));
            if (extracted._tag === "Right" && extracted.right.sections.length > 0) {
              const firstH1 = extracted.right.sections.find(s => s.heading);
              title = firstH1?.heading || basename(resolvedPath, ".md").replace(/\.markdown$/, "");
            } else {
              title = basename(resolvedPath, ".md").replace(/\.markdown$/, "");
            }
          } else {
            title = basename(resolvedPath, ".pdf");
          }

          // Process file with appropriate extractor
          const { pageCount, chunks } = yield* (isMarkdown
            ? markdownExtractor.process(resolvedPath)
            : pdfExtractor.process(resolvedPath));

          if (chunks.length === 0) {
            return yield* Effect.fail(
              new DocumentNotFoundError({
                query: `No text content extracted from ${fileType}`,
              }),
            );
          }

          // Create document
          const doc = new PDFDocument({
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

          // Generate embeddings with progress
          yield* Effect.log(
            `Generating embeddings for ${chunks.length} chunks...`,
          );
          const contents = chunks.map((c) => c.content);
          const embeddings = yield* ollama.embedBatch(contents, 5);

          // Store embeddings
          const embeddingRecords = embeddings.map((emb, i) => ({
            chunkId: `${id}-${i}`,
            embedding: emb,
          }));
          yield* db.addEmbeddings(embeddingRecords);

          return doc;
        }),

      /**
       * Search the library
       */
      search: (query: string, options: SearchOptions = new SearchOptions({})) =>
        Effect.gen(function* () {
          const { hybrid, limit } = options;
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
          return results.sort((a, b) => b.score - a.score).slice(0, limit);
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
    };
  }),
  dependencies: [OllamaLive, PDFExtractorLive, MarkdownExtractorLive, DatabaseLive],
}) {}

// ============================================================================
// Convenience Layer
// ============================================================================

/**
 * Full application layer with all services
 */
export const PDFLibraryLive = PDFLibrary.Default;
