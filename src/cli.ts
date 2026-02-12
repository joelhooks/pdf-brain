#!/usr/bin/env bun
/**
 * PDF Brain CLI
 */

import { Effect, Console as EffectConsole, Exit, Layer, Runtime, Scope } from "effect";
import { JSONSchema } from "@effect/schema";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "fs";
import { basename, extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  renderIngestProgress,
  createInitialState,
  type FileStatus,
  type IngestState,
} from "./components/IngestProgress.js";
import { submitIngestJobs, getQueueStatus, QUEUE_NAME } from "./queue/ingest-producer.js";
import { startWorker } from "./queue/ingest-worker.js";
import {
  AutoTagger,
  AutoTaggerLive,
  type EnrichmentResult,
} from "./services/AutoTagger.js";
import { PDFExtractor, PDFExtractorLive } from "./services/PDFExtractor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let VERSION = "0.0.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8")
  );
  VERSION = pkg.version;
} catch {
  // Compiled binary — package.json not on disk.
  // Version injected via --define at build time.
  VERSION = typeof __PDF_BRAIN_VERSION__ !== "undefined" ? __PDF_BRAIN_VERSION__ : "0.0.0-compiled";
}
declare const __PDF_BRAIN_VERSION__: string;
import {
  PDFLibrary,
  makePDFLibraryLive,
  SearchOptions,
  AddOptions,
  LibraryConfig,
  URLFetchError,
} from "./index.js";
import {
  Config,
  Document,
  PDFChunk,
  SearchResult,
  loadConfig,
  resolveConfigPath,
  saveConfig,
} from "./types.js";
import { Migration, MigrationLive } from "./services/Migration.js";
import { assessDocChunker } from "./chunking.js";
import {
  TaxonomyService,
  TaxonomyServiceImpl,
  type TaxonomyJSON,
  type Concept,
} from "./services/TaxonomyService.js";
import {
  EmbeddingProvider,
  EmbeddingProviderFullLive,
} from "./services/EmbeddingProvider.js";
import { type CommandResult, generateHints, generateNextActions } from "./agent/hints.js";
import { formatHintBlock } from "./agent/format.js";
import { renderHelp } from "./agent/manifest.js";
import { backgroundUpdateCheck, runUpdate } from "./updater.js";
import {
  DEFAULT_SERVER_CONFIG,
  PDF_BRAIN_PROTOCOL_VERSION,
  type AgentEnvelope,
  type LogLevel,
  type NextAction,
  type OutputFormat,
  isBearerTokenAuthorized,
  resolveServerConfig,
  toJsonLine,
} from "./agent/protocol.js";
import { getLogLevel, setLogLevel, logInfo } from "./logger.js";

/**
 * Check if a string is a URL
 */
function isURL(str: string): boolean {
  return str.startsWith("http://") || str.startsWith("https://");
}

/**
 * Extract filename from URL
 */
export function filenameFromURL(url: string): string {
  const urlObj = new URL(url);
  const pathname = urlObj.pathname;
  const filename = basename(pathname);
  const ext = extname(filename).toLowerCase();

  // If already has a recognized extension, keep it
  if (ext === ".pdf" || ext === ".md" || ext === ".markdown") {
    return filename;
  }

  // Default to .pdf for backwards compatibility
  return `${filename}.pdf`;
}

/** Size in bytes to peek for Markdown heuristics when content-type is text/plain */
const MARKDOWN_PEEK_SIZE = 4096;

/** Markdown indicators to look for in content */
export const MARKDOWN_INDICATORS = [
  /^#{1,6}\s/m, // Headings: # ## ### etc.
  /^[-*+]\s/m, // Unordered list markers
  /^\d+\.\s/m, // Ordered list markers
  /^```/m, // Code fences
  /^\|.+\|/m, // Table rows
  /\[.+\]\(.+\)/m, // Links [text](url)
];

/**
 * Check if content looks like Markdown by examining the first N bytes
 */
export function looksLikeMarkdown(content: string): boolean {
  return MARKDOWN_INDICATORS.some((pattern) => pattern.test(content));
}

/**
 * Check if URL has a Markdown file extension
 */
export function hasMarkdownExtension(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname).toLowerCase();
    return ext === ".md" || ext === ".markdown";
  } catch {
    // Fallback for malformed URLs
    return url.endsWith(".md") || url.endsWith(".markdown");
  }
}

/**
 * WAL health assessment result
 */
export interface WALHealthResult {
  healthy: boolean;
  warnings: string[];
}

/**
 * Assess WAL health based on file count and total size
 * Thresholds: 50 files OR 50 MB
 */
export function assessWALHealth(stats: {
  fileCount: number;
  totalSizeBytes: number;
}): WALHealthResult {
  const warnings: string[] = [];
  const FILE_COUNT_THRESHOLD = 50;
  const SIZE_THRESHOLD_MB = 50;
  const SIZE_THRESHOLD_BYTES = SIZE_THRESHOLD_MB * 1024 * 1024;

  if (stats.fileCount > FILE_COUNT_THRESHOLD) {
    warnings.push(
      `WAL file count (${stats.fileCount}) exceeds recommended threshold (${FILE_COUNT_THRESHOLD})`
    );
  }

  const sizeMB = stats.totalSizeBytes / (1024 * 1024);
  if (stats.totalSizeBytes > SIZE_THRESHOLD_BYTES) {
    warnings.push(
      `WAL size (${sizeMB.toFixed(
        1
      )} MB) exceeds recommended threshold (${SIZE_THRESHOLD_MB} MB)`
    );
  }

  return {
    healthy: warnings.length === 0,
    warnings,
  };
}

/**
 * Corrupted directories check result
 */
export interface CorruptedDirsResult {
  healthy: boolean;
  issues: string[];
}

/**
 * Check for corrupted directories (directories with " 2" suffix)
 * Known corruption patterns: "base 2", "pg_multixact 2"
 */
export function checkCorruptedDirs(
  libraryPath: string,
  dirs: string[]
): CorruptedDirsResult {
  const corrupted = dirs.filter((d) => d.endsWith(" 2"));
  return {
    healthy: corrupted.length === 0,
    issues: corrupted,
  };
}

/**
 * Overall doctor health assessment result
 */
export interface DoctorHealthResult {
  healthy: boolean;
  checks: HealthCheck[];
}

export interface HealthCheck {
  name: string;
  healthy: boolean;
  /**
   * Optional severity for agent decision-making.
   * - ok: no action needed
   * - warning: non-fatal; action recommended
   * - error: action needed (doctor overall unhealthy)
   */
  severity?: "ok" | "warning" | "error";
  details?: string;
}

/**
 * Assess overall doctor health from individual checks
 */
export function assessDoctorHealth(data: {
  walHealth: WALHealthResult;
  corruptedDirs: CorruptedDirsResult;
  ollamaReachable: boolean;
  orphanedData: { chunks: number; embeddings: number };
  chunker: { missing: number; mismatch: number };
}): DoctorHealthResult {
  const checks: HealthCheck[] = [];

  // WAL health check
  checks.push({
    name: "WAL Files",
    healthy: data.walHealth.healthy,
    severity: data.walHealth.healthy ? "ok" : "error",
    details:
      data.walHealth.warnings.length > 0
        ? data.walHealth.warnings.join("; ")
        : undefined,
  });

  // Corrupted directories check
  checks.push({
    name: "Corrupted Directories",
    healthy: data.corruptedDirs.healthy,
    severity: data.corruptedDirs.healthy ? "ok" : "error",
    details:
      data.corruptedDirs.issues.length > 0
        ? `Found: ${data.corruptedDirs.issues.join(", ")}`
        : undefined,
  });

  // Ollama check
  checks.push({
    name: "Ollama",
    healthy: data.ollamaReachable,
    severity: data.ollamaReachable ? "ok" : "error",
    details: data.ollamaReachable ? undefined : "Unreachable",
  });

  // Orphaned data check
  const hasOrphans =
    data.orphanedData.chunks > 0 || data.orphanedData.embeddings > 0;
  checks.push({
    name: "Orphaned Data",
    healthy: !hasOrphans,
    severity: !hasOrphans ? "ok" : "error",
    details: hasOrphans
      ? `${data.orphanedData.chunks} chunks, ${data.orphanedData.embeddings} embeddings`
      : undefined,
  });

  // Chunker metadata check (affects result quality + reproducibility).
  // - Missing metadata means "unknown" (warning): we can't prove which chunker produced the chunks.
  // - Mismatched metadata means "definitely stale" (error): the chunker/config differs from current.
  const hasMismatch = data.chunker.mismatch > 0;
  const hasMissing = data.chunker.missing > 0;
  checks.push({
    name: "Chunker Metadata",
    healthy: !hasMismatch,
    severity: hasMismatch ? "error" : hasMissing ? "warning" : "ok",
    details:
      hasMismatch || hasMissing
        ? [
            hasMismatch
              ? `${data.chunker.mismatch} document(s) have mismatched chunker metadata`
              : null,
            hasMissing
              ? `${data.chunker.missing} document(s) are missing chunker metadata (unknown; consider rechunking)`
              : null,
          ]
            .filter(Boolean)
            .join("; ")
        : undefined,
  });

  return {
    healthy: checks.every((c) => c.healthy),
    checks,
  };
}

/**
 * Build a hierarchy tree from concepts
 * Returns Map of conceptId -> { concept, children }
 */
interface TreeNode {
  concept: Concept;
  children: TreeNode[];
}

/**
 * Render a concept tree with box-drawing characters
 */
function renderConceptTree(
  node: TreeNode,
  prefix = "",
  isLast = true
): string[] {
  const lines: string[] = [];
  const connector = isLast ? "└── " : "├── ";
  const childPrefix = isLast ? "    " : "│   ";

  lines.push(prefix + connector + node.concept.prefLabel);

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const childIsLast = i === node.children.length - 1;
    lines.push(...renderConceptTree(child, prefix + childPrefix, childIsLast));
  }

  return lines;
}

/**
 * Build tree structure from flat list of concepts with hierarchy
 */
async function buildTreeStructure(
  taxonomy: TaxonomyService,
  rootId?: string
): Promise<TreeNode[]> {
  const concepts = await Effect.runPromise(taxonomy.listConcepts());
  const conceptMap = new Map(concepts.map((c) => [c.id, c]));

  // Build parent-child relationships
  const childrenMap = new Map<string, string[]>();
  const roots: string[] = [];

  for (const concept of concepts) {
    const broaders = await Effect.runPromise(taxonomy.getBroader(concept.id));
    if (broaders.length === 0) {
      roots.push(concept.id);
    } else {
      for (const broader of broaders) {
        if (!childrenMap.has(broader.id)) {
          childrenMap.set(broader.id, []);
        }
        childrenMap.get(broader.id)!.push(concept.id);
      }
    }
  }

  // Build tree nodes recursively
  const buildNode = (conceptId: string): TreeNode | null => {
    const concept = conceptMap.get(conceptId);
    if (!concept) return null;

    const childIds = childrenMap.get(conceptId) || [];
    const children = childIds
      .map(buildNode)
      .filter((n): n is TreeNode => n !== null);

    return { concept, children };
  };

  // If rootId specified, build from that node
  if (rootId) {
    const node = buildNode(rootId);
    return node ? [node] : [];
  }

  // Otherwise, build all root nodes
  return roots.map(buildNode).filter((n): n is TreeNode => n !== null);
}

/**
 * Get checkpoint interval from CLI options
 * Default is 50 documents
 */
export function getCheckpointInterval(
  opts: Record<string, string | boolean>
): number {
  const interval = opts["checkpoint-interval"];
  if (typeof interval === "string") {
    const parsed = parseInt(interval, 10);
    return isNaN(parsed) || parsed <= 0 ? 50 : parsed;
  }
  return 50; // Default
}

/**
 * Determine if checkpoint should be triggered at this document count
 * Checkpoints at every N documents (e.g., 50, 100, 150...)
 */
export function shouldCheckpoint(
  processedCount: number,
  interval: number
): boolean {
  return processedCount > 0 && processedCount % interval === 0;
}

/**
 * Download a file (PDF or Markdown) from URL to local path
 */
function downloadFile(url: string, destPath: string) {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const contentType = response.headers.get("content-type") || "";

      // PDF detection: explicit MIME type or .pdf extension
      const isPDF = contentType.includes("pdf") || url.endsWith(".pdf");

      // Markdown detection: strict MIME types or file extension
      const hasExplicitMarkdownMime =
        contentType.includes("text/markdown") ||
        contentType.includes("text/x-markdown");
      const hasMarkdownExt = hasMarkdownExtension(url);

      let isMarkdown = hasExplicitMarkdownMime || hasMarkdownExt;

      // Heuristic for text/plain: check URL extension first, then peek at content
      if (!isPDF && !isMarkdown && contentType.includes("text/plain")) {
        if (hasMarkdownExt) {
          isMarkdown = true;
        } else {
          // Peek at content to detect Markdown indicators
          const buffer = await response.arrayBuffer();
          const decoder = new TextDecoder("utf-8", { fatal: false });
          const preview = decoder.decode(buffer.slice(0, MARKDOWN_PEEK_SIZE));
          if (looksLikeMarkdown(preview)) {
            isMarkdown = true;
          }
          // Write the already-fetched buffer
          if (isPDF || isMarkdown) {
            await Bun.write(destPath, buffer);
            return destPath;
          }
          throw new Error(`Unsupported content type: ${contentType}`);
        }
      }

      if (!isPDF && !isMarkdown) {
        throw new Error(`Unsupported content type: ${contentType}`);
      }
      const buffer = await response.arrayBuffer();
      await Bun.write(destPath, buffer);
      return destPath;
    },
    catch: (e) => new URLFetchError({ url, reason: String(e) }),
  });
}


export function parseArgs(args: string[]) {
  const result: Record<string, string | boolean> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        const value = arg.slice(eq + 1);
        result[key] = value;
        i += 1;
        continue;
      }

      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        i += 2;
      } else {
        result[key] = true;
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return result;
}

function splitPositionalsAndFlags(args: string[]): {
  positionals: string[];
  flagArgs: string[];
} {
  const positionals: string[] = [];
  const flagArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      flagArgs.push(arg);
      const hasEq = arg.includes("=");
      if (!hasEq) {
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flagArgs.push(next);
          i++;
        }
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flagArgs };
}

class CLIError extends Error {
  readonly _tag = "CLIError";
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

type GlobalCLIOptions = {
  format: OutputFormat;
  pretty: boolean;
  logLevel: LogLevel;
  quiet: boolean;
};

type ServeCommandOverrides = {
  host?: string;
  port?: number;
  authToken?: string;
};

function parseGlobalCLIOptions(rawArgs: string[]): {
  options: GlobalCLIOptions;
  args: string[];
} {
  let format: OutputFormat = "json";
  let pretty = false;
  let quiet = false;
  let logLevel: LogLevel = getLogLevel();

  const args: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (arg === "--pretty") {
      pretty = true;
      continue;
    }

    if (arg === "--quiet" || arg === "--no-hints") {
      quiet = true;
      continue;
    }

    if (arg === "--format" || arg.startsWith("--format=")) {
      const value =
        arg === "--format" ? rawArgs[i + 1] : arg.split("=", 2)[1];
      if (arg === "--format") i++;

      if (value === "json" || value === "ndjson" || value === "text") {
        format = value;
        continue;
      }

      throw new CLIError(
        "INVALID_FLAG",
        `Invalid --format value: ${String(value)}`,
        { flag: "--format", value }
      );
    }

    if (arg === "--log-level" || arg.startsWith("--log-level=")) {
      const value =
        arg === "--log-level" ? rawArgs[i + 1] : arg.split("=", 2)[1];
      if (arg === "--log-level") i++;

      if (
        value === "silent" ||
        value === "error" ||
        value === "info" ||
        value === "debug"
      ) {
        logLevel = value;
        continue;
      }

      throw new CLIError(
        "INVALID_FLAG",
        `Invalid --log-level value: ${String(value)}`,
        { flag: "--log-level", value }
      );
    }

    args.push(arg);
  }

  return {
    options: {
      format,
      pretty,
      logLevel,
      quiet,
    },
    args,
  };
}

export function parseServeCommandOptions(args: string[]): ServeCommandOverrides {
  const opts = parseArgs(args);
  const overrides: ServeCommandOverrides = {};

  if ("host" in opts) {
    if (typeof opts.host !== "string" || opts.host.length === 0) {
      throw new CLIError(
        "INVALID_FLAG",
        "Invalid --host value (expected non-empty string)",
        { flag: "--host", value: opts.host }
      );
    }
    overrides.host = opts.host;
  }

  if ("port" in opts) {
    if (typeof opts.port !== "string") {
      throw new CLIError(
        "INVALID_FLAG",
        "Invalid --port value (expected integer 1-65535)",
        { flag: "--port", value: opts.port }
      );
    }
    const parsedPort = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new CLIError(
        "INVALID_FLAG",
        "Invalid --port value (expected integer 1-65535)",
        { flag: "--port", value: opts.port }
      );
    }
    overrides.port = parsedPort;
  }

  if ("auth-token" in opts) {
    if (typeof opts["auth-token"] !== "string" || opts["auth-token"].length === 0) {
      throw new CLIError(
        "INVALID_FLAG",
        "Invalid --auth-token value (expected non-empty token)",
        { flag: "--auth-token", value: opts["auth-token"] }
      );
    }
    overrides.authToken = opts["auth-token"];
  }

  return overrides;
}

function writeEnvelope<T>(
  format: OutputFormat,
  envelope: AgentEnvelope<T>,
  pretty: boolean
): void {
  if (format === "text") return;
  try {
    process.stdout.write(toJsonLine(envelope, { pretty }));
  } catch {
    // ignore
  }
}

function makeProgram(args: string[], globals: GlobalCLIOptions) {
  return Effect.gen(function* () {
    const { format, quiet } = globals;
    let agentResult: CommandResult | null = null;
    let resultPayload: unknown = null;
    const startedAt = Date.now();

    // Agent-first: when `--format json|ndjson`, stdout must be pure data.
    // We keep the existing `yield* Console.log/error` calls, but gate them
    // behind text mode by shadowing `Console` in this scope.
    const Console = {
      log: (message: string) =>
        format === "text" ? EffectConsole.log(message) : Effect.void,
      error: (message: string) =>
        format === "text" ? EffectConsole.error(message) : Effect.void,
    };

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    const library = yield* PDFLibrary;
    const stats = yield* Effect.either(library.stats());
    const statsData = stats._tag === "Right" ? stats.right : undefined;
    if (format === "text") {
      yield* Console.log(renderHelp(statsData));
      return { command: "help", result: null, agentResult: null, meta: null };
    }

    resultPayload = { help: renderHelp(statsData) };
    return {
      command: "help",
      result: resultPayload,
      agentResult: null,
      meta: { pdfBrainVersion: VERSION, timingMs: Date.now() - startedAt },
    };
  }

  if (args.includes("--version") || args.includes("-v")) {
    if (format === "text") {
      yield* Console.log(`pdf-brain v${VERSION}`);
      return { command: "version", result: null, agentResult: null, meta: null };
    }

    resultPayload = { version: VERSION };
    return {
      command: "version",
      result: resultPayload,
      agentResult: null,
      meta: { pdfBrainVersion: VERSION, timingMs: Date.now() - startedAt },
    };
  }

  const command = args[0];
  const library = yield* PDFLibrary;

  switch (command) {
    case "capabilities": {
      const result = {
        protocolVersion: PDF_BRAIN_PROTOCOL_VERSION,
        pdfBrainVersion: VERSION,
        defaultFormat: "json" as const,
        outputFormats: ["json", "ndjson", "text"] as const,
        globalFlags: {
          "--format": ["json", "ndjson", "text"] as const,
          "--pretty": { type: "boolean", default: false },
          "--quiet": { type: "boolean", default: false },
          "--log-level": ["silent", "error", "info", "debug"] as const,
        },
        commands: [
          {
            name: "search",
            argv: ["search", "<query>"],
            description:
              "Search documents (vector + hybrid + FTS) and optionally concepts",
          },
          {
            name: "search-pack",
            argv: ["search-pack", "<query1>", "<query2>", "..."],
            description:
              "Multi-query search sweep + dedupe (agent-optimized aggregation)",
          },
          {
            name: "chunk",
            argv: ["chunk", "get", "<chunkId>"],
            description: "Fetch a chunk's full text by ID (progressive disclosure)",
          },
          {
            name: "doc",
            argv: ["doc", "chunks", "<docId>"],
            description: "List chunk IDs for a document (optionally by page)",
          },
          {
            name: "page",
            argv: ["page", "get", "<docId>", "<page>"],
            description: "Reconstruct full page text by concatenating chunks",
          },
          { name: "read", argv: ["read", "<id|title>"], description: "Read document metadata" },
          { name: "list", argv: ["list"], description: "List documents" },
          { name: "stats", argv: ["stats"], description: "Library statistics" },
          {
            name: "taxonomy",
            argv: ["taxonomy", "<subcommand>"],
            description: "Taxonomy navigation (SKOS concepts)",
          },
          { name: "doctor", argv: ["doctor"], description: "Health check" },
          {
            name: "rechunk",
            argv: [
              "rechunk",
              "[--dry-run]",
              "[--doc <id>]",
              "[--tag <tag>]",
              "[--include-missing]",
              "[--max-docs <n>]",
              "[--max-chunks <n>]",
              "[--all]",
            ],
            description:
              "Rebuild chunks + embeddings when chunker changes (use --include-missing for legacy docs without metadata)",
          },
          {
            name: "reindex",
            argv: ["reindex", "[--clean]", "[--doc <id>]"],
            description:
              "Re-embed existing chunks in-place (updates embeddings only; does NOT remove/re-add documents)",
          },
          { name: "config", argv: ["config", "<subcommand>"], description: "Config show/get/set" },
          { name: "update", argv: ["update"], description: "Self-update (text mode only)" },
          { name: "mcp", argv: ["mcp"], description: "Start MCP server (stdio)" },
          {
            name: "serve",
            argv: [
              "serve",
              "[--host <host>]",
              "[--port <port>]",
              "[--auth-token <token>]",
            ],
            description:
              `Start MCP server over HTTP for remote access (default ${DEFAULT_SERVER_CONFIG.host}:${DEFAULT_SERVER_CONFIG.port})`,
          },
        ],
        schemas: {
          // Schema.Class returns a class value that is also a schema at runtime, but
          // TS doesn't model it as `Schema.Schema<...>` cleanly. Cast for capabilities output.
          Document: JSONSchema.make(Document as any),
          PDFChunk: JSONSchema.make(PDFChunk as any),
          SearchResult: JSONSchema.make(SearchResult as any),
          Config: JSONSchema.make(Config as any),
        },
      };

      resultPayload = result;
      if (format === "text") {
        yield* Console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    case "add": {
      const pathOrUrl = args[1];
      if (!pathOrUrl) {
        yield* Console.error("Error: Path or URL required");
        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "Path or URL required", {
	            command: "add",
	          })
	        );
	      }

      const opts = parseArgs(args.slice(2));
      const tags = opts.tags
        ? (opts.tags as string).split(",").map((t) => t.trim())
        : undefined;

      let localPath: string;
      let title = opts.title as string | undefined;

      if (isURL(pathOrUrl)) {
        // Download from URL
        const config = LibraryConfig.fromEnv();
        const downloadsDir = join(config.libraryPath, "downloads");

        // Ensure downloads directory exists
        if (!existsSync(downloadsDir)) {
          mkdirSync(downloadsDir, { recursive: true });
        }

        const filename = filenameFromURL(pathOrUrl);
        localPath = join(downloadsDir, filename);

        // Default title from URL filename if not provided
        if (!title) {
          // Strip extension (.pdf, .md, .markdown)
          title = basename(filename).replace(/\.(pdf|md|markdown)$/, "");
        }

        yield* Console.log(`Downloading: ${pathOrUrl}`);
        yield* downloadFile(pathOrUrl, localPath);
        yield* Console.log(`  Saved to: ${localPath}`);
      } else {
        localPath = pathOrUrl;
      }

      yield* Console.log(`Adding: ${localPath}`);

      // Enrich by default unless --no-enrich is passed
      const enrich = opts["no-enrich"] !== true;
      const forceProvider = opts.provider as "ollama" | "anthropic" | undefined;
      let enrichedTitle = title;
      let enrichedTags = tags || [];

      if (enrich) {
        const providerLabel = forceProvider || "auto";
        yield* Console.log(`  Enriching with LLM (${providerLabel})...`);
        const tagger = yield* AutoTagger;
        const pdfExtractor = yield* PDFExtractor;
        const ext = extname(localPath).toLowerCase();
        let content: string | undefined;

        if (ext === ".pdf") {
          const extractResult = yield* Effect.either(
            pdfExtractor.extract(localPath)
          );
          if (extractResult._tag === "Right") {
            const pages = extractResult.right.pages.slice(0, 10);
            content = pages.map((p) => p.text).join("\n\n");
            if (content.length > 8000) {
              content = content.slice(0, 8000);
            }
          }
        } else if (ext === ".md" || ext === ".markdown") {
          const readResult = yield* Effect.either(
            Effect.promise(() => Bun.file(localPath).text())
          );
          if (readResult._tag === "Right") {
            content = readResult.right;
          }
        }

        if (content) {
          const enrichResult = yield* tagger.enrich(localPath, content, {
            provider: forceProvider,
          });
          enrichedTitle = enrichedTitle || enrichResult.title;
          enrichedTags = [...enrichedTags, ...enrichResult.tags];
          yield* Console.log(`  Title: ${enrichResult.title}`);
          yield* Console.log(`  Summary: ${enrichResult.summary}`);
          // Proposed concepts are now auto-accepted in AutoTagger
          if (
            enrichResult.proposedConcepts &&
            enrichResult.proposedConcepts.length > 0
          ) {
            yield* Console.log(
              `  Auto-accepted ${enrichResult.proposedConcepts.length} concept(s)`
            );
          }
        }
      }

	      const doc = yield* library.add(
	        localPath,
	        new AddOptions({
	          title: enrichedTitle,
	          tags: enrichedTags.length > 0 ? enrichedTags : undefined,
	        })
	      );
	      resultPayload = doc;
	      yield* Console.log(`✓ Added: ${doc.title}`);
	      yield* Console.log(`  ID: ${doc.id}`);
	      yield* Console.log(`  Pages: ${doc.pageCount}`);
      yield* Console.log(
        `  Size: ${(doc.sizeBytes / 1024 / 1024).toFixed(2)} MB`
      );
      if (doc.tags.length) yield* Console.log(`  Tags: ${doc.tags.join(", ")}`);
      agentResult = { _tag: "add", title: doc.title, id: doc.id };
      break;
    }

		    case "search": {
		      const query = args[1];
		      if (!query) {
		        yield* Console.error("Error: Query required");
		        return yield* Effect.fail(
		          new CLIError("INVALID_ARGS", "Query required", { command: "search" })
		        );
		      }

      const opts = parseArgs(args.slice(2));
      const limit = opts.limit ? parseInt(opts.limit as string, 10) : 10;
      const tags = opts.tag ? [opts.tag as string] : undefined;
      const ftsOnly = opts.fts === true;
      const expandChars = opts.expand
        ? Math.min(4000, Math.max(0, parseInt(opts.expand as string, 10)))
        : 0;
      const conceptsOnly = opts["concepts-only"] === true;
      const docsOnly = opts["docs-only"] === true;
      const includeClusters = opts["include-clusters"] === true;

      // Determine what to search
      const searchDocs = !conceptsOnly;
      const searchConcepts = !docsOnly;

      const modeLabel = conceptsOnly
        ? " (concepts only)"
        : docsOnly
        ? " (docs only)"
        : "";

	      // Track results for agent hints
	      let hintDocResults: { title: string; docId: string; chunkId?: string; score: number }[] = [];
	      let hintConceptResults: { id: string; prefLabel: string }[] = [];
	      let docResults: any[] = [];
	      let conceptResults: Concept[] = [];

      yield* Console.log(
        `Searching: "${query}"${ftsOnly ? " (FTS only)" : ""}${modeLabel}${
          expandChars > 0 ? ` (expand: ${expandChars} chars)` : ""
        }\n`
      );

	      // Search concepts first (if enabled)
	      if (searchConcepts) {
	        const taxonomy = yield* TaxonomyService;
	        const embedProvider = yield* EmbeddingProvider;

	        // Try vector search on concepts using EmbeddingProvider
	        const foundConcepts = yield* Effect.gen(function* () {
	          const healthCheck = yield* Effect.either(embedProvider.checkHealth());
	          if (healthCheck._tag === "Right") {
	            const queryEmbedding = yield* embedProvider.embed(query);
	            const similar = yield* taxonomy.findSimilarConcepts(
	              queryEmbedding,
	              0.3, // Lower threshold for broader results
	              limit
	            );
	            return similar;
	          }
	          // Fallback to text search on concepts if Ollama unavailable
	          const allConcepts = yield* taxonomy.listConcepts();
	          const queryLower = query.toLowerCase();
	          return allConcepts
	            .filter(
	              (c) =>
	                c.prefLabel.toLowerCase().includes(queryLower) ||
	                c.altLabels.some((alt) =>
	                  alt.toLowerCase().includes(queryLower)
	                ) ||
	                (c.definition &&
	                  c.definition.toLowerCase().includes(queryLower))
	            )
	            .slice(0, limit);
	        }).pipe(Effect.catchAll(() => Effect.succeed([] as Concept[])));

	        conceptResults = foundConcepts;
	        hintConceptResults = foundConcepts.map((c) => ({ id: c.id, prefLabel: c.prefLabel }));

	        if (foundConcepts.length > 0) {
	          yield* Console.log(`📚 Concepts (${foundConcepts.length}):\n`);
	          for (const c of foundConcepts) {
	            yield* Console.log(`🏷️  ${c.prefLabel} (${c.id})`);
	            if (c.definition) {
	              yield* Console.log(
	                `    ${c.definition.slice(0, 150).replace(/\n/g, " ")}${
	                  c.definition.length > 150 ? "..." : ""
	                }`
	              );
	            }
	            yield* Console.log("");
	          }
	        }
	      }

	      // Search documents (if enabled)
	      if (searchDocs) {
	        const results = ftsOnly
	          ? yield* library.ftsSearch(query, new SearchOptions({ limit, tags }))
	          : yield* library.search(
	              query,
	              new SearchOptions({
	                limit,
	                tags,
	                hybrid: true,
	                expandChars,
	                includeClusterSummaries: includeClusters,
	              })
	            );
	        docResults = results;

	        hintDocResults = results.map((r) => ({
	          title: r.title,
	          docId: r.docId,
	          chunkId: r.chunkId,
	          score: r.score,
	        }));

        if (results.length > 0) {
          if (searchConcepts) {
            yield* Console.log(`📄 Documents (${results.length}):\n`);
          }
          for (const r of results) {
            yield* Console.log(
              `[${r.score.toFixed(3)}|${r.matchType}] ${r.title} (p.${r.page}) [chunk:${r.chunkId}]`
            );

            if (r.expandedContent) {
              // Show expanded content (always available now, larger with --expand)
              const content = r.expandedContent.replace(/\n/g, "\n  ");
              if (expandChars > 0) {
                yield* Console.log(`  ${content}`);
              } else {
                // Default: show first 500 chars of expanded content
                const truncated = content.length > 500
                  ? content.slice(0, 500) + "..."
                  : content;
                yield* Console.log(`  ${truncated}`);
              }
            } else {
              yield* Console.log(
                `  ${r.content.slice(0, 200).replace(/\n/g, " ")}...`
              );
            }
            yield* Console.log("");
          }
        } else if (!searchConcepts) {
          yield* Console.log("No results found");
        }
      }

	      // Build agent result for hints
	      resultPayload = {
	        query,
	        options: {
	          limit,
	          tags: tags ?? null,
	          ftsOnly,
	          expandChars,
	          conceptsOnly,
	          docsOnly,
	          includeClusters,
	        },
	        concepts: conceptResults,
	        documents: docResults,
	      };

	      agentResult = {
	        _tag: "search",
	        query,
	        results: hintDocResults,
	        concepts: hintConceptResults,
        hadExpand: expandChars > 0,
        wasFts: ftsOnly,
		      };
		      break;
		    }

        case "search-pack": {
          const { positionals: maybeQueries, flagArgs } = splitPositionalsAndFlags(
            args.slice(1)
          );

          const opts = parseArgs(flagArgs);
          const limit = opts.limit ? parseInt(String(opts.limit), 10) : 10;
          const tags = opts.tag ? [String(opts.tag)] : undefined;
          const ftsOnly = opts.fts === true;
          const expandChars = opts.expand
            ? Math.min(4000, Math.max(0, parseInt(String(opts.expand), 10)))
            : 0;
          const withContent = opts["with-content"] === true;
          const globalLimitRaw = opts["global-limit"];
          const globalLimit =
            typeof globalLimitRaw === "string"
              ? Math.max(1, parseInt(globalLimitRaw, 10))
              : null;

          let queries = maybeQueries;

          // If no queries were provided as args, read queries from stdin (one per line).
          if (queries.length === 0) {
            if (process.stdin.isTTY) {
              return yield* Effect.fail(
                new CLIError(
                  "INVALID_ARGS",
                  "search-pack requires queries as args or via stdin",
                  {
                    command: "search-pack",
                    hint: 'pdf-brain search-pack "query one" "query two"',
                  }
                )
              );
            }

            const stdinText = yield* Effect.tryPromise({
              try: () =>
                new Promise<string>((resolve, reject) => {
                  let data = "";
                  try {
                    process.stdin.setEncoding("utf8");
                  } catch {
                    // ignore
                  }
                  process.stdin.on("data", (chunk) => {
                    data += String(chunk);
                  });
                  process.stdin.on("end", () => resolve(data));
                  process.stdin.on("error", (err) => reject(err));
                }),
              catch: (e) =>
                new CLIError("IO_ERROR", "Failed to read stdin", {
                  reason: String(e),
                }),
            });

            queries = stdinText
              .split(/\r?\n/g)
              .map((l) => l.trim())
              .filter((l) => l.length > 0 && !l.startsWith("#"));
          }

          if (queries.length === 0) {
            return yield* Effect.fail(
              new CLIError("INVALID_ARGS", "No queries provided", {
                command: "search-pack",
              })
            );
          }

          type ChunkHandle = {
            chunkId: string;
            docId: string;
            title: string;
            page: number;
            chunkIndex: number;
            score: number;
            rawScore: number;
            scoreType: string;
            matchType: string;
            vectorScore?: number;
            ftsRank?: number;
            // Optional payload for verbose workflows
            content?: string;
            expandedContent?: string;
          };

          const toHandle = (r: SearchResult): ChunkHandle => ({
            chunkId: r.chunkId,
            docId: r.docId,
            title: r.title,
            page: r.page,
            chunkIndex: r.chunkIndex,
            score: r.score,
            rawScore: r.rawScore,
            scoreType: r.scoreType,
            matchType: r.matchType,
            vectorScore: r.vectorScore,
            ftsRank: r.ftsRank,
            ...(withContent
              ? { content: r.content, expandedContent: r.expandedContent }
              : {}),
          });

          const perQuery: Array<{ query: string; documents: ChunkHandle[] }> = [];
          const merged = new Map<
            string,
            { best: ChunkHandle; matchedQueries: Set<string> }
          >();

          for (const query of queries) {
            const results = ftsOnly
              ? yield* library.ftsSearch(
                  query,
                  new SearchOptions({ limit, tags })
                )
              : yield* library.search(
                  query,
                  new SearchOptions({
                    limit,
                    tags,
                    hybrid: true,
                    expandChars,
                  })
                );

            const handles = results.map(toHandle);
            perQuery.push({ query, documents: handles });

            for (const h of handles) {
              const existing = merged.get(h.chunkId);
              if (!existing) {
                merged.set(h.chunkId, { best: h, matchedQueries: new Set([query]) });
                continue;
              }
              existing.matchedQueries.add(query);
              if (h.score > existing.best.score) {
                existing.best = h;
              }
            }
          }

          let deduped = Array.from(merged.values()).map(({ best, matchedQueries }) => ({
            ...best,
            matchedQueries: Array.from(matchedQueries).sort(),
          }));

          deduped.sort((a, b) => b.score - a.score);
          if (typeof globalLimit === "number" && !Number.isNaN(globalLimit)) {
            deduped = deduped.slice(0, globalLimit);
          }

          resultPayload = {
            queries,
            options: {
              limit,
              tags: tags ?? null,
              ftsOnly,
              expandChars,
              withContent,
              globalLimit,
            },
            perQuery,
            deduped,
          };

          agentResult = {
            _tag: "searchPack",
            queries,
            results: deduped.map((r) => ({
              title: r.title,
              docId: r.docId,
              chunkId: r.chunkId,
              score: r.score,
            })),
          };
          break;
        }

    case "taxonomy": {
      const subcommand = args[1];
      const taxonomy = yield* TaxonomyService;

      if (!subcommand) {
        yield* Console.error("Error: taxonomy subcommand required");
        yield* Console.error(
          "Usage: pdf-brain taxonomy <list|tree|search|add> [args]"
        );
        return yield* Effect.fail(
          new CLIError("INVALID_ARGS", "taxonomy subcommand required", {
            available: ["list", "tree", "search", "add"],
          })
        );
      }

      if (subcommand === "list") {
        const opts = parseArgs(args.slice(2));
        const includeTree = opts.tree === true;

        const concepts = yield* taxonomy.listConcepts();

        if (includeTree) {
          const roots = yield* Effect.promise(() => buildTreeStructure(taxonomy));
          resultPayload = { concepts, tree: roots };

          if (format === "text") {
            yield* Console.log(`Concepts: ${concepts.length}\n`);
            for (const root of roots) {
              for (const line of renderConceptTree(root)) {
                yield* Console.log(line);
              }
              yield* Console.log("");
            }
          }
        } else {
          resultPayload = { concepts };

          if (format === "text") {
            yield* Console.log(`Concepts: ${concepts.length}\n`);
            for (const c of concepts) {
              yield* Console.log(`• ${c.prefLabel} (${c.id})`);
            }
          }
        }

        agentResult = { _tag: "taxonomyList", count: concepts.length };
        break;
      }

      if (subcommand === "tree") {
        const rootId = args[2];
        const roots = yield* Effect.promise(() =>
          buildTreeStructure(taxonomy, rootId)
        );

        if (rootId && roots.length === 0) {
          yield* Console.error(`Concept not found: ${rootId}`);
          return yield* Effect.fail(
            new CLIError("NOT_FOUND", `Concept not found: ${rootId}`, {
              rootId,
            })
          );
        }

        resultPayload = { rootId: rootId ?? null, tree: roots };

        if (format === "text") {
          for (const root of roots) {
            for (const line of renderConceptTree(root)) {
              yield* Console.log(line);
            }
            yield* Console.log("");
          }
        }

        agentResult = { _tag: "taxonomyTree", rootId: rootId ?? undefined };
        break;
      }

      if (subcommand === "search") {
        const query = args[2];
        if (!query) {
          yield* Console.error("Error: query required");
          yield* Console.error("Usage: pdf-brain taxonomy search <query>");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "query required", {
              command: "taxonomy search",
            })
          );
        }

        const opts = parseArgs(args.slice(3));
        const limit = opts.limit ? parseInt(String(opts.limit), 10) : 10;
        const threshold = opts.threshold
          ? parseFloat(String(opts.threshold))
          : 0.3;

        const embedProvider = yield* EmbeddingProvider;

        let mode: "vector" | "text" = "text";
        let matches: Concept[] = [];

        const healthCheck = yield* Effect.either(embedProvider.checkHealth());
        if (healthCheck._tag === "Right") {
          mode = "vector";
          const queryEmbedding = yield* embedProvider.embed(query);
          matches = yield* taxonomy.findSimilarConcepts(
            queryEmbedding,
            threshold,
            limit
          );
        } else {
          mode = "text";
          const all = yield* taxonomy.listConcepts();
          const q = query.toLowerCase();
          matches = all
            .filter(
              (c) =>
                c.prefLabel.toLowerCase().includes(q) ||
                c.altLabels.some((alt) => alt.toLowerCase().includes(q)) ||
                (c.definition && c.definition.toLowerCase().includes(q))
            )
            .slice(0, limit);
        }

        resultPayload = { query, mode, limit, threshold, matches };

        if (format === "text") {
          yield* Console.log(`Matches: ${matches.length}\n`);
          for (const c of matches) {
            yield* Console.log(`• ${c.prefLabel} (${c.id})`);
            if (c.definition) {
              yield* Console.log(
                `  ${c.definition.slice(0, 160).replace(/\n/g, " ")}${
                  c.definition.length > 160 ? "..." : ""
                }`
              );
            }
          }
        }

        agentResult = {
          _tag: "taxonomySearch",
          query,
          matches: matches.map((c) => ({ id: c.id, prefLabel: c.prefLabel })),
        };
        break;
      }

      if (subcommand === "add") {
        const id = args[2];
        if (!id) {
          yield* Console.error("Error: concept id required");
          yield* Console.error(
            "Usage: pdf-brain taxonomy add <id> --label \"<name>\" [--broader <parent>]"
          );
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "concept id required", {
              command: "taxonomy add",
            })
          );
        }

        const opts = parseArgs(args.slice(3));
        const labelRaw = opts.label;
        const label = typeof labelRaw === "string" ? labelRaw : undefined;
        const broaderRaw = opts.broader;
        const broader = typeof broaderRaw === "string" ? broaderRaw : undefined;
        const definitionRaw = opts.definition;
        const definition =
          typeof definitionRaw === "string" ? definitionRaw : undefined;
        const altLabelsRaw = (opts["alt-labels"] as string | boolean | undefined) ?? (opts.altLabels as string | boolean | undefined);
        const altLabels =
          typeof altLabelsRaw === "string"
            ? altLabelsRaw.split(",").map((s) => s.trim()).filter(Boolean)
            : undefined;

        if (!label) {
          yield* Console.error("Error: --label required");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "--label required", {
              command: "taxonomy add",
              hint: "pdf-brain taxonomy add my/concept --label \"My Concept\"",
            })
          );
        }

        yield* taxonomy.addConcept({
          id,
          prefLabel: label,
          altLabels,
          definition,
        });

        if (broader) {
          yield* taxonomy.addBroader(id, broader);
        }

        // Best-effort: store concept embedding so it becomes searchable via vectors.
        const embedProvider = yield* EmbeddingProvider;
        const healthCheck = yield* Effect.either(embedProvider.checkHealth());
        const storedEmbedding = healthCheck._tag === "Right";
        if (storedEmbedding) {
          const embedding = yield* embedProvider.embed(label);
          yield* taxonomy.storeConceptEmbedding(id, embedding);
        }

        resultPayload = {
          id,
          prefLabel: label,
          broader: broader ?? null,
          storedEmbedding,
        };

        if (format === "text") {
          yield* Console.log(`✓ Added concept: ${label} (${id})`);
          if (broader) yield* Console.log(`  broader: ${broader}`);
        }

        agentResult = { _tag: "taxonomyTree", rootId: id };
        break;
      }

      yield* Console.error(`Unknown taxonomy subcommand: ${subcommand}`);
      return yield* Effect.fail(
        new CLIError(
          "INVALID_ARGS",
          `Unknown taxonomy subcommand: ${subcommand}`,
          { subcommand, available: ["list", "tree", "search", "add"] }
        )
      );
    }

		    case "chunk": {
		      const subcommand = args[1];
		      if (subcommand !== "get") {
		        yield* Console.error("Usage: pdf-brain chunk get <chunkId>");
		        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "Unknown chunk subcommand", {
	            subcommand,
	            hint: "pdf-brain chunk get <chunkId>",
	          })
	        );
	      }

	      const chunkId = args[2];
	      if (!chunkId) {
	        yield* Console.error("Error: chunkId required");
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "chunkId required", {
	            command: "chunk get",
	          })
	        );
	      }

	      const chunk = yield* library.getChunk(chunkId);
	      if (!chunk) {
	        yield* Console.error(`Chunk not found: ${chunkId}`);
	        return yield* Effect.fail(
	          new CLIError("NOT_FOUND", `Chunk not found: ${chunkId}`, { chunkId })
	        );
	      }

	      resultPayload = chunk;
	      if (format === "text") {
	        // Agent-friendly default in text mode: print only the content.
	        yield* Console.log(chunk.content);
	      }
	      break;
	    }

	    case "doc": {
	      const subcommand = args[1];
	      if (subcommand !== "chunks") {
	        yield* Console.error(
	          "Usage: pdf-brain doc chunks <docId> [--page N]"
	        );
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "Unknown doc subcommand", {
	            subcommand,
	            hint: "pdf-brain doc chunks <docId> [--page N]",
	          })
	        );
	      }

	      const docId = args[2];
	      if (!docId) {
	        yield* Console.error("Error: docId required");
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "docId required", {
	            command: "doc chunks",
	          })
	        );
	      }

	      const opts = parseArgs(args.slice(3));
	      const page = opts.page ? Number(opts.page) : undefined;

	      if (page !== undefined && (Number.isNaN(page) || page <= 0)) {
	        yield* Console.error(`Error: --page must be a positive number`);
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "--page must be a positive number", {
	            page: opts.page,
	          })
	        );
	      }

	      const chunks = yield* library.listChunksByDocument(docId, {
	        page: page === undefined ? undefined : page,
	      });

	      // Keep this light: ids + coordinates (content is fetched via `chunk get`).
	      resultPayload = {
	        docId,
	        page: page ?? null,
	        chunks: chunks.map((c) => ({
	          id: c.id,
	          docId: c.docId,
	          page: c.page,
	          chunkIndex: c.chunkIndex,
	        })),
	      };

	      if (format === "text") {
	        for (const c of chunks) {
	          yield* Console.log(`${c.id}\tpage=${c.page}\tchunkIndex=${c.chunkIndex}`);
	        }
	      }
	      break;
	    }

	    case "page": {
	      const subcommand = args[1];
	      if (subcommand !== "get") {
	        yield* Console.error("Usage: pdf-brain page get <docId> <page>");
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "Unknown page subcommand", {
	            subcommand,
	            hint: "pdf-brain page get <docId> <page>",
	          })
	        );
	      }

	      const docId = args[2];
	      const page = args[3] ? Number(args[3]) : NaN;
	      if (!docId || Number.isNaN(page) || page <= 0) {
	        yield* Console.error("Error: docId and page required");
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "docId and page required", {
	            docId,
	            page: args[3],
	          })
	        );
	      }

	      const chunks = yield* library.listChunksByDocument(docId, { page });
	      const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
	      const content = sorted.map((c) => c.content).join("\n\n");

	      resultPayload = {
	        docId,
	        page,
	        chunkCount: sorted.length,
	        chunkIds: sorted.map((c) => c.id),
	        content,
	      };

	      if (format === "text") {
	        // Agent-friendly default in text mode: print only the content.
	        yield* Console.log(content);
	      }
	      break;
	    }

	    case "list": {
	      const opts = parseArgs(args.slice(1));
	      const tag = opts.tag as string | undefined;

	      const docs = yield* library.list(tag);
	      resultPayload = { tag: tag ?? null, documents: docs };

	      if (docs.length === 0) {
	        yield* Console.log(
	          tag ? `No documents with tag "${tag}"` : "Library is empty"
        );
      } else {
        yield* Console.log(`Documents: ${docs.length}\n`);
        for (const doc of docs) {
          const tags = doc.tags.length ? ` [${doc.tags.join(", ")}]` : "";
          yield* Console.log(`• ${doc.title} (${doc.pageCount} pages)${tags}`);
          yield* Console.log(`  ID: ${doc.id}`);
        }
      }
      agentResult = {
        _tag: "list",
        count: docs.length,
        tag,
        firstDoc: docs.length > 0 ? { title: docs[0].title, id: docs[0].id } : undefined,
      };
      break;
    }

	    case "read":
	    case "get": {
	      const id = args[1];
	      if (!id) {
	        yield* Console.error("Error: ID or title required");
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "ID or title required", {
	            command: command,
	          })
	        );
	      }

	      const doc = yield* library.get(id);
	      if (!doc) {
	        yield* Console.error(`Not found: ${id}`);
	        return yield* Effect.fail(
	          new CLIError("NOT_FOUND", `Not found: ${id}`, {
	            idOrTitle: id,
	          })
	        );
	      }

	      resultPayload = doc;

	      if (format === "text") {
	        yield* Console.log(`Title: ${doc.title}`);
	        yield* Console.log(`ID: ${doc.id}`);
	        yield* Console.log(`Path: ${doc.path}`);
	        yield* Console.log(`Pages: ${doc.pageCount}`);
	        yield* Console.log(
	          `Size: ${(doc.sizeBytes / 1024 / 1024).toFixed(2)} MB`
	        );
	        yield* Console.log(`Added: ${doc.addedAt}`);
	        yield* Console.log(
	          `Tags: ${doc.tags.length ? doc.tags.join(", ") : "(none)"}`
	        );
	      }
	      agentResult = { _tag: "read", title: doc.title, id: doc.id, tags: [...doc.tags] };
	      break;
	    }

	    case "remove": {
	      const id = args[1];
	      if (!id) {
	        yield* Console.error("Error: ID or title required");
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "ID or title required", {
	            command: "remove",
	          })
	        );
	      }

	      const doc = yield* library.remove(id);
	      resultPayload = doc;
	      yield* Console.log(`✓ Removed: ${doc.title}`);
	      agentResult = { _tag: "remove", title: doc.title };
	      break;
	    }

	    case "tag": {
	      const id = args[1];
	      const tags = args[2];
	      if (!id || !tags) {
	        yield* Console.error("Error: ID and tags required");
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "ID and tags required", {
	            command: "tag",
	          })
	        );
	      }

	      const tagList = tags.split(",").map((t) => t.trim());
	      const doc = yield* library.tag(id, tagList);
	      resultPayload = doc;
	      yield* Console.log(
	        `✓ Updated tags for "${doc.title}": ${tagList.join(", ")}`
	      );
	      agentResult = { _tag: "tag", title: doc.title, tags: tagList };
	      break;
	    }

	    case "stats": {
	      const stats = yield* library.stats();
	      resultPayload = stats;
	      yield* Console.log(`PDF Library Stats`);
	      yield* Console.log(`─────────────────`);
	      yield* Console.log(`Documents:  ${stats.documents}`);
	      yield* Console.log(`Chunks:     ${stats.chunks}`);
	      yield* Console.log(`Embeddings: ${stats.embeddings}`);
	      yield* Console.log(`Location:   ${stats.libraryPath}`);
      agentResult = {
        _tag: "stats",
        documents: stats.documents,
        chunks: stats.chunks,
        embeddings: stats.embeddings,
      };
      break;
    }

	    case "config": {
	      const subcommand = args[1];
	      const config = loadConfig();
      const configPath = resolveConfigPath();

	      if (!subcommand || subcommand === "show") {
	        // Show all config
	        yield* Console.log(`PDF Library Config (${configPath})`);
        yield* Console.log(
          `───────────────────────────────────────────────────────────────────`
        );
        yield* Console.log(
          `Embedding:   ${config.embedding.provider} / ${config.embedding.model}`
        );
        yield* Console.log(
          `Enrichment:  ${config.enrichment.provider} / ${config.enrichment.model}`
        );
        yield* Console.log(
          `Judge:       ${config.judge.provider} / ${config.judge.model}`
        );
        yield* Console.log("");
        yield* Console.log(
          `Ollama:      ${config.ollama.host} (auto-install: ${
            config.ollama.autoInstall ? "on" : "off"
          })`
        );
        yield* Console.log("");
        yield* Console.log(`Database:    ${config.database.backend}`);
        yield* Console.log(
          `Qdrant:      ${config.database.qdrant.url} / ${config.database.qdrant.collection}`
        );
        yield* Console.log("");
        yield* Console.log(`Server:      ${config.server.host}:${config.server.port}`);
        yield* Console.log(
          `Auth:        ${
            config.server.auth.enabled ? "enabled" : "disabled"
          }${config.server.auth.token ? " (token set)" : ""}`
        );
        yield* Console.log("");
	        const hasKey = config.gatewayApiKey;
	        yield* Console.log(
	          hasKey
	            ? `Gateway:     API key configured`
	            : `Gateway:     No API key (set via: pdf-brain config set gateway.apiKey <key>)`
	        );
	        resultPayload = {
	          configPath,
	          config,
	          gatewayApiKeyConfigured: Boolean(hasKey),
	        };
	      } else if (subcommand === "get") {
	        const path = args[2];
	        if (!path) {
	          yield* Console.error("Error: Path required");
	          yield* Console.error("Usage: pdf-brain config get <path>");
	          yield* Console.error("Example: pdf-brain config get embedding.model");
	          return yield* Effect.fail(
	            new CLIError("INVALID_ARGS", "Path required", {
	              command: "config get",
	              hint: "pdf-brain config get embedding.model",
	            })
	          );
	        }

        // Navigate config object by path (e.g., "embedding.model")
        const parts = path.split(".");
        let value: any = config;
	        for (const part of parts) {
	          if (value && typeof value === "object" && part in value) {
	            value = (value as any)[part];
	          } else {
	            yield* Console.error(`Config path not found: ${path}`);
	            return yield* Effect.fail(
	              new CLIError("NOT_FOUND", `Config path not found: ${path}`, {
	                path,
	              })
	            );
	          }
	        }

	        yield* Console.log(
	          typeof value === "object" ? JSON.stringify(value) : String(value)
	        );
	        resultPayload = { path, value };
	      } else if (subcommand === "set") {
	        const path = args[2];
	        const newValue = args[3];

	        if (!path || newValue === undefined) {
          yield* Console.error("Error: Path and value required");
          yield* Console.error("Usage: pdf-brain config set <path> <value>");
	          yield* Console.error(
	            "Example: pdf-brain config set embedding.model nomic-embed-text"
	          );
	          return yield* Effect.fail(
	            new CLIError("INVALID_ARGS", "Path and value required", {
	              command: "config set",
	              hint: "pdf-brain config set embedding.model nomic-embed-text",
	            })
	          );
	        }

        // Navigate and update config
        const parts = path.split(".");
        let target: any = config;
	        for (let i = 0; i < parts.length - 1; i++) {
	          const part = parts[i];
	          if (target && typeof target === "object" && part in target) {
	            target = (target as any)[part];
	          } else {
	            yield* Console.error(`Config path not found: ${path}`);
	            return yield* Effect.fail(
	              new CLIError("NOT_FOUND", `Config path not found: ${path}`, {
	                path,
	              })
	            );
	          }
	        }

        const lastPart = parts[parts.length - 1];
        if (target && typeof target === "object") {
          // Type coercion based on existing value type
          const oldValue = (target as any)[lastPart];
          let parsedValue: any = newValue;

          if (typeof oldValue === "boolean") {
            parsedValue = newValue === "true" || newValue === "1";
          } else if (typeof oldValue === "number") {
            parsedValue = parseFloat(newValue);
          }

	          (target as any)[lastPart] = parsedValue;
	          saveConfig(config);
	          yield* Console.log(`Updated ${path}: ${parsedValue}`);
	          resultPayload = { path, value: parsedValue };
	        } else {
	          yield* Console.error(`Config path not found: ${path}`);
	          return yield* Effect.fail(
	            new CLIError("NOT_FOUND", `Config path not found: ${path}`, {
	              path,
	            })
	          );
	        }
	      } else {
	        yield* Console.error(`Unknown config subcommand: ${subcommand}`);
	        yield* Console.error("Available: show, get, set");
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", `Unknown config subcommand: ${subcommand}`, {
	            subcommand,
	            available: ["show", "get", "set"],
	          })
	        );
	      }
	      agentResult = { _tag: "config", subcommand: subcommand || "show" };
	      break;
	    }

	    case "doctor": {
	      const opts = parseArgs(args.slice(1));
	      const shouldFix = opts.fix === true;
	      const config = LibraryConfig.fromEnv();
	      const dbPath = config.dbPath;
	      const walPath = `${dbPath}-wal`;
	      const legacyLibraryPath = join(config.libraryPath, "library"); // pglite-era data dir

	      yield* Console.log("🔍 Checking database health...\n");

	      // Check if library exists (either libsql DB file or legacy pglite dir)
	      if (!existsSync(dbPath) && !existsSync(legacyLibraryPath)) {
	        yield* Console.log("✓ Library not initialized yet (nothing to check)");
	        resultPayload = {
	          healthy: true,
	          checks: [],
	          dbPath,
	          didFix: shouldFix,
	        };
	        agentResult = { _tag: "doctor", healthy: true };
	        break;
	      }

	      // 1. Check WAL files
	      let walHealth: WALHealthResult;
	      if (existsSync(walPath)) {
	        let totalSizeBytes = 0;
	        try {
	          totalSizeBytes = statSync(walPath).size;
	        } catch {
	          totalSizeBytes = 0;
	        }

	        walHealth = assessWALHealth({
	          fileCount: 1,
	          totalSizeBytes,
	        });
	      } else {
	        walHealth = { healthy: true, warnings: [] };
	      }

	      // 2. Check for corrupted directories
	      const legacyDirs = existsSync(legacyLibraryPath)
	        ? readdirSync(legacyLibraryPath)
	        : [];
	      const corruptedDirs = existsSync(legacyLibraryPath)
	        ? checkCorruptedDirs(legacyLibraryPath, legacyDirs)
	        : { healthy: true, issues: [] };

      // 3. Check Ollama connectivity
      let ollamaReachable = false;
      try {
        yield* library.checkReady();
        ollamaReachable = true;
      } catch {
        ollamaReachable = false;
      }

      // 4. Check for orphaned data
      let orphanedData = { chunks: 0, embeddings: 0 };
      try {
        const repairResult = yield* library.repair();
        orphanedData = {
          chunks: repairResult.orphanedChunks,
          embeddings: repairResult.orphanedEmbeddings,
        };
	      } catch {
	        // If repair fails, assume no orphans (database might not exist)
	      }

	      // 5. Check chunker metadata freshness (agent usefulness depends on this)
	      let chunkerMissing = 0;
	      let chunkerMismatch = 0;
	      const chunkerSample: Array<{ id: string; title: string; reason: string; code: string }> = [];
	      try {
	        const docs = yield* library.list();
	        for (const doc of docs) {
	          const assessment = assessDocChunker(doc, config);
	          if (assessment.needsRechunk) {
	            if (assessment.code === "missing_metadata") chunkerMissing++;
	            else chunkerMismatch++;
	            if (chunkerSample.length < 10) {
	              chunkerSample.push({
	                id: doc.id,
	                title: doc.title,
	                reason: assessment.reason,
	                code: assessment.code,
	              });
	            }
	          }
	        }
	      } catch {
	        // ignore
	      }
	
	      const chunkerOutdated = chunkerMissing + chunkerMismatch;

	      // Assess overall health
	      const doctorHealth = assessDoctorHealth({
	        walHealth,
	        corruptedDirs,
	        ollamaReachable,
	        orphanedData,
	        chunker: { missing: chunkerMissing, mismatch: chunkerMismatch },
	      });

	      resultPayload = {
	        healthy: doctorHealth.healthy,
	        checks: doctorHealth.checks,
	        walHealth,
	        corruptedDirs,
	        ollamaReachable,
	        orphanedData,
	        chunker: {
	          outdated: chunkerOutdated,
	          missing: chunkerMissing,
	          mismatch: chunkerMismatch,
	          sample: chunkerSample,
	          chunkSize: config.chunkSize,
	          chunkOverlap: config.chunkOverlap,
	          unit: "chars",
	        },
	        didFix: shouldFix,
	      };

      // Display results
      yield* Console.log("📊 Health Check Results:\n");
      for (const check of doctorHealth.checks) {
        const severity =
          check.severity ?? (check.healthy ? ("ok" as const) : ("error" as const));
        const icon = severity === "ok" ? "✓" : severity === "warning" ? "!" : "✗";
        const status = severity === "ok" ? "ok" : severity === "warning" ? "WARNING" : "ISSUE";
        yield* Console.log(`${icon} ${check.name}: ${status}`);
        if (check.details) {
          yield* Console.log(`  ${check.details}`);
        }
      }

      yield* Console.log("");

      const hasWarnings = doctorHealth.checks.some(
        (c) => (c.severity ?? (c.healthy ? "ok" : "error")) === "warning",
      );

      if (doctorHealth.healthy && !hasWarnings) {
        yield* Console.log("✅ All checks passed! Database is healthy.");
      } else if (doctorHealth.healthy && hasWarnings) {
        yield* Console.log("✅ All checks passed (with warnings).");
      } else {
        yield* Console.log("⚠️  Issues detected.\n");

        // Auto-fix if requested
        if (shouldFix) {
          yield* Console.log("🔧 Attempting auto-repair...\n");

	          // Fix corrupted directories
	          if (!corruptedDirs.healthy) {
	            for (const dir of corruptedDirs.issues) {
	              const dirPath = join(legacyLibraryPath, dir);
	              try {
	                rmSync(dirPath, { recursive: true, force: true });
	                yield* Console.log(`  ✓ Removed corrupted directory: ${dir}`);
	              } catch (error) {
                yield* Console.log(`  ✗ Failed to remove ${dir}: ${error}`);
              }
            }
          }

          // Fix orphaned data (already done via repair() call)
	          if (orphanedData.chunks > 0 || orphanedData.embeddings > 0) {
	            yield* Console.log(
	              `  ✓ Cleaned ${orphanedData.chunks} orphaned chunks, ${orphanedData.embeddings} orphaned embeddings`
	            );
	          }

	          if (chunkerOutdated > 0) {
	            yield* Console.log(
	              `  ⚠ Chunker: ${chunkerOutdated} docs missing/outdated chunker metadata (run rechunk separately)`
	            );
	          }

	          yield* Console.log(
	            "\n✅ Repair complete. Run 'pdf-brain doctor' again to verify."
	          );
	        } else {
	          // Show recommendations
	          yield* Console.log("💡 Recommendations:\n");

          if (!walHealth.healthy) {
            yield* Console.log(
              "  WAL: Run CHECKPOINT or export/import to compact database"
            );
            yield* Console.log(
              "       pdf-brain export --output backup.tar.gz"
            );
            yield* Console.log("       pdf-brain import backup.tar.gz --force");
          }

          if (!corruptedDirs.healthy) {
            yield* Console.log(
              `  Corrupted dirs: Run 'pdf-brain doctor --fix' to remove`
            );
          }

          if (!ollamaReachable) {
            yield* Console.log(
              "  Ollama: Ensure Ollama is running (ollama serve)"
            );
          }

	          if (orphanedData.chunks > 0 || orphanedData.embeddings > 0) {
	            yield* Console.log(
	              "  Orphaned data: Already cleaned automatically"
	            );
	          }

	          if (chunkerOutdated > 0) {
	            yield* Console.log(
	              `  Chunker: ${chunkerOutdated} docs missing/outdated chunker metadata`
	            );
	            yield* Console.log(
	              "          Preview: pdf-brain rechunk --dry-run"
	            );
	            yield* Console.log(
	              "          Apply:   pdf-brain rechunk"
	            );
	          }

	          yield* Console.log(
	            "\n  Run 'pdf-brain doctor --fix' to auto-repair issues."
	          );
	        }
	      }
	      agentResult = {
	        _tag: "doctor",
	        healthy: doctorHealth.healthy,
	        chunkerOutdated,
	        chunkerMissing,
	        chunkerMismatch,
	      };
	      break;
	    }

	    case "check": {
	      yield* library.checkReady();
	      yield* Console.log("✓ Ollama is ready");
	      resultPayload = { reachable: true };
	      agentResult = { _tag: "check", reachable: true };
	      break;
	    }

    case "init": {
      const config = LibraryConfig.fromEnv();
      yield* Console.log("Initializing pdf-brain...\n");

      // 1. Check/create library directory
      if (!existsSync(config.libraryPath)) {
        mkdirSync(config.libraryPath, { recursive: true });
        yield* Console.log(
          `✓ Created library directory: ${config.libraryPath}`
        );
      } else {
        yield* Console.log(`✓ Library directory exists: ${config.libraryPath}`);
      }

      // 2. Initialize database (happens automatically via library.stats())
      yield* Console.log("✓ Database initialized");

      // 3. Check Ollama
      const ollamaResult = yield* Effect.either(library.checkReady());
      if (ollamaResult._tag === "Right") {
        yield* Console.log("✓ Ollama is ready");
      } else {
        yield* Console.log(
          "⚠ Ollama not available - run 'ollama serve' and pull models:"
        );
        yield* Console.log("    ollama pull mxbai-embed-large");
        yield* Console.log("    ollama pull llama3.2:3b");
      }

      // 4. Seed taxonomy if empty
      const taxonomyLayer = TaxonomyServiceImpl.make({
        url: `file:${config.dbPath}`,
      });
      const seedResult = yield* Effect.either(
        Effect.gen(function* () {
          const taxonomy = yield* TaxonomyService;
          const concepts = yield* taxonomy.listConcepts();

          if (concepts.length === 0) {
            // Load and seed default taxonomy
            const taxonomyFile = join(__dirname, "..", "data", "taxonomy.json");
            if (existsSync(taxonomyFile)) {
              const taxonomyData = JSON.parse(
                readFileSync(taxonomyFile, "utf-8")
              ) as TaxonomyJSON;
              yield* taxonomy.seedFromJSON(taxonomyData);
              yield* Console.log(
                `✓ Seeded taxonomy with ${taxonomyData.concepts.length} concepts`
              );
            } else {
              yield* Console.log(
                "⚠ No taxonomy.json found - skipping taxonomy seed"
              );
            }
          } else {
            yield* Console.log(
              `✓ Taxonomy already has ${concepts.length} concepts`
            );
          }
        }).pipe(Effect.provide(taxonomyLayer))
      );

      if (seedResult._tag === "Left") {
        yield* Console.log(
          "⚠ Taxonomy seed failed - you can seed manually with 'pdf-brain taxonomy seed'"
        );
      }

      // 5. Show stats
      const stats = yield* library.stats();
      yield* Console.log(`\n📊 Library Status:`);
      yield* Console.log(`   Documents:  ${stats.documents}`);
      yield* Console.log(`   Chunks:     ${stats.chunks}`);
      yield* Console.log(`   Embeddings: ${stats.embeddings}`);

	      yield* Console.log(`\n✨ Ready! Add documents with:`);
	      yield* Console.log(`   pdf-brain add <file.pdf> --enrich`);
	      yield* Console.log(`   pdf-brain ingest <directory> --enrich`);

	      resultPayload = {
	        libraryPath: config.libraryPath,
	        dbPath: config.dbPath,
	        ollamaReady: ollamaResult._tag === "Right",
	        taxonomySeedOk: seedResult._tag === "Right",
	        stats,
	      };
	      agentResult = {
	        _tag: "stats",
	        documents: stats.documents,
	        chunks: stats.chunks,
	        embeddings: stats.embeddings,
	      };
	      break;
	    }

	    case "repair": {
	      yield* Console.log("Checking database integrity...\n");
	      const result = yield* library.repair();
	      resultPayload = result;

      if (
        result.orphanedChunks === 0 &&
        result.orphanedEmbeddings === 0 &&
        result.zeroVectorEmbeddings === 0
      ) {
        yield* Console.log("✓ Database is healthy - no repairs needed");
      } else {
        yield* Console.log("Repairs completed:");
        if (result.orphanedChunks > 0) {
          yield* Console.log(
            `  • Removed ${result.orphanedChunks} orphaned chunks`
          );
        }
        if (result.orphanedEmbeddings > 0) {
          yield* Console.log(
            `  • Removed ${result.orphanedEmbeddings} orphaned embeddings`
          );
        }
        if (result.zeroVectorEmbeddings > 0) {
          yield* Console.log(
            `  • Removed ${result.zeroVectorEmbeddings} zero-dimension embeddings`
          );
        }
        yield* Console.log("\n✓ Database repaired");
      }
      agentResult = {
        _tag: "repair",
        orphanedChunks: result.orphanedChunks,
        orphanedEmbeddings: result.orphanedEmbeddings,
      };
      break;
    }

	    case "export": {
	      const opts = parseArgs(args.slice(1));
	      const config = LibraryConfig.fromEnv();
	      const outputPath =
        (opts.output as string) ||
        join(process.cwd(), "pdf-brain-export.tar.gz");

      yield* Console.log(`Exporting library database...`);
      yield* Console.log(`  Source: ${config.libraryPath}/library`);
      yield* Console.log(`  Output: ${outputPath}`);

      // Get stats first
      const stats = yield* library.stats();
      yield* Console.log(
        `  Contents: ${stats.documents} docs, ${stats.chunks} chunks, ${stats.embeddings} embeddings`
      );

      // Use tar to create archive
	      const tarResult = Bun.spawnSync(
	        ["tar", "-czf", outputPath, "-C", config.libraryPath, "library"],
	        { stdout: "pipe", stderr: "pipe" }
	      );
	      if (tarResult.exitCode !== 0) {
	        const stderr = tarResult.stderr.toString();
	        yield* Console.error(`Export failed: ${stderr}`);
	        return yield* Effect.fail(
	          new CLIError("EXPORT_FAILED", "Export failed", {
	            exitCode: tarResult.exitCode,
	            stderr,
	            outputPath,
	          })
	        );
	      }

      // Get file size
      const fileSize = Bun.file(outputPath).size;
      const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

	      yield* Console.log(`\n✓ Exported to ${outputPath} (${sizeMB} MB)`);
	      yield* Console.log(`\nTo import on another machine:`);
	      yield* Console.log(`  pdf-brain import ${basename(outputPath)}`);
	      resultPayload = {
	        outputPath,
	        sizeBytes: fileSize,
	        sizeMB: Number(sizeMB),
	        sourceDir: join(config.libraryPath, "library"),
	      };
	      break;
	    }

	    case "import": {
	      const importFile = args[1];
	      if (!importFile) {
	        yield* Console.error("Error: Import file required");
	        yield* Console.error("Usage: pdf-brain import <file.tar.gz> [--force]");
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "Import file required", {
	            command: "import",
	            hint: "pdf-brain import ./pdf-brain-export.tar.gz --force",
	          })
	        );
	      }

	      if (!existsSync(importFile)) {
	        yield* Console.error(`Error: File not found: ${importFile}`);
	        return yield* Effect.fail(
	          new CLIError("NOT_FOUND", `File not found: ${importFile}`, {
	            importFile,
	          })
	        );
	      }

      const opts = parseArgs(args.slice(2));
      const config = LibraryConfig.fromEnv();
      const libraryDir = join(config.libraryPath, "library");

	      // Check if library already exists
	      if (existsSync(libraryDir) && !opts.force) {
	        yield* Console.error(`Error: Library already exists at ${libraryDir}`);
	        yield* Console.error("Use --force to overwrite");
	        return yield* Effect.fail(
	          new CLIError("ALREADY_EXISTS", "Library already exists", {
	            libraryDir,
	            hint: "pdf-brain import <file.tar.gz> --force",
	          })
	        );
	      }

      yield* Console.log(`Importing library database...`);
      yield* Console.log(`  Source: ${importFile}`);
      yield* Console.log(`  Target: ${config.libraryPath}`);

      // Ensure parent directory exists
      if (!existsSync(config.libraryPath)) {
        mkdirSync(config.libraryPath, { recursive: true });
      }

      // Remove existing if force
	      if (existsSync(libraryDir) && opts.force) {
	        yield* Console.log(`  Removing existing library...`);
	        const rmResult = Bun.spawnSync(["rm", "-rf", libraryDir]);
	        if (rmResult.exitCode !== 0) {
	          yield* Console.error("Failed to remove existing library");
	          return yield* Effect.fail(
	            new CLIError("IO_ERROR", "Failed to remove existing library", {
	              libraryDir,
	              exitCode: rmResult.exitCode,
	            })
	          );
	        }
	      }

      // Extract archive
      const tarResult = Bun.spawnSync(
        ["tar", "-xzf", importFile, "-C", config.libraryPath],
        { stdout: "pipe", stderr: "pipe" }
      );
	      if (tarResult.exitCode !== 0) {
	        const stderr = tarResult.stderr.toString();
	        yield* Console.error(`Import failed: ${stderr}`);
	        return yield* Effect.fail(
	          new CLIError("IMPORT_FAILED", "Import failed", {
	            exitCode: tarResult.exitCode,
	            stderr,
	            importFile,
	            targetDir: config.libraryPath,
	          })
	        );
	      }

	      yield* Console.log(`\n✓ Library imported successfully`);
	      yield* Console.log(`\nRun 'pdf-brain stats' to verify`);
	      resultPayload = {
	        importFile,
	        targetDir: config.libraryPath,
	        overwritten: Boolean(opts.force),
	      };
	      break;
	    }

	    case "ingest": {
      // Support multiple directories: pdf-brain ingest dir1 dir2 dir3 --enrich
      const directories: string[] = [];
      let i = 1;
      while (i < args.length && !args[i].startsWith("--")) {
        directories.push(args[i]);
        i++;
      }

	      if (directories.length === 0) {
	        yield* Console.error("Error: At least one directory required");
        yield* Console.error(
          "Usage: pdf-brain ingest <dir1> [dir2] [dir3] [options]"
        );
        yield* Console.error("");
        yield* Console.error("Options:");
        yield* Console.error(
          "  --enrich       Full LLM enrichment (title, summary, concepts)"
        );
        yield* Console.error(
          "  --auto-tag     Light tagging (heuristics + LLM)"
        );
        yield* Console.error("  --tags a,b,c   Manual tags for all files");
        yield* Console.error("  --sample N     Process only first N files");
	        yield* Console.error("  --no-tui       Disable TUI, use simple output");
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "At least one directory required", {
	            command: "ingest",
	            hint: "pdf-brain ingest ./docs --enrich",
	          })
	        );
	      }

      // Resolve and validate directories
      const targetDirs: string[] = [];
	      for (const dir of directories) {
	        const targetDir = dir.startsWith("/") ? dir : join(process.cwd(), dir);
	        if (!existsSync(targetDir)) {
	          yield* Console.error(`Error: Directory not found: ${targetDir}`);
	          return yield* Effect.fail(
	            new CLIError("NOT_FOUND", `Directory not found: ${targetDir}`, {
	              targetDir,
	            })
	          );
	        }
	        const dirStat = statSync(targetDir);
	        if (!dirStat.isDirectory()) {
	          yield* Console.error(`Error: Not a directory: ${targetDir}`);
	          return yield* Effect.fail(
	            new CLIError("INVALID_ARGS", `Not a directory: ${targetDir}`, {
	              targetDir,
	            })
	          );
	        }
	        targetDirs.push(targetDir);
	      }

      const opts = parseArgs(args.slice(i));
      const recursive = opts.recursive !== false; // default true
      const manualTags = opts.tags
        ? (opts.tags as string).split(",").map((t) => t.trim())
        : undefined;
      const sampleSize = opts.sample
        ? parseInt(opts.sample as string, 10)
        : undefined;
      // Agent-only mode: TUI writes to stdout and will break JSON parsing.
      // Only allow TUI in explicit `--format text` mode.
      const useTui = format === "text" && opts["no-tui"] !== true;
      const autoTag = opts["auto-tag"] === true;
      const enrich = opts.enrich === true;
      // Always checkpoint after every file for crash safety
      const checkpointInterval = 1;

      // Discover files from all directories
      yield* Console.log(
        `Scanning ${targetDirs.length} director${
          targetDirs.length > 1 ? "ies" : "y"
        }...`
      );

      const discoverFiles = (dir: string): string[] => {
        const files: string[] = [];
        try {
          const entries = readdirSync(dir);
          for (const entry of entries) {
            const fullPath = join(dir, entry);
            try {
              const stat = statSync(fullPath);
              if (stat.isDirectory() && recursive) {
                files.push(...discoverFiles(fullPath));
              } else if (stat.isFile()) {
                const ext = extname(entry).toLowerCase();
                if (ext === ".pdf" || ext === ".md" || ext === ".markdown") {
                  files.push(fullPath);
                }
              }
            } catch {
              // Skip files we can't access
            }
          }
        } catch {
          // Skip directories we can't read
        }
        return files;
      };

      let files: string[] = [];
      for (const dir of targetDirs) {
        const found = discoverFiles(dir);
        yield* Console.log(`  ${basename(dir)}: ${found.length} files`);
        files.push(...found);
      }
      yield* Console.log(`Total: ${files.length} files`);

      if (files.length === 0) {
        yield* Console.log("No PDF or Markdown files found");
        resultPayload = {
          foundFiles: 0,
          skippedExisting: 0,
          processed: 0,
          succeeded: 0,
          failed: 0,
        };
        break;
      }

      // Apply sample limit if specified
      if (sampleSize && sampleSize < files.length) {
        files = files.slice(0, sampleSize);
        yield* Console.log(`Processing sample of ${sampleSize} files`);
      }

      // Check what's already in the library to skip duplicates
      const existingDocs = yield* library.list();
      const existingPaths = new Set(existingDocs.map((d) => d.path));
      const newFiles = files.filter((f) => !existingPaths.has(f));
      const skippedExisting = files.length - newFiles.length;

      if (newFiles.length < files.length) {
        yield* Console.log(
          `Skipping ${skippedExisting} already-ingested files`
        );
      }

      if (newFiles.length === 0) {
        yield* Console.log("All files already ingested");
        resultPayload = {
          foundFiles: files.length,
          skippedExisting,
          processed: 0,
          succeeded: 0,
          failed: 0,
        };
        break;
      }

      files = newFiles;

      // Check if we can use TUI (requires TTY)
      const canUseTui = useTui && process.stdout.isTTY && process.stdin.isTTY;
      if (useTui && !canUseTui) {
        yield* Console.log("TUI disabled (not a TTY), using simple output");
      }

      // Process files
      if (canUseTui) {
        // TUI mode
        const state = createInitialState();
        state.totalFiles = files.length;
        state.phase = "processing";

        const tui = renderIngestProgress(state);

        try {
          for (let i = 0; i < files.length; i++) {
            if (tui.isCancelled()) {
              tui.cleanup();
              yield* Console.log("\nIngestion cancelled by user");
              break;
            }

            const filePath = files[i];
            const filename = basename(filePath);

            const currentFile: FileStatus = {
              path: filePath,
              filename,
              status: "chunking",
            };

            tui.update({ currentFile });

            try {
              // Get tags - either manual, auto-generated, or none
              let fileTags = manualTags ? [...manualTags] : [];
              let title: string | undefined;

              if (autoTag || enrich) {
                const tagger = yield* AutoTagger;
                const pdfExtractor = yield* PDFExtractor;
                const ext = extname(filePath).toLowerCase();
                let content: string | undefined;

                if (ext === ".pdf") {
                  // Extract PDF text for enrichment
                  if (enrich) {
                    currentFile.status = "chunking";
                    tui.update({ currentFile });
                    const extractResult = yield* Effect.either(
                      pdfExtractor.extract(filePath)
                    );
                    if (extractResult._tag === "Right") {
                      const pages = extractResult.right.pages.slice(0, 10);
                      content = pages.map((p) => p.text).join("\n\n");
                      if (content.length > 8000) {
                        content = content.slice(0, 8000);
                      }
                    }
                  }
                } else if (ext === ".md" || ext === ".markdown") {
                  const readResult = yield* Effect.either(
                    Effect.promise(() => Bun.file(filePath).text())
                  );
                  if (readResult._tag === "Right") {
                    content = readResult.right;
                  }
                }

                currentFile.status = "embedding";
                tui.update({ currentFile });

                if (enrich && content) {
                  const enrichResult = yield* tagger.enrich(filePath, content, {
                    basePath: targetDirs[0],
                  });
                  title = enrichResult.title;
                  fileTags = [...fileTags, ...enrichResult.tags];
                } else if (enrich && !content) {
                  // Enrichment requested but no content
                  const tagResult = yield* tagger.generateTags(
                    filePath,
                    undefined,
                    {
                      heuristicsOnly: true,
                      basePath: targetDirs[0],
                    }
                  );
                  fileTags = [...fileTags, ...tagResult.allTags];
                } else {
                  const tagResult = yield* tagger.generateTags(
                    filePath,
                    content,
                    {
                      heuristicsOnly: !content,
                      basePath: targetDirs[0],
                    }
                  );
                  fileTags = [...fileTags, ...tagResult.allTags];
                }
              }

              // Add the file
              const doc = yield* library.add(
                filePath,
                new AddOptions({
                  title,
                  tags: fileTags.length > 0 ? fileTags : undefined,
                })
              );

              currentFile.status = "done";
              currentFile.chunks = doc.pageCount;

              tui.update({
                processedFiles: i + 1,
                currentFile,
                recentFiles: [...tui.getState().recentFiles, currentFile],
              });

              // Checkpoint every N documents to prevent WAL accumulation
              if (shouldCheckpoint(i + 1, checkpointInterval)) {
                tui.update({
                  checkpointInProgress: true,
                  checkpointMessage: `Checkpointing WAL (${i + 1} docs)...`,
                });

                const checkpointResult = yield* Effect.either(
                  library.checkpoint()
                );

                if (checkpointResult._tag === "Left") {
                  yield* Effect.log(
                    `Warning: Checkpoint failed at ${i + 1} docs: ${
                      checkpointResult.left
                    }`
                  );
                }

                tui.update({
                  checkpointInProgress: false,
                  checkpointMessage: undefined,
                  lastCheckpointAt: i + 1,
                });
              }
            } catch (error) {
              currentFile.status = "error";
              currentFile.error =
                error instanceof Error ? error.message : String(error);

              tui.update({
                processedFiles: i + 1,
                currentFile,
                recentFiles: [...tui.getState().recentFiles, currentFile],
                errors: [...tui.getState().errors, currentFile],
              });
            }
          }

          tui.update({ phase: "done", endTime: Date.now() });

          // Wait a moment for user to see final state
          yield* Effect.sleep("2 seconds");
          tui.cleanup();

          const finalState = tui.getState();
          yield* Console.log(
            `\n✓ Ingested ${
              finalState.processedFiles - finalState.errors.length
            } files`
          );
          if (finalState.errors.length > 0) {
            yield* Console.log(`⚠ ${finalState.errors.length} files failed`);
          }

          const processed = finalState.processedFiles;
          const failed = finalState.errors.length;
          resultPayload = {
            mode: "tui",
            totalPlanned: files.length,
            skippedExisting,
            processed,
            succeeded: processed - failed,
            failed,
            enrich,
            autoTag,
            manualTags: manualTags ?? null,
          };
        } catch (error) {
          tui.cleanup();
          throw error;
        }
      } else {
        // Simple console mode
        let processed = 0;
        let errors = 0;

        for (const filePath of files) {
          const filename = basename(filePath);
          processed++;

          try {
            const mode = enrich ? "enrich" : autoTag ? "auto-tag" : "manual";
            yield* Console.log(
              `[${processed}/${files.length}] Adding: ${filename}${
                mode !== "manual" ? ` (${mode})` : ""
              }`
            );

            // Start with manual tags
            let fileTags = manualTags ? [...manualTags] : [];
            let title: string | undefined;

            // For auto-tag or enrich, we need to read content first
            if (autoTag || enrich) {
              const tagger = yield* AutoTagger;
              const pdfExtractor = yield* PDFExtractor;

              // Read file content for LLM analysis
              const ext = extname(filePath).toLowerCase();
              let content: string | undefined;

              if (ext === ".pdf") {
                // Extract PDF text for enrichment
                if (enrich) {
                  yield* Console.log(`    Extracting PDF text...`);
                  const extractResult = yield* Effect.either(
                    pdfExtractor.extract(filePath)
                  );
                  if (extractResult._tag === "Right") {
                    // Use first 10 pages, max 8k chars
                    const pages = extractResult.right.pages.slice(0, 10);
                    content = pages.map((p) => p.text).join("\n\n");
                    if (content.length > 8000) {
                      content = content.slice(0, 8000);
                    }
                  }
                }
              } else {
                // For markdown, read directly
                const readResult = yield* Effect.either(
                  Effect.promise(() => Bun.file(filePath).text())
                );
                if (readResult._tag === "Right") {
                  content = readResult.right;
                }
              }

              if (enrich && content) {
                // Full enrichment with LLM
                yield* Console.log(`    Enriching with LLM...`);
                const enrichResult = yield* tagger.enrich(filePath, content, {
                  basePath: targetDirs[0],
                });
                title = enrichResult.title;
                fileTags = [...fileTags, ...enrichResult.tags];
                yield* Console.log(`    Title: ${enrichResult.title}`);
                if (enrichResult.author) {
                  yield* Console.log(`    Author: ${enrichResult.author}`);
                }
                yield* Console.log(`    Type: ${enrichResult.documentType}`);
                yield* Console.log(
                  `    Tags: ${enrichResult.tags.slice(0, 5).join(", ")}`
                );
                if (enrichResult.concepts && enrichResult.concepts.length > 0) {
                  yield* Console.log(
                    `    Concepts: ${enrichResult.concepts
                      .slice(0, 3)
                      .join(", ")}`
                  );
                }
                // Proposed concepts are now auto-accepted in AutoTagger
                if (
                  enrichResult.proposedConcepts &&
                  enrichResult.proposedConcepts.length > 0
                ) {
                  yield* Console.log(
                    `    Auto-accepted: ${enrichResult.proposedConcepts
                      .map((c) => c.prefLabel)
                      .join(", ")}`
                  );
                }
              } else if (enrich && !content) {
                // Enrichment requested but no content - fall back to heuristics
                yield* Console.log(
                  `    No content extracted, using heuristics`
                );
                const tagResult = yield* tagger.generateTags(
                  filePath,
                  undefined,
                  {
                    heuristicsOnly: true,
                    basePath: targetDirs[0],
                  }
                );
                fileTags = [...fileTags, ...tagResult.allTags];
              } else {
                // Just auto-tag (heuristics + optional LLM)
                const tagResult = yield* tagger.generateTags(
                  filePath,
                  content,
                  {
                    heuristicsOnly: !content,
                    basePath: targetDirs[0],
                  }
                );
                fileTags = [...fileTags, ...tagResult.allTags];
              }
            }

            const doc = yield* library.add(
              filePath,
              new AddOptions({
                title,
                tags: fileTags.length > 0 ? fileTags : undefined,
              })
            );
            yield* Console.log(`  ✓ ${doc.title} (${doc.pageCount} pages)`);
            if (fileTags.length > 0) {
              yield* Console.log(`    Tags: ${doc.tags.join(", ")}`);
            }

            // Checkpoint every N documents to prevent WAL accumulation
            if (shouldCheckpoint(processed, checkpointInterval)) {
              yield* Console.log(
                `  ⚡ Checkpointing WAL (${processed} docs)...`
              );
              const checkpointResult = yield* Effect.either(
                library.checkpoint()
              );
              if (checkpointResult._tag === "Left") {
                yield* Console.log(
                  `  ⚠ Checkpoint warning: ${checkpointResult.left}`
                );
              }
            }
          } catch (error) {
            errors++;
            const msg = error instanceof Error ? error.message : String(error);
            yield* Console.error(`  ✗ Failed: ${msg}`);
          }
        }

        yield* Console.log(`\n✓ Ingested ${processed - errors} files`);
        if (errors > 0) {
          yield* Console.log(`⚠ ${errors} files failed`);
        }

        resultPayload = {
          mode: "simple",
          totalPlanned: files.length,
          skippedExisting,
          processed,
          succeeded: processed - errors,
          failed: errors,
          enrich,
          autoTag,
          manualTags: manualTags ?? null,
        };
      }
      break;
    }

	    case "reindex": {
	      const opts = parseArgs(args.slice(1));
	      const cleanFirst = opts.clean === true;
	      const singleDocId = opts.doc as string | undefined;

      yield* Console.log("Re-indexing embeddings...\n");

      // Get current provider info
      const embedProvider = yield* EmbeddingProvider;
      yield* Console.log(`Provider: ${embedProvider.provider}`);

      // Check health first
	      const healthResult = yield* Effect.either(embedProvider.checkHealth());
	      if (healthResult._tag === "Left") {
	        yield* Console.error(`Embedding provider not ready: ${healthResult.left}`);
	        return yield* Effect.fail(
	          new CLIError("PROVIDER_NOT_READY", "Embedding provider not ready", {
	            reason: String(healthResult.left),
	            provider: embedProvider.provider,
	          })
	        );
	      }

      // Get all documents or single doc
      const docs = singleDocId
        ? yield* library.get(singleDocId).pipe(
            Effect.map((doc) => (doc ? [doc] : []))
          )
        : yield* library.list();

      if (docs.length === 0) {
        yield* Console.log("No documents to reindex");
        break;
      }

      yield* Console.log(`Documents to reindex: ${docs.length}\n`);

      if (cleanFirst) {
        yield* Console.log("Cleaning existing embeddings...");
        // Repair removes orphaned embeddings; we'll regenerate all
        yield* library.repair();
        yield* Console.log("✓ Cleaned\n");
      }

      // Process each document
      let processed = 0;
      let errors = 0;
      let totalChunks = 0;
      let totalEmbeddings = 0;

      for (const doc of docs) {
        processed++;
        yield* Console.log(
          `[${processed}/${docs.length}] ${doc.title}`
        );

        try {
          const result = yield* library.reindexEmbeddings(doc.id);
          totalChunks += result.chunks;
          totalEmbeddings += result.embeddings;
          yield* Console.log(
            `  ✓ Reindexed ${result.embeddings}/${result.chunks} embeddings`,
          );
        } catch (error) {
          errors++;
          const msg = error instanceof Error ? error.message : String(error);
          yield* Console.error(`  ✗ Failed: ${msg}`);
        }
      }

	      yield* Console.log(`\n✓ Reindexed ${processed - errors} documents`);
	      if (errors > 0) {
	        yield* Console.log(`⚠ ${errors} documents failed`);
	      }
      resultPayload = {
	        total: docs.length,
	        succeeded: processed - errors,
	        failed: errors,
          totalChunks,
          totalEmbeddings,
	        cleanFirst,
	        docId: singleDocId ?? null,
	      };
	      agentResult = { _tag: "reindex", count: processed - errors, errors };
	      break;
	    }

      case "rechunk": {
        const opts = parseArgs(args.slice(1));
        const singleDocId = opts.doc as string | undefined;
        const tag = opts.tag as string | undefined;
        const dryRun = opts["dry-run"] === true || opts.dryRun === true;
        const forceAll = opts.all === true;
        const includeMissing =
          opts["include-missing"] === true ||
          opts.includeMissing === true ||
          opts.missing === true;

        const parsePositiveIntFlag = (
          raw: string | boolean | undefined,
          flag: string,
        ): number | undefined => {
          if (raw === undefined) return undefined;
          if (raw === true) {
            throw new CLIError(
              "INVALID_ARGS",
              `${flag} requires a numeric value`,
              { flag, hint: `${flag} 25` },
            );
          }
          const n = Number(raw);
          if (!Number.isFinite(n) || n <= 0) {
            throw new CLIError(
              "INVALID_ARGS",
              `${flag} must be a positive integer`,
              { flag, value: raw, hint: `${flag} 25` },
            );
          }
          return Math.floor(n);
        };

        let parsedMaxDocs: number | undefined = undefined;
        let parsedMaxChunks: number | undefined = undefined;
        try {
          parsedMaxDocs = parsePositiveIntFlag(
            opts["max-docs"] ?? (opts as any).maxDocs,
            "--max-docs",
          );
          parsedMaxChunks = parsePositiveIntFlag(
            opts["max-chunks"] ?? (opts as any).maxChunks,
            "--max-chunks",
          );
        } catch (e) {
          // Avoid throwing inside Effect.gen (becomes a defect / FiberFailure die).
          if (e instanceof CLIError) {
            return yield* Effect.fail(e);
          }
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", String(e), { command: "rechunk" }),
          );
        }

	        const config = LibraryConfig.fromEnv();
	
	        const docs = singleDocId
	          ? yield* library.get(singleDocId).pipe(
	              Effect.map((doc) => (doc ? [doc] : [])),
	            )
          : yield* library.list(tag);

        if (docs.length === 0) {
          resultPayload = {
            dryRun,
            totalCandidates: 0,
            planned: 0,
            succeeded: 0,
            failed: 0,
          };
          break;
        }

        let planned: Array<{
          id: string;
          title: string;
          path: string;
          reason: string;
          code: string;
          expected: unknown;
          actual: unknown;
          currentChunkCount?: number;
        }> = [];

        let plannedMissing = 0;
        let plannedMismatch = 0;
        let skippedMissing = 0;

        for (const doc of docs) {
          const assessment = assessDocChunker(doc, config);
          const isMissing = assessment.code === "missing_metadata";
          const shouldInclude =
            forceAll ||
            (assessment.needsRechunk && (!isMissing || includeMissing));

          if (assessment.needsRechunk && isMissing && !includeMissing && !forceAll) {
            skippedMissing++;
          }

          if (shouldInclude) {
            planned.push({
              id: doc.id,
              title: doc.title,
              path: doc.path,
              reason: assessment.reason,
              code: assessment.code,
              expected: assessment.expected,
              actual: assessment.actual,
            });

            if (assessment.needsRechunk) {
              if (isMissing) plannedMissing++;
              else plannedMismatch++;
            }
          }
        }

        // Enrich plan with cost estimates (current chunk counts).
        let totalCurrentChunks = 0;
        try {
          const counts = yield* library.countChunksByDocumentIds(planned.map((p) => p.id));
          for (const p of planned) {
            const count = counts[p.id] ?? 0;
            p.currentChunkCount = count;
            totalCurrentChunks += count;
          }
        } catch {
          // best-effort; cost estimates are optional
        }

        const warnings: Array<{ code: string; message: string; details?: unknown }> = [];
        if (planned.length > 0) {
          warnings.push({
            code: "RECHUNK_REEMBEDS",
            message:
              "Rechunk regenerates embeddings because embeddings are per-chunk; changing chunk boundaries/content requires new vectors.",
          });
        }
        // NOTE: rechunk uses an atomic DB replace (non-destructive) via PDFLibrary.replace().
        if (includeMissing) {
          warnings.push({
            code: "RECHUNK_INCLUDE_MISSING",
            message:
              "--include-missing is intended for upgrade sweeps. This is typically expensive because it will re-embed many chunks.",
          });
        }
        if (skippedMissing > 0) {
          warnings.push({
            code: "RECHUNK_SKIPPED_MISSING",
            message:
              "Some documents are missing chunker metadata and were skipped. Pass --include-missing to include them.",
            details: { skippedMissing },
          });
        }
        if (totalCurrentChunks > 0) {
          warnings.push({
            code: "RECHUNK_COST_ESTIMATE",
            message:
              "Estimated cost is based on current chunk counts. New chunk counts may differ after rechunking.",
            details: { totalCurrentChunks },
          });
        }

        // Safety rails: rechunking a large library is expensive and potentially slow.
        // If we're including missing-metadata docs (common after upgrades), default to small batches unless
        // the caller explicitly opts into a larger run.
        const effectiveMaxDocs =
          parsedMaxDocs ?? (!dryRun && includeMissing ? 25 : undefined);

        // When --max-docs is explicitly provided, truncate the planned list instead of refusing.
        // The safety guard only triggers for the implicit default (25) when --include-missing is used
        // without an explicit --max-docs flag.
        if (!dryRun && effectiveMaxDocs !== undefined && planned.length > effectiveMaxDocs) {
          if (parsedMaxDocs !== undefined) {
            // Explicit --max-docs: truncate and proceed
            logInfo(`Truncating ${planned.length} candidates to --max-docs ${effectiveMaxDocs}`);
            planned = planned.slice(0, effectiveMaxDocs);
          } else {
            // Implicit default: refuse (safety guard)
            return yield* Effect.fail(
              new CLIError(
                "TOO_MANY_DOCS",
                `Refusing to rechunk ${planned.length} documents (limit: ${effectiveMaxDocs}).`,
                {
                  planned: planned.length,
                  maxDocs: effectiveMaxDocs,
                  hint:
                    includeMissing
                      ? `Re-run with --max-docs ${planned.length} if you really want the full upgrade, or start with: pdf-brain rechunk --include-missing --max-docs 25`
                      : `Re-run with --max-docs ${planned.length} if you really want to process all planned docs.`,
                },
              ),
            );
          }
        }

        if (
          !dryRun &&
          parsedMaxChunks !== undefined &&
          totalCurrentChunks > parsedMaxChunks
        ) {
          return yield* Effect.fail(
            new CLIError(
              "TOO_MANY_CHUNKS",
              `Refusing to rechunk ~${totalCurrentChunks} chunks (limit: ${parsedMaxChunks}).`,
              {
                totalCurrentChunks,
                maxChunks: parsedMaxChunks,
                hint:
                  "Lower scope (use --doc/--tag) or raise the limit (e.g. --max-chunks 200000).",
              },
            ),
          );
        }

	        if (dryRun) {
	          resultPayload = {
	            dryRun: true,
	            forceAll,
              includeMissing,
              maxDocs: parsedMaxDocs ?? null,
              maxChunks: parsedMaxChunks ?? null,
	            tag: tag ?? null,
	            docId: singleDocId ?? null,
	            totalCandidates: docs.length,
	            planned: planned.length,
              plannedMissing,
              plannedMismatch,
              skippedMissing,
              totalCurrentChunks,
              warnings,
	            docs: planned,
	            chunker: {
	              pdf: { id: "pdf-extractor:paragraphs-v2", version: 2 },
	              markdown: { id: "markdown-extractor:sections+placeholders-v1", version: 1 },
	              chunkSize: config.chunkSize,
	              chunkOverlap: config.chunkOverlap,
	              unit: "chars",
	            },
	          };
	          agentResult = {
	            _tag: "rechunk",
	            dryRun: true,
              includeMissing,
              skippedMissing,
              plannedMissing,
              plannedMismatch,
	            planned: planned.length,
	            succeeded: 0,
	            failed: 0,
	          };
	          break;
	        }

	        // Health check: rechunk will re-embed everything, so fail early if provider is down.
	        const embedProvider = yield* EmbeddingProvider;
	        const healthResult = yield* Effect.either(embedProvider.checkHealth());
	        if (healthResult._tag === "Left") {
	          return yield* Effect.fail(
	            new CLIError("PROVIDER_NOT_READY", "Embedding provider not ready", {
	              reason: String(healthResult.left),
	              provider: embedProvider.provider,
	            }),
	          );
	        }
	
	        let processed = 0;
	        let errors = 0;
	        for (const item of planned) {
          processed++;
          try {
            const doc = yield* library.get(item.id);
            if (!doc) {
              errors++;
              continue;
            }

            // Guard: don't delete the DB record if the source file is missing.
            if (!existsSync(doc.path)) {
              errors++;
              continue;
            }

            // Non-destructive: perform an atomic in-place rebuild (doc upsert + chunk/embedding replace).
            const replaceResult = yield* Effect.either(
              library.replace(
                doc.path,
                new AddOptions({
                  title: doc.title,
                  tags: doc.tags.length > 0 ? doc.tags : undefined,
                  metadata: doc.metadata,
                  addedAt: doc.addedAt,
                }),
              ),
            );
            if (replaceResult._tag === "Left") {
              logInfo(`⚠ Rechunk failed for "${doc.title}": ${String(replaceResult.left)}`);
              errors++;
              continue;
            }
          } catch {
            errors++;
          }
        }

	        resultPayload = {
	          dryRun: false,
	          forceAll,
            includeMissing,
            maxDocs: effectiveMaxDocs ?? null,
            maxChunks: parsedMaxChunks ?? null,
	          tag: tag ?? null,
	          docId: singleDocId ?? null,
	          totalCandidates: docs.length,
	          planned: planned.length,
            plannedMissing,
            plannedMismatch,
            skippedMissing,
            totalCurrentChunks,
            warnings,
	          succeeded: processed - errors,
	          failed: errors,
	        };
	        agentResult = {
	          _tag: "rechunk",
	          dryRun: false,
            includeMissing,
            skippedMissing,
            plannedMissing,
            plannedMismatch,
	          planned: planned.length,
	          succeeded: processed - errors,
	          failed: errors,
	        };
	        break;
	      }

    case "queue-ingest": {
      const dir = args[1];
      if (!dir) {
        yield* Console.error("Error: Directory required");
        yield* Console.error("Usage: pdf-brain queue-ingest <dir> [--no-enrich] [--auto-tag]");
        return yield* Effect.fail(
          new CLIError("INVALID_ARGS", "Directory required", { command: "queue-ingest" })
        );
      }

      const opts = parseArgs(args.slice(2));
      const enrich = opts["no-enrich"] !== true;
      const autoTag = opts["auto-tag"] === true;
      const tags = opts.tags
        ? (opts.tags as string).split(",").map((t) => t.trim())
        : undefined;

      yield* Console.log(`Submitting ingest jobs for: ${dir}`);

      const result = yield* Effect.promise(() =>
        submitIngestJobs(dir, { enrich, autoTag, tags }, library)
      );

      yield* Console.log(`\n📋 Queue Summary:`);
      yield* Console.log(`  Total files found: ${result.total}`);
      yield* Console.log(`  Already ingested:  ${result.skipped}`);
      yield* Console.log(`  Jobs submitted:    ${result.submitted}`);

      if (result.submitted > 0) {
        yield* Console.log(`\nStart the worker to process jobs:`);
        yield* Console.log(`  pdf-brain queue-worker`);
      }

      resultPayload = result;
      agentResult = { _tag: "stats", documents: result.submitted, chunks: 0, embeddings: 0 };
      break;
    }

    case "queue-status": {
      const status = yield* Effect.promise(() => getQueueStatus());

      yield* Console.log(`📊 Queue Status (${QUEUE_NAME}):`);
      yield* Console.log(`  Waiting:   ${status.waiting}`);
      yield* Console.log(`  Active:    ${status.active}`);
      yield* Console.log(`  Completed: ${status.completed}`);
      yield* Console.log(`  Failed:    ${status.failed}`);
      yield* Console.log(`  Delayed:   ${status.delayed}`);

      resultPayload = status;
      agentResult = { _tag: "stats", documents: status.completed, chunks: 0, embeddings: 0 };
      break;
    }

    case "queue-worker": {
      yield* Console.log("Starting queue worker...");
      yield* Effect.promise(() => startWorker());
      break;
    }

    default:
      return yield* Effect.fail(
        new CLIError("UNKNOWN_COMMAND", `Unknown command: ${command}`, {
          command,
        })
      );
  }

  const meta = { pdfBrainVersion: VERSION, timingMs: Date.now() - startedAt };

  // Render HATEOAS hints after command output (text) or return structured actions (json)
  let nextActions: NextAction[] | undefined = undefined;
  if (!quiet && agentResult) {
    if (format === "text") {
      const hints = generateHints(agentResult);
      if (hints.length > 0) {
        const statsResult = yield* Effect.either(library.stats());
        const statsData =
          statsResult._tag === "Right"
            ? { documents: statsResult.right.documents }
            : undefined;
        yield* Console.log(formatHintBlock(hints, statsData));
      }
    } else {
      // Avoid importing/using string hints in machine mode; return argv arrays instead.
      // The CLI layer will merge these into the output envelope.
      nextActions = generateNextActions(agentResult);
    }
  }

  // Fallback: if a command didn't set an explicit payload, at least return the agentResult.
  if (resultPayload === null) {
    resultPayload = agentResult;
  }

  return {
    command,
    result: resultPayload,
    agentResult,
    nextActions,
    meta,
  };
});
}

type MCPTransport =
  | StdioServerTransport
  | WebStandardStreamableHTTPServerTransport;

async function connectMcpServer<ROut, E>(
  appLayer: Layer.Layer<ROut, E, never>,
  globals: GlobalCLIOptions,
  transport: MCPTransport,
): Promise<() => Promise<void>> {
  // MCP uses stdout for the JSON-RPC protocol. Do NOT print envelopes or other logs to stdout.
  // Any diagnostics must go to stderr only.

  const NextActionSchema = z.object({
    kind: z.literal("shell"),
    argv: z.array(z.string()),
    description: z.string().optional(),
  });

  // IMPORTANT: The MCP SDK currently normalizes tool output schemas as *objects*.
  // Zod unions can cause output validation to crash (normalizeObjectSchema => undefined).
  // Keep the schema permissive but stable: one object envelope with optional `result` / `error`.
  const EnvelopeSchema = z.object({
    ok: z.boolean(),
    command: z.string(),
    protocolVersion: z.number(),
    result: z.any().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.any().optional(),
      })
      .optional(),
    nextActions: z.array(NextActionSchema).optional(),
    meta: z.record(z.string(), z.any()).optional(),
  });

  const scope = await Effect.runPromise(Scope.make());
  const runtime = await Effect.runPromise(
    Layer.toRuntime(appLayer).pipe(Effect.provideService(Scope.Scope, scope)),
  );

  const coerceCliError = (e: unknown): CLIError => {
    if (e instanceof CLIError) return e;
    const tag =
      e &&
      typeof e === "object" &&
      "_tag" in e &&
      typeof (e as any)._tag === "string"
        ? String((e as any)._tag)
        : "UNKNOWN_ERROR";
    const message = e instanceof Error ? e.message : String(e);
    return new CLIError(tag, message, e);
  };

  const runCommand = async (
    argv: string[],
  ): Promise<z.infer<typeof EnvelopeSchema>> => {
    const cmdGlobals: GlobalCLIOptions = {
      ...globals,
      // MCP tool output is always machine-readable JSON.
      format: "json",
    };

    const outEither: any = await Runtime.runPromise(
      runtime as any,
      makeProgram(argv, cmdGlobals).pipe(Effect.either) as any,
    );

    if (outEither._tag === "Right") {
      const out: any = outEither.right;
      return {
        ok: true,
        command: out.command,
        protocolVersion: PDF_BRAIN_PROTOCOL_VERSION,
        result: out.result,
        nextActions: out.nextActions,
        meta: out.meta ?? { pdfBrainVersion: VERSION },
      };
    }

    const err = coerceCliError(outEither.left);
    return {
      ok: false,
      command: argv[0] ?? "cli",
      protocolVersion: PDF_BRAIN_PROTOCOL_VERSION,
      error: { code: err.code, message: err.message, details: err.details },
      meta: { pdfBrainVersion: VERSION },
    };
  };

  const server = new McpServer({ name: "pdf-brain", version: VERSION });

  const tool = <TInput extends z.ZodTypeAny>(
    name: string,
    config: {
      description: string;
      inputSchema: TInput;
    },
    toArgv: (input: z.infer<TInput>) => string[],
  ) => {
    server.registerTool(
      name,
      {
        description: config.description,
        // The MCP SDK supports both Zod v3 and v4 schema objects, but the type
        // plumbing is gnarly when mixing union output schemas and generic helpers.
        // Cast to keep runtime validation while avoiding TS dead ends.
        inputSchema: config.inputSchema as any,
        outputSchema: EnvelopeSchema as any,
      },
      (async (input: any, _extra: any) => {
        const argv = toArgv(input);
        const envelope = await runCommand(argv);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(envelope),
            },
          ],
          structuredContent: envelope,
        };
      }) as any,
    );
  };

  tool(
    "capabilities",
    {
      description:
        "Describe pdf-brain commands, flags, and schemas (agent discovery entrypoint).",
      inputSchema: z.object({}).optional(),
    },
    () => ["capabilities"],
  );

  tool(
    "stats",
    {
      description: "Library statistics (documents/chunks/embeddings).",
      inputSchema: z.object({}).optional(),
    },
    () => ["stats"],
  );

  tool(
    "search",
    {
      description:
        "Search documents (vector/hybrid/FTS) and optionally concepts. Use docsOnly/conceptsOnly for control.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().positive().optional(),
        tag: z.string().optional(),
        fts: z.boolean().optional(),
        expand: z.number().int().min(0).max(4000).optional(),
        docsOnly: z.boolean().optional(),
        conceptsOnly: z.boolean().optional(),
        includeClusters: z.boolean().optional(),
      }),
    },
    (input) => {
      const argv: string[] = ["search", input.query];
      if (typeof input.limit === "number") argv.push("--limit", String(input.limit));
      if (typeof input.tag === "string" && input.tag.length > 0)
        argv.push("--tag", input.tag);
      if (input.fts === true) argv.push("--fts");
      if (typeof input.expand === "number") argv.push("--expand", String(input.expand));
      if (input.docsOnly === true) argv.push("--docs-only");
      if (input.conceptsOnly === true) argv.push("--concepts-only");
      if (input.includeClusters === true) argv.push("--include-clusters");
      return argv;
    },
  );

  tool(
    "search_pack",
    {
      description:
        "Run multiple searches and aggregate results. Uses progressive disclosure: chunk IDs first, content optional.",
      inputSchema: z.object({
        queries: z.array(z.string()).min(1),
        limit: z.number().int().positive().optional(),
        tag: z.string().optional(),
        fts: z.boolean().optional(),
        expand: z.number().int().min(0).max(4000).optional(),
        withContent: z.boolean().optional(),
        globalLimit: z.number().int().positive().optional(),
      }),
    },
    (input) => {
      const argv: string[] = ["search-pack", ...input.queries];
      if (typeof input.limit === "number") argv.push("--limit", String(input.limit));
      if (typeof input.tag === "string" && input.tag.length > 0)
        argv.push("--tag", input.tag);
      if (input.fts === true) argv.push("--fts");
      if (typeof input.expand === "number") argv.push("--expand", String(input.expand));
      if (input.withContent === true) argv.push("--with-content");
      if (typeof input.globalLimit === "number")
        argv.push("--global-limit", String(input.globalLimit));
      return argv;
    },
  );

  tool(
    "read",
    {
      description: "Read document metadata by id or title.",
      inputSchema: z.object({ idOrTitle: z.string() }),
    },
    (input) => ["read", input.idOrTitle],
  );

  tool(
    "list",
    {
      description: "List documents, optionally filtered by tag.",
      inputSchema: z.object({ tag: z.string().optional() }),
    },
    (input) => {
      const argv: string[] = ["list"];
      if (typeof input.tag === "string" && input.tag.length > 0) {
        argv.push("--tag", input.tag);
      }
      return argv;
    },
  );

  tool(
    "chunk_get",
    {
      description: "Progressive disclosure: fetch a single chunk by chunkId.",
      inputSchema: z.object({ chunkId: z.string() }),
    },
    (input) => ["chunk", "get", input.chunkId],
  );

  tool(
    "doc_chunks",
    {
      description: "Progressive disclosure: list chunk IDs for a document (optionally by page).",
      inputSchema: z.object({
        docId: z.string(),
        page: z.number().int().positive().optional(),
      }),
    },
    (input) => {
      const argv: string[] = ["doc", "chunks", input.docId];
      if (typeof input.page === "number") argv.push("--page", String(input.page));
      return argv;
    },
  );

  tool(
    "page_get",
    {
      description: "Progressive disclosure: reconstruct full page text for a doc/page.",
      inputSchema: z.object({ docId: z.string(), page: z.number().int().positive() }),
    },
    (input) => ["page", "get", input.docId, String(input.page)],
  );

  tool(
    "taxonomy_list",
    {
      description: "List taxonomy concepts (optionally with tree).",
      inputSchema: z.object({ tree: z.boolean().optional() }),
    },
    (input) => {
      const argv: string[] = ["taxonomy", "list"];
      if (input.tree === true) argv.push("--tree");
      return argv;
    },
  );

  tool(
    "taxonomy_tree",
    {
      description: "Render taxonomy hierarchy (full or rooted).",
      inputSchema: z.object({ rootId: z.string().optional() }),
    },
    (input) => {
      const argv: string[] = ["taxonomy", "tree"];
      if (typeof input.rootId === "string" && input.rootId.length > 0) {
        argv.push(input.rootId);
      }
      return argv;
    },
  );

  tool(
    "taxonomy_search",
    {
      description: "Search taxonomy concepts via vector similarity or text fallback.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().positive().optional(),
        threshold: z.number().min(0).max(1).optional(),
      }),
    },
    (input) => {
      const argv: string[] = ["taxonomy", "search", input.query];
      if (typeof input.limit === "number") argv.push("--limit", String(input.limit));
      if (typeof input.threshold === "number") {
        argv.push("--threshold", String(input.threshold));
      }
      return argv;
    },
  );

  tool(
    "doctor",
    {
      description: "Health check and upgrade recommendations.",
      inputSchema: z.object({ fix: z.boolean().optional() }),
    },
    (input) => {
      const argv: string[] = ["doctor"];
      if (input.fix === true) argv.push("--fix");
      return argv;
    },
  );

  tool(
    "rechunk",
    {
      description:
        "Rebuild chunks + embeddings. By default, only docs with mismatched chunker metadata are included; pass includeMissing for legacy docs.",
      inputSchema: z.object({
        docId: z.string().optional(),
        tag: z.string().optional(),
        dryRun: z.boolean().optional(),
        includeMissing: z.boolean().optional(),
        maxDocs: z.number().int().positive().optional(),
        maxChunks: z.number().int().positive().optional(),
        all: z.boolean().optional(),
      }),
    },
    (input) => {
      const argv: string[] = ["rechunk"];
      if (typeof input.docId === "string" && input.docId.length > 0) {
        argv.push("--doc", input.docId);
      }
      if (typeof input.tag === "string" && input.tag.length > 0) {
        argv.push("--tag", input.tag);
      }
      if (input.dryRun === true) argv.push("--dry-run");
      if (input.includeMissing === true) argv.push("--include-missing");
      if (typeof input.maxDocs === "number") argv.push("--max-docs", String(input.maxDocs));
      if (typeof input.maxChunks === "number") argv.push("--max-chunks", String(input.maxChunks));
      if (input.all === true) argv.push("--all");
      return argv;
    },
  );

  await server.connect(transport);

  return async () => {
    try {
      await transport.close();
    } catch {
      // ignore
    }
    try {
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    } catch {
      // ignore
    }
  };
}

async function runServeCommand<ROut, E>(
  appLayer: Layer.Layer<ROut, E, never>,
  globals: GlobalCLIOptions,
  serveArgs: string[],
): Promise<void> {
  const config = loadConfig();
  const overrides = parseServeCommandOptions(serveArgs);
  const serverConfig = resolveServerConfig(config.server, overrides);

  if (serverConfig.auth.enabled && !serverConfig.auth.token) {
    throw new CLIError(
      "INVALID_CONFIG",
      "Auth is enabled but no token is configured. Set config.server.auth.token or pass --auth-token.",
      {
        configPath: resolveConfigPath(),
      },
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const closeMcp = await connectMcpServer(appLayer, globals, transport);

  const listener = Bun.serve({
    hostname: serverConfig.host,
    port: serverConfig.port,
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            ok: true,
            host: serverConfig.host,
            port: serverConfig.port,
            auth: { enabled: serverConfig.auth.enabled },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }

      if (url.pathname !== "/mcp") {
        return new Response("Not Found", { status: 404 });
      }

      if (!isBearerTokenAuthorized(request.headers, serverConfig.auth)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": "Bearer",
          },
        });
      }

      return transport.handleRequest(request);
    },
  });

  console.error(
    `[pdf-brain:serve] listening on http://${serverConfig.host}:${serverConfig.port}/mcp`,
  );
  console.error(
    `[pdf-brain:serve] auth ${
      serverConfig.auth.enabled ? "enabled (bearer token)" : "disabled"
    }`,
  );

  const shutdown = async () => {
    try {
      listener.stop(true);
    } catch {
      // ignore
    }
    await closeMcp();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive until shutdown signal.
  await new Promise(() => {});
}

// ============================================================================
// Graceful Shutdown Handlers
// ============================================================================
// MCP tool invocations are separate processes that may not cleanly close the
// database. Register handlers early to ensure CHECKPOINT runs before exit.

if (import.meta.main) {
  (async () => {
    const rawArgs = process.argv.slice(2);

    let globals: GlobalCLIOptions;
    let args: string[];
    try {
      const parsed = parseGlobalCLIOptions(rawArgs);
      globals = parsed.options;
      args = parsed.args;
    } catch (e) {
      const err =
        e instanceof CLIError
          ? e
          : new CLIError("INVALID_ARGS", String(e), { rawArgs });
      // Default to JSON on parse errors (agent-first).
      writeEnvelope(
        "json",
        {
          ok: false,
          command: "cli",
          protocolVersion: PDF_BRAIN_PROTOCOL_VERSION,
          error: { code: err.code, message: err.message, details: err.details },
          meta: { pdfBrainVersion: VERSION },
        },
        false
      );
      process.exit(1);
      return;
    }

    // stderr-only logging, opt-in.
    setLogLevel(globals.logLevel);

    // Background update checks are disabled by default. If you really want them,
    // set `PDF_BRAIN_BACKGROUND_UPDATE=1`.
    backgroundUpdateCheck(VERSION);

    const command = args[0];

	    // Update is an explicit human-ish command. If you want the full interactive output,
	    // force `--format text`.
	    if (command === "update") {
      if (globals.format !== "text") {
        writeEnvelope(
          globals.format,
          {
            ok: false,
            command: "update",
            protocolVersion: PDF_BRAIN_PROTOCOL_VERSION,
            error: {
              code: "UNSUPPORTED_FORMAT",
              message:
                "update currently requires --format text (prints progress output).",
              details: { hint: "pdf-brain update --format text" },
            },
            nextActions: [
              {
                kind: "shell",
                argv: ["pdf-brain", "update", "--format", "text"],
                description: "Run update with human-readable output",
              },
            ],
            meta: { pdfBrainVersion: VERSION },
          },
          globals.pretty
        );
        process.exit(1);
        return;
      }

      // runUpdate handles its own printing in text mode.
      try {
        await runUpdate(VERSION);
      } catch (err) {
        console.error(`Update failed: ${err}`);
        process.exit(1);
      }
	      return;
	    }

	    // MCP server mode: exposes pdf-brain as an agent tool server (stdio).
	    // IMPORTANT: MCP uses stdout for protocol messages. Do not write envelopes.
	    if (command === "mcp") {
	      const config = LibraryConfig.fromEnv();
	      const TaxonomyServiceLive = TaxonomyServiceImpl.make({
	        url: `file:${config.dbPath}`,
	      });
	
        const pdfLibraryLive = makePDFLibraryLive();
	      const AppLayer = Layer.merge(
	        Layer.merge(Layer.merge(pdfLibraryLive, AutoTaggerLive), PDFExtractorLive),
	        Layer.merge(
	          Layer.merge(TaxonomyServiceLive, EmbeddingProviderFullLive),
	          MigrationLive
	        )
	      );
	
	      try {
	        await runMcpServer(AppLayer, globals);
	      } catch (err) {
	        console.error(`MCP server failed: ${err}`);
	        process.exit(1);
	      }
	      return;
	    }

	    // Build app layer for all commands (including taxonomy/migrate once they move into makeProgram).
	    const config = LibraryConfig.fromEnv();
	    const TaxonomyServiceLive = TaxonomyServiceImpl.make({
	      url: `file:${config.dbPath}`,
	    });

    const pdfLibraryLive = makePDFLibraryLive();
    const AppLayer = Layer.merge(
      Layer.merge(Layer.merge(pdfLibraryLive, AutoTaggerLive), PDFExtractorLive),
      Layer.merge(
        Layer.merge(TaxonomyServiceLive, EmbeddingProviderFullLive),
        MigrationLive
      )
    );

    const toCLIError = (e: unknown): CLIError => {
      if (e instanceof CLIError) return e;
      const tag =
        e && typeof e === "object" && "_tag" in e && typeof (e as any)._tag === "string"
          ? String((e as any)._tag)
          : "UNKNOWN_ERROR";
      const message = e instanceof Error ? e.message : String(e);
      return new CLIError(tag, message, e);
    };

    let outEither: any;

    try {
      outEither = await Effect.runPromise(
        makeProgram(args, globals).pipe(
          Effect.provide(AppLayer),
          Effect.scoped,
          Effect.either
        )
      );
    } catch (e) {
      // Defect / unexpected exception (not an Effect "failure").
      const err = toCLIError(e);
      if (globals.format === "text") {
        try {
          process.stderr.write(`${err.code}: ${err.message}\n`);
        } catch {
          // ignore
        }
        process.exit(1);
        return;
      }

      writeEnvelope(
        globals.format,
        {
          ok: false,
          command: command || "cli",
          protocolVersion: PDF_BRAIN_PROTOCOL_VERSION,
          error: { code: err.code, message: err.message, details: err.details },
          meta: { pdfBrainVersion: VERSION },
        },
        globals.pretty
      );
      process.exit(1);
      return;
    }

    if (outEither._tag === "Right") {
      const out: any = outEither.right;
      if (globals.format !== "text") {
        writeEnvelope(
          globals.format,
          {
            ok: true,
            command: out.command,
            protocolVersion: PDF_BRAIN_PROTOCOL_VERSION,
            result: out.result,
            nextActions: out.nextActions,
            meta: out.meta ?? { pdfBrainVersion: VERSION },
          },
          globals.pretty
        );
      }
      return;
    }

    const err = toCLIError(outEither.left);
    if (globals.format === "text") {
      try {
        process.stderr.write(`${err.code}: ${err.message}\n`);
      } catch {
        // ignore
      }
      process.exit(1);
      return;
    }

    writeEnvelope(
      globals.format,
      {
        ok: false,
        command: command || "cli",
        protocolVersion: PDF_BRAIN_PROTOCOL_VERSION,
        error: { code: err.code, message: err.message, details: err.details },
        meta: { pdfBrainVersion: VERSION },
      },
      globals.pretty
    );
    process.exit(1);
    return;
  })().catch(() => {
    // Last resort.
    process.exit(1);
  });
}
