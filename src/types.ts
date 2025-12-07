/**
 * PDF Library Types
 */

import { Schema } from "effect";

// ============================================================================
// Domain Models
// ============================================================================

export class PDFDocument extends Schema.Class<PDFDocument>("PDFDocument")({
  id: Schema.String,
  title: Schema.String,
  path: Schema.String,
  addedAt: Schema.Date,
  pageCount: Schema.Number,
  sizeBytes: Schema.Number,
  tags: Schema.Array(Schema.String),
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
}) {}

export class PDFChunk extends Schema.Class<PDFChunk>("PDFChunk")({
  id: Schema.String,
  docId: Schema.String,
  page: Schema.Number,
  chunkIndex: Schema.Number,
  content: Schema.String,
}) {}

export class SearchResult extends Schema.Class<SearchResult>("SearchResult")({
  docId: Schema.String,
  title: Schema.String,
  page: Schema.Number,
  chunkIndex: Schema.Number,
  content: Schema.String,
  score: Schema.Number,
  matchType: Schema.Literal("vector", "fts", "hybrid"),
}) {}

// ============================================================================
// Configuration
// ============================================================================

export class LibraryConfig extends Schema.Class<LibraryConfig>("LibraryConfig")(
  {
    libraryPath: Schema.String,
    dbPath: Schema.String,
    ollamaModel: Schema.String,
    ollamaHost: Schema.String,
    chunkSize: Schema.Number,
    chunkOverlap: Schema.Number,
  },
) {
  static readonly Default = new LibraryConfig({
    libraryPath: `${process.env.HOME}/Documents/.pdf-library`,
    dbPath: `${process.env.HOME}/Documents/.pdf-library/library.db`,
    ollamaModel: process.env.OLLAMA_MODEL || "mxbai-embed-large",
    ollamaHost: process.env.OLLAMA_HOST || "http://localhost:11434",
    chunkSize: 512,
    chunkOverlap: 50,
  });

  static fromEnv(): LibraryConfig {
    const libraryPath =
      process.env.PDF_LIBRARY_PATH ||
      `${process.env.HOME}/Documents/.pdf-library`;
    return new LibraryConfig({
      libraryPath,
      dbPath: `${libraryPath}/library.db`,
      ollamaModel: process.env.OLLAMA_MODEL || "mxbai-embed-large",
      ollamaHost: process.env.OLLAMA_HOST || "http://localhost:11434",
      chunkSize: 512,
      chunkOverlap: 50,
    });
  }
}

// ============================================================================
// Options
// ============================================================================

export class SearchOptions extends Schema.Class<SearchOptions>("SearchOptions")(
  {
    limit: Schema.optionalWith(Schema.Number, { default: () => 10 }),
    threshold: Schema.optionalWith(Schema.Number, { default: () => 0.3 }),
    tags: Schema.optional(Schema.Array(Schema.String)),
    hybrid: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  },
) {}

export class AddOptions extends Schema.Class<AddOptions>("AddOptions")({
  title: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
}) {}

// ============================================================================
// Errors
// ============================================================================

export class PDFNotFoundError extends Schema.TaggedError<PDFNotFoundError>()(
  "PDFNotFoundError",
  { path: Schema.String },
) {}

export class PDFExtractionError extends Schema.TaggedError<PDFExtractionError>()(
  "PDFExtractionError",
  { path: Schema.String, reason: Schema.String },
) {}

export class OllamaError extends Schema.TaggedError<OllamaError>()(
  "OllamaError",
  { reason: Schema.String },
) {}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  { reason: Schema.String },
) {}

export class DocumentNotFoundError extends Schema.TaggedError<DocumentNotFoundError>()(
  "DocumentNotFoundError",
  { query: Schema.String },
) {}

export class DocumentExistsError extends Schema.TaggedError<DocumentExistsError>()(
  "DocumentExistsError",
  { title: Schema.String, path: Schema.String },
) {}

export class URLFetchError extends Schema.TaggedError<URLFetchError>()(
  "URLFetchError",
  { url: Schema.String, reason: Schema.String },
) {}
