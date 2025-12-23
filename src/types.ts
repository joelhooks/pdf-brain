/**
 * Document Library Types
 */

import { Schema } from "effect";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

// ============================================================================
// Domain Models
// ============================================================================

/**
 * Represents a document in the library (PDF or Markdown)
 */
export class Document extends Schema.Class<Document>("Document")({
  id: Schema.String,
  title: Schema.String,
  path: Schema.String,
  addedAt: Schema.Date,
  pageCount: Schema.Number,
  sizeBytes: Schema.Number,
  tags: Schema.Array(Schema.String),
  fileType: Schema.optionalWith(Schema.Literal("pdf", "markdown"), {
    default: () => "pdf" as const,
  }),
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
  ),
}) {}

/**
 * @deprecated Use Document instead. Kept for backwards compatibility.
 */
export type PDFDocument = Document;
export const PDFDocument = Document;

export class PDFChunk extends Schema.Class<PDFChunk>("PDFChunk")({
  id: Schema.String,
  docId: Schema.String,
  page: Schema.Number,
  chunkIndex: Schema.Number,
  content: Schema.String,
}) {}

/**
 * Entity type discriminator for unified search results
 */
export type EntityType = "document" | "concept";

/**
 * @deprecated Use DocumentSearchResult for unified search. Kept for backwards compatibility.
 */
export class SearchResult extends Schema.Class<SearchResult>("SearchResult")({
  docId: Schema.String,
  title: Schema.String,
  page: Schema.Number,
  chunkIndex: Schema.Number,
  content: Schema.String,
  score: Schema.Number,
  matchType: Schema.Literal("vector", "fts", "hybrid"),
  /** Expanded context around the match (only populated when expandChars > 0) */
  expandedContent: Schema.optional(Schema.String),
  /** Range of chunk indices included in expandedContent */
  expandedRange: Schema.optional(
    Schema.Struct({ start: Schema.Number, end: Schema.Number })
  ),
}) {}

/**
 * Document search result with entity type discriminator
 */
export class DocumentSearchResult extends Schema.Class<DocumentSearchResult>(
  "DocumentSearchResult"
)({
  docId: Schema.String,
  title: Schema.String,
  page: Schema.Number,
  chunkIndex: Schema.Number,
  content: Schema.String,
  score: Schema.Number,
  matchType: Schema.Literal("vector", "fts", "hybrid"),
  entityType: Schema.Literal("document"),
  /** Expanded context around the match (only populated when expandChars > 0) */
  expandedContent: Schema.optional(Schema.String),
  /** Range of chunk indices included in expandedContent */
  expandedRange: Schema.optional(
    Schema.Struct({ start: Schema.Number, end: Schema.Number })
  ),
}) {}

/**
 * Concept search result from taxonomy/SKOS
 */
export class ConceptSearchResult extends Schema.Class<ConceptSearchResult>(
  "ConceptSearchResult"
)({
  conceptId: Schema.String,
  prefLabel: Schema.String,
  definition: Schema.String,
  score: Schema.Number,
  entityType: Schema.Literal("concept"),
}) {}

/**
 * Unified search result - can be either document or concept
 */
export type UnifiedSearchResult = DocumentSearchResult | ConceptSearchResult;

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
  }
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

/**
 * Multi-provider configuration for embedding, enrichment, and judge models.
 * Supports both Ollama (local) and AI Gateway (remote) providers.
 */
export class Config extends Schema.Class<Config>("Config")({
  embedding: Schema.Struct({
    provider: Schema.Literal("ollama", "gateway"),
    model: Schema.String,
  }),
  enrichment: Schema.Struct({
    provider: Schema.Literal("ollama", "gateway"),
    model: Schema.String,
  }),
  judge: Schema.Struct({
    provider: Schema.Literal("ollama", "gateway"),
    model: Schema.String,
  }),
  ollama: Schema.Struct({
    host: Schema.String,
    autoInstall: Schema.Boolean,
  }),
}) {
  /**
   * Default configuration: Ollama for all providers
   */
  static readonly Default = new Config({
    embedding: {
      provider: "ollama" as const,
      model: "mxbai-embed-large",
    },
    enrichment: {
      provider: "ollama" as const,
      model: "llama3.2",
    },
    judge: {
      provider: "ollama" as const,
      model: "llama3.2",
    },
    ollama: {
      host: "http://localhost:11434",
      autoInstall: true,
    },
  });
}

// ============================================================================
// Config Helpers
// ============================================================================

/**
 * Load config from $PDF_LIBRARY_PATH/config.json.
 * Creates config.json with defaults if it doesn't exist.
 */
export function loadConfig(): Config {
  const libraryPath =
    process.env.PDF_LIBRARY_PATH ||
    `${process.env.HOME}/Documents/.pdf-library`;
  const configPath = `${libraryPath}/config.json`;

  // Create config file with defaults if missing
  if (!existsSync(configPath)) {
    // Ensure directory exists
    mkdirSync(dirname(configPath), { recursive: true });

    const defaultConfig = Config.Default;
    writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
    return defaultConfig;
  }

  // Read and parse existing config
  const configJson = readFileSync(configPath, "utf-8");
  const configData = JSON.parse(configJson);

  // Validate and return via Schema
  return Schema.decodeSync(Config)(configData);
}

/**
 * Save config to $PDF_LIBRARY_PATH/config.json.
 * API keys are never stored - they come from env vars (AI_GATEWAY_API_KEY).
 */
export function saveConfig(config: Config): void {
  const libraryPath =
    process.env.PDF_LIBRARY_PATH ||
    `${process.env.HOME}/Documents/.pdf-library`;
  const configPath = `${libraryPath}/config.json`;

  // Ensure directory exists
  mkdirSync(dirname(configPath), { recursive: true });

  // Write config (Schema.encode not needed for simple JSON serialization)
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// ============================================================================
// Options
// ============================================================================

export class SearchOptions extends Schema.Class<SearchOptions>("SearchOptions")(
  {
    limit: Schema.optionalWith(Schema.Number, { default: () => 10 }),
    threshold: Schema.optionalWith(Schema.Number, { default: () => 0.0 }),
    tags: Schema.optional(Schema.Array(Schema.String)),
    hybrid: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    /** Max chars for expanded context per result. 0 = no expansion (default) */
    expandChars: Schema.optionalWith(Schema.Number, { default: () => 0 }),
    /** Filter by entity types. Default: both documents and concepts */
    entityTypes: Schema.optional(
      Schema.Array(Schema.Literal("document", "concept"))
    ),
    /** Include cluster summaries in search results (RAPTOR-style multi-scale retrieval). Default: false */
    includeClusterSummaries: Schema.optionalWith(Schema.Boolean, {
      default: () => false,
    }),
  }
) {}

export class AddOptions extends Schema.Class<AddOptions>("AddOptions")({
  title: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
  ),
}) {}

// ============================================================================
// Errors
// ============================================================================

export class PDFNotFoundError extends Schema.TaggedError<PDFNotFoundError>()(
  "PDFNotFoundError",
  { path: Schema.String }
) {}

export class PDFExtractionError extends Schema.TaggedError<PDFExtractionError>()(
  "PDFExtractionError",
  { path: Schema.String, reason: Schema.String }
) {}

export class MarkdownNotFoundError extends Schema.TaggedError<MarkdownNotFoundError>()(
  "MarkdownNotFoundError",
  { path: Schema.String }
) {}

export class MarkdownExtractionError extends Schema.TaggedError<MarkdownExtractionError>()(
  "MarkdownExtractionError",
  { path: Schema.String, reason: Schema.String }
) {}

export class OllamaError extends Schema.TaggedError<OllamaError>()(
  "OllamaError",
  { reason: Schema.String }
) {}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  { reason: Schema.String }
) {}

export class DocumentNotFoundError extends Schema.TaggedError<DocumentNotFoundError>()(
  "DocumentNotFoundError",
  { query: Schema.String }
) {}

export class DocumentExistsError extends Schema.TaggedError<DocumentExistsError>()(
  "DocumentExistsError",
  { title: Schema.String, path: Schema.String }
) {}

export class URLFetchError extends Schema.TaggedError<URLFetchError>()(
  "URLFetchError",
  { url: Schema.String, reason: Schema.String }
) {}
