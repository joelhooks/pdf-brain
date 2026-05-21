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
  chunkId: Schema.String,
  docId: Schema.String,
  title: Schema.String,
  page: Schema.Number,
  chunkIndex: Schema.Number,
  content: Schema.String,
  /** Normalized score in 0..1 for ranking across match types */
  score: Schema.Number,
  /** Raw score from the underlying engine (e.g. cosine similarity, FTS rank) */
  rawScore: Schema.Number,
  /** What rawScore represents (do not assume one score meaning across engines) */
  scoreType: Schema.Literal("cosine_similarity", "fts_rank", "hybrid"),
  /** Optional component score for vector results */
  vectorScore: Schema.optional(Schema.Number),
  /** Optional component score for FTS results (raw FTS rank; often negative, more negative = better) */
  ftsRank: Schema.optional(Schema.Number),
  matchType: Schema.Literal("vector", "fts", "hybrid"),
  /** Expanded context around the match (only populated when expandChars > 0) */
  expandedContent: Schema.optional(Schema.String),
  /** Range of chunk indices included in expandedContent */
  expandedRange: Schema.optional(
    Schema.Struct({ start: Schema.Number, end: Schema.Number })
  ),
}) {
  /**
   * Backwards-compatible constructor:
   * Older callers used `SearchResult` without chunkId/rawScore/scoreType.
   *
   * This type is deprecated in favor of `DocumentSearchResult`, but we keep
   * legacy input working so downstream code doesn't explode.
   */
  constructor(props: any) {
    const docId = props?.docId;
    const page = props?.page;
    const chunkIndex = props?.chunkIndex;

    const matchType: "vector" | "fts" | "hybrid" = props?.matchType;
    const score: number = props?.score;

    const chunkId =
      props?.chunkId ?? `legacy:${String(docId)}:${String(page)}:${String(chunkIndex)}`;

    const rawScore = props?.rawScore ?? score;

    const scoreType =
      props?.scoreType ??
      (matchType === "fts"
        ? "fts_rank"
        : matchType === "hybrid"
          ? "hybrid"
          : "cosine_similarity");

    const vectorScore =
      props?.vectorScore ?? (matchType === "vector" ? score : undefined);

    super({
      ...props,
      chunkId,
      rawScore,
      scoreType,
      vectorScore,
    });
  }
}

/**
 * Document search result with entity type discriminator
 */
export class DocumentSearchResult extends Schema.Class<DocumentSearchResult>(
  "DocumentSearchResult"
)({
  chunkId: Schema.String,
  docId: Schema.String,
  title: Schema.String,
  page: Schema.Number,
  chunkIndex: Schema.Number,
  content: Schema.String,
  /** Normalized score in 0..1 for ranking across match types */
  score: Schema.Number,
  /** Raw score from the underlying engine (e.g. cosine similarity, FTS rank) */
  rawScore: Schema.Number,
  /** What rawScore represents (do not assume one score meaning across engines) */
  scoreType: Schema.Literal("cosine_similarity", "fts_rank", "hybrid"),
  /** Optional component score for vector results */
  vectorScore: Schema.optional(Schema.Number),
  /** Optional component score for FTS results (raw FTS rank; often negative, more negative = better) */
  ftsRank: Schema.optional(Schema.Number),
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
  /** Normalized score in 0..1 */
  score: Schema.Number,
  /** Raw score from the underlying engine (cosine similarity) */
  rawScore: Schema.Number,
  scoreType: Schema.Literal("cosine_similarity"),
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
 * Supports Ollama (local), AI Gateway, and OpenAI-compatible embeddings.
 */
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

export class Config extends Schema.Class<Config>("Config")({
  embedding: Schema.Struct({
    provider: Schema.Literal("ollama", "gateway", "openai"),
    model: Schema.String,
    openai: Schema.optionalWith(
      Schema.Struct({
        apiKey: Schema.optional(Schema.String),
        model: Schema.optional(Schema.String),
        baseUrl: Schema.optional(Schema.String),
      }),
      { default: () => ({ model: DEFAULT_OPENAI_EMBEDDING_MODEL }) },
    ),
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
  gateway: Schema.optionalWith(Schema.Struct({
    apiKey: Schema.optional(Schema.String),
  }), { default: () => ({}) }),
  database: Schema.optionalWith(
    Schema.Struct({
      backend: Schema.optionalWith(Schema.Literal("libsql", "qdrant"), {
        default: () => "libsql" as const,
      }),
      qdrant: Schema.optionalWith(
        Schema.Struct({
          url: Schema.String,
          collection: Schema.String,
          apiKey: Schema.optional(Schema.String),
        }),
        {
          default: () => ({
            url: "http://localhost:6333",
            collection: "pdf-brain",
          }),
        }
      ),
    }),
    {
      default: () => ({
        backend: "libsql" as const,
        qdrant: {
          url: "http://localhost:6333",
          collection: "pdf-brain",
        },
      }),
    }
  ),
  server: Schema.optionalWith(
    Schema.Struct({
      host: Schema.optionalWith(Schema.String, {
        default: () => "127.0.0.1",
      }),
      port: Schema.optionalWith(Schema.Number, {
        default: () => 3838,
      }),
      auth: Schema.optionalWith(
        Schema.Struct({
          enabled: Schema.optionalWith(Schema.Boolean, {
            default: () => false,
          }),
          token: Schema.optional(Schema.String),
        }),
        {
          default: () => ({
            enabled: false,
          }),
        }
      ),
    }),
    {
      default: () => ({
        host: "127.0.0.1",
        port: 3838,
        auth: {
          enabled: false,
        },
      }),
    }
  ),
}) {
  /**
   * Default configuration: Ollama for all providers
   */
  static readonly Default = new Config({
    embedding: {
      provider: "ollama" as const,
      model: "mxbai-embed-large",
      openai: {
        model: DEFAULT_OPENAI_EMBEDDING_MODEL,
      },
    },
    enrichment: {
      provider: "ollama" as const,
      model: "llama3.2:3b",
    },
    judge: {
      provider: "ollama" as const,
      model: "llama3.2:3b",
    },
    ollama: {
      host: "http://localhost:11434",
      autoInstall: true,
    },
    gateway: {},
    database: {
      backend: "libsql",
      qdrant: {
        url: "http://localhost:6333",
        collection: "pdf-brain",
      },
    },
    server: {
      host: "127.0.0.1",
      port: 3838,
      auth: {
        enabled: false,
      },
    },
  });

  /**
   * Resolve the gateway API key: config takes precedence over env var.
   */
  get gatewayApiKey(): string | undefined {
    return this.gateway.apiKey ?? process.env.AI_GATEWAY_API_KEY;
  }

  /**
   * Resolve the OpenAI API key: config takes precedence over env var.
   */
  get openaiApiKey(): string | undefined {
    return this.embedding.openai.apiKey ?? process.env.OPENAI_API_KEY;
  }
}

// ============================================================================
// Config Helpers
// ============================================================================

/**
 * Preferred config path (~/.config/pdf-brain/config.json unless overridden).
 */
export function getDefaultConfigPath(): string {
  const home = process.env.HOME || ".";
  return `${home}/.config/pdf-brain/config.json`;
}

/**
 * Legacy config path ($PDF_LIBRARY_PATH/config.json).
 */
export function getLegacyConfigPath(): string {
  const libraryPath =
    process.env.PDF_LIBRARY_PATH ||
    `${process.env.HOME}/Documents/.pdf-library`;
  return `${libraryPath}/config.json`;
}

/**
 * Resolve the active config path.
 * Priority:
 * 1) $PDF_BRAIN_CONFIG
 * 2) ~/.config/pdf-brain/config.json
 */
export function resolveConfigPath(): string {
  return process.env.PDF_BRAIN_CONFIG || getDefaultConfigPath();
}

/**
 * Decode config data and apply schema defaults for missing fields.
 */
export function normalizeConfig(configData: unknown): Config {
  return Schema.decodeSync(Config)(configData);
}

/**
 * Load config from resolved path.
 * Creates config.json with defaults if it doesn't exist.
 */
export function loadConfig(): Config {
  const configPath = resolveConfigPath();
  const legacyConfigPath = getLegacyConfigPath();
  const explicitPath = Boolean(process.env.PDF_BRAIN_CONFIG);

  // Create config file with defaults if missing (or read legacy config for compatibility)
  if (!existsSync(configPath)) {
    if (!explicitPath && existsSync(legacyConfigPath)) {
      const configJson = readFileSync(legacyConfigPath, "utf-8");
      const configData = JSON.parse(configJson);
      return normalizeConfig(configData);
    }

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(Config.Default, null, 2), "utf-8");
    return Config.Default;
  }

  // Read and parse existing config
  const configJson = readFileSync(configPath, "utf-8");
  const configData = JSON.parse(configJson);

  // Validate and return via Schema
  return normalizeConfig(configData);
}

/**
 * Save config to resolved path.
 * API keys can be stored in config or read from env var AI_GATEWAY_API_KEY.
 */
export function saveConfig(config: Config): void {
  const configPath = resolveConfigPath();

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
  /**
   * Internal/advanced: preserve original `addedAt` on re-add/rechunk workflows.
   * CLI does not expose this directly.
   */
  addedAt: Schema.optional(Schema.Date),
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

export class GatewayError extends Schema.TaggedError<GatewayError>()(
  "GatewayError",
  { reason: Schema.String }
) {}

export class OpenAIError extends Schema.TaggedError<OpenAIError>()(
  "OpenAIError",
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
