#!/usr/bin/env bun
/**
 * PDF Brain CLI
 */

import { Effect, Console } from "effect";
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  startDaemon,
  stopDaemon,
  isDaemonRunning,
  DaemonConfig,
} from "./services/Daemon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
);
const VERSION = pkg.version;
import {
  PDFLibrary,
  PDFLibraryLive,
  SearchOptions,
  AddOptions,
  LibraryConfig,
  URLFetchError,
} from "./index.js";
import { Migration, MigrationLive } from "./services/Migration.js";

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

const HELP = `
                 ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
                 ┃                                                ┃
    ██████╗      ┃   Local knowledge base with vector search      ┃
    ██╔══██╗     ┃   ─────────────────────────────────────────    ┃
    ██████╔╝     ┃   PDFs & Markdown → Chunks → Embeddings        ┃
    ██╔═══╝      ┃   Powered by PGlite + pgvector + Ollama        ┃
    ██║          ┃                                                ┃
    ╚═╝  BRAIN   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Usage:
  pdf-brain <command> [options]

Commands:
  add <path|url>          Add a PDF or Markdown file (local path or URL)
    --title <title>       Custom title (default: filename or frontmatter)
    --tags <tags>         Comma-separated tags

  search <query>          Semantic search across all documents
    --limit <n>           Max results (default: 10)
    --tag <tag>           Filter by tag
    --fts                 Full-text search only (skip embeddings)
    --expand <chars>      Expand context around matches (max: 4000)
                          Returns surrounding chunks up to char budget

  list                    List all documents in the library
    --tag <tag>           Filter by tag

  read <id|title>         Get document details and metadata

  remove <id|title>       Remove a document from the library

  tag <id|title> <tags>   Set tags on a document

  stats                   Show library statistics
                          Documents, chunks, embeddings count

  check                   Verify Ollama is running and model available

  doctor                  Check WAL health and database status
                           Warns if WAL files accumulate excessively

  repair                  Fix database integrity issues
                           Removes orphaned chunks/embeddings

  daemon start            Start background daemon process
  daemon stop             Stop daemon gracefully
  daemon status           Show daemon running status

  export                  Export library for backup or sharing
    --output <path>       Output file (default: ./pdf-brain-export.tar.gz)

  import <file>           Import library from export archive
    --force               Overwrite existing library

  migrate                 Database migration utilities
    --check               Check if migration is needed
    --import <file>       Import from SQL dump
    --generate-script     Generate export script for current DB

Options:
  --help, -h              Show this help
  --version, -v           Show version

Examples:
  pdf-brain add ./book.pdf --tags "programming,rust"
  pdf-brain add ./notes.md --tags "docs,api"
  pdf-brain add https://example.com/paper.pdf --title "Research Paper"
  pdf-brain search "machine learning" --limit 5
  pdf-brain search "error handling" --expand 2000
  pdf-brain stats
`;

function parseArgs(args: string[]) {
  const result: Record<string, string | boolean> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
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

const program = Effect.gen(function* () {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    yield* Console.log(HELP);
    return;
  }

  if (args.includes("--version") || args.includes("-v")) {
    yield* Console.log(`pdf-brain v${VERSION}`);
    return;
  }

  const command = args[0];
  const library = yield* PDFLibrary;

  switch (command) {
    case "add": {
      const pathOrUrl = args[1];
      if (!pathOrUrl) {
        yield* Console.error("Error: Path or URL required");
        process.exit(1);
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
      const doc = yield* library.add(
        localPath,
        new AddOptions({ title, tags })
      );
      yield* Console.log(`✓ Added: ${doc.title}`);
      yield* Console.log(`  ID: ${doc.id}`);
      yield* Console.log(`  Pages: ${doc.pageCount}`);
      yield* Console.log(
        `  Size: ${(doc.sizeBytes / 1024 / 1024).toFixed(2)} MB`
      );
      if (doc.tags.length) yield* Console.log(`  Tags: ${doc.tags.join(", ")}`);
      break;
    }

    case "search": {
      const query = args[1];
      if (!query) {
        yield* Console.error("Error: Query required");
        process.exit(1);
      }

      const opts = parseArgs(args.slice(2));
      const limit = opts.limit ? parseInt(opts.limit as string, 10) : 10;
      const tags = opts.tag ? [opts.tag as string] : undefined;
      const ftsOnly = opts.fts === true;
      const expandChars = opts.expand
        ? Math.min(4000, Math.max(0, parseInt(opts.expand as string, 10)))
        : 0;

      yield* Console.log(
        `Searching: "${query}"${ftsOnly ? " (FTS only)" : ""}${
          expandChars > 0 ? ` (expand: ${expandChars} chars)` : ""
        }\n`
      );

      const results = ftsOnly
        ? yield* library.ftsSearch(query, new SearchOptions({ limit, tags }))
        : yield* library.search(
            query,
            new SearchOptions({ limit, tags, hybrid: true, expandChars })
          );

      if (results.length === 0) {
        yield* Console.log("No results found");
      } else {
        for (const r of results) {
          yield* Console.log(
            `[${r.score.toFixed(3)}] ${r.title} (p.${r.page})`
          );

          if (r.expandedContent && expandChars > 0) {
            // Show expanded content with range info
            const rangeInfo = r.expandedRange
              ? ` [chunks ${r.expandedRange.start}-${r.expandedRange.end}]`
              : "";
            yield* Console.log(`  --- Expanded context${rangeInfo} ---`);
            yield* Console.log(`  ${r.expandedContent.replace(/\n/g, "\n  ")}`);
            yield* Console.log(`  --- End context ---`);
          } else {
            // Default: truncated snippet
            yield* Console.log(
              `  ${r.content.slice(0, 200).replace(/\n/g, " ")}...`
            );
          }
          yield* Console.log("");
        }
      }
      break;
    }

    case "list": {
      const opts = parseArgs(args.slice(1));
      const tag = opts.tag as string | undefined;

      const docs = yield* library.list(tag);

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
      break;
    }

    case "read":
    case "get": {
      const id = args[1];
      if (!id) {
        yield* Console.error("Error: ID or title required");
        process.exit(1);
      }

      const doc = yield* library.get(id);
      if (!doc) {
        yield* Console.error(`Not found: ${id}`);
        process.exit(1);
      }

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
      break;
    }

    case "remove": {
      const id = args[1];
      if (!id) {
        yield* Console.error("Error: ID or title required");
        process.exit(1);
      }

      const doc = yield* library.remove(id);
      yield* Console.log(`✓ Removed: ${doc.title}`);
      break;
    }

    case "tag": {
      const id = args[1];
      const tags = args[2];
      if (!id || !tags) {
        yield* Console.error("Error: ID and tags required");
        process.exit(1);
      }

      const tagList = tags.split(",").map((t) => t.trim());
      const doc = yield* library.tag(id, tagList);
      yield* Console.log(
        `✓ Updated tags for "${doc.title}": ${tagList.join(", ")}`
      );
      break;
    }

    case "stats": {
      const stats = yield* library.stats();
      yield* Console.log(`PDF Library Stats`);
      yield* Console.log(`─────────────────`);
      yield* Console.log(`Documents:  ${stats.documents}`);
      yield* Console.log(`Chunks:     ${stats.chunks}`);
      yield* Console.log(`Embeddings: ${stats.embeddings}`);
      yield* Console.log(`Location:   ${stats.libraryPath}`);
      break;
    }

    case "doctor": {
      const config = LibraryConfig.fromEnv();
      const walPath = join(config.libraryPath, "library", "pg_wal");

      yield* Console.log("Checking database health...\n");

      // Check if WAL directory exists
      if (!existsSync(walPath)) {
        yield* Console.log(
          "✓ WAL directory not found (database not initialized yet)"
        );
        break;
      }

      // Count WAL files and total size
      const walFiles = readdirSync(walPath).filter(
        (f) => !f.startsWith(".") // Ignore hidden files
      );
      const totalSizeBytes = walFiles.reduce((sum, file) => {
        const filePath = join(walPath, file);
        try {
          return sum + statSync(filePath).size;
        } catch {
          return sum; // Skip files we can't read
        }
      }, 0);

      const health = assessWALHealth({
        fileCount: walFiles.length,
        totalSizeBytes,
      });

      // Display stats
      const sizeMB = (totalSizeBytes / (1024 * 1024)).toFixed(1);
      yield* Console.log(`WAL Statistics:`);
      yield* Console.log(`  Files:  ${walFiles.length}`);
      yield* Console.log(`  Size:   ${sizeMB} MB`);
      yield* Console.log(`  Path:   ${walPath}\n`);

      if (health.healthy) {
        yield* Console.log("✓ Database health is good");
      } else {
        yield* Console.log("⚠ Database health warnings:");
        for (const warning of health.warnings) {
          yield* Console.log(`  • ${warning}`);
        }
        yield* Console.log("\nRecommendations:");
        yield* Console.log(
          "  1. Run CHECKPOINT manually via your database connection"
        );
        yield* Console.log(
          "  2. Consider export/import to compact the database:"
        );
        yield* Console.log("     pdf-brain export --output backup.tar.gz");
        yield* Console.log("     pdf-brain import backup.tar.gz --force");
      }
      break;
    }

    case "check": {
      yield* library.checkReady();
      yield* Console.log("✓ Ollama is ready");
      break;
    }

    case "repair": {
      yield* Console.log("Checking database integrity...\n");
      const result = yield* library.repair();

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
        process.exit(1);
      }

      // Get file size
      const fileSize = Bun.file(outputPath).size;
      const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

      yield* Console.log(`\n✓ Exported to ${outputPath} (${sizeMB} MB)`);
      yield* Console.log(`\nTo import on another machine:`);
      yield* Console.log(`  pdf-brain import ${basename(outputPath)}`);
      break;
    }

    case "import": {
      const importFile = args[1];
      if (!importFile) {
        yield* Console.error("Error: Import file required");
        yield* Console.error("Usage: pdf-brain import <file.tar.gz> [--force]");
        process.exit(1);
      }

      if (!existsSync(importFile)) {
        yield* Console.error(`Error: File not found: ${importFile}`);
        process.exit(1);
      }

      const opts = parseArgs(args.slice(2));
      const config = LibraryConfig.fromEnv();
      const libraryDir = join(config.libraryPath, "library");

      // Check if library already exists
      if (existsSync(libraryDir) && !opts.force) {
        yield* Console.error(`Error: Library already exists at ${libraryDir}`);
        yield* Console.error("Use --force to overwrite");
        process.exit(1);
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
          process.exit(1);
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
        process.exit(1);
      }

      yield* Console.log(`\n✓ Library imported successfully`);
      yield* Console.log(`\nRun 'pdf-brain stats' to verify`);
      break;
    }

    default:
      yield* Console.error(`Unknown command: ${command}`);
      yield* Console.log(HELP);
      process.exit(1);
  }
});

// ============================================================================
// Graceful Shutdown Handlers
// ============================================================================
// MCP tool invocations are separate processes that may not cleanly close the
// database. Register handlers early to ensure CHECKPOINT runs before exit.

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return; // Prevent duplicate shutdowns
  isShuttingDown = true;

  console.error(`\n${signal} received, shutting down gracefully...`);

  try {
    // Import here to avoid circular dependencies
    const { Database, DatabaseLive } = await import("./services/Database.js");
    const { LibraryConfig } = await import("./types.js");

    const config = LibraryConfig.fromEnv();
    const dbDir = config.dbPath.replace(".db", "");

    // Only run checkpoint if database exists
    const { existsSync } = await import("fs");
    if (existsSync(dbDir)) {
      console.error("Running CHECKPOINT...");

      const checkpointEffect = Effect.gen(function* () {
        const db = yield* Database;
        yield* db.checkpoint();
      });

      await Effect.runPromise(
        checkpointEffect.pipe(Effect.provide(DatabaseLive), Effect.scoped)
      );
      console.error("✓ CHECKPOINT complete");
    }
  } catch (error) {
    console.error(`Warning: Shutdown checkpoint failed: ${error}`);
    // Don't block exit on checkpoint failure
  }

  process.exit(0);
}

// Register signal handlers
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Handle daemon and migrate commands separately (don't need full PDFLibrary)
const args = process.argv.slice(2);

if (args[0] === "daemon") {
  const subcommand = args[1];
  const config = LibraryConfig.fromEnv();
  const daemonConfig: DaemonConfig = {
    socketPath: config.libraryPath, // Directory for socket file
    pidPath: join(config.libraryPath, "daemon.pid"),
    dbPath: config.dbPath,
  };

  const daemonProgram = Effect.gen(function* () {
    switch (subcommand) {
      case "start": {
        // Check if already running
        const running = yield* Effect.promise(() =>
          isDaemonRunning(daemonConfig)
        );

        if (running) {
          yield* Console.log("✓ Daemon is already running");
          break;
        }

        // Check for --foreground flag
        const opts = parseArgs(args.slice(2));
        if (opts.foreground) {
          // Run daemon in foreground (called by detached spawn)
          yield* Console.log("Starting daemon in foreground...");
          yield* Console.log(
            `  Socket: ${daemonConfig.socketPath}/.s.PGSQL.5432`
          );
          yield* Console.log(`  PID: ${process.pid}`);
          yield* Effect.promise(() => startDaemon(daemonConfig));

          // Keep process alive - daemon handles shutdown via signals
          yield* Effect.promise(() => new Promise(() => {}));
        } else {
          // Spawn background process
          yield* Console.log("Starting daemon...");

          const proc = Bun.spawn(
            [
              "bun",
              "run",
              join(__dirname, "cli.ts"),
              "daemon",
              "start",
              "--foreground",
            ],
            {
              cwd: process.cwd(),
              stdio: ["ignore", "ignore", "ignore"],
              detached: true,
            }
          );
          proc.unref();

          // Wait for socket to be available (max 5 seconds)
          const startTime = Date.now();
          const timeout = 5000;
          while (Date.now() - startTime < timeout) {
            const running = yield* Effect.promise(() =>
              isDaemonRunning(daemonConfig)
            );
            if (running) {
              yield* Console.log("✓ Daemon started successfully");
              yield* Console.log(
                `  Socket: ${daemonConfig.socketPath}/.s.PGSQL.5432`
              );
              break;
            }
            // Wait 100ms before checking again
            yield* Effect.sleep("100 millis");
          }

          const finalCheck = yield* Effect.promise(() =>
            isDaemonRunning(daemonConfig)
          );
          if (!finalCheck) {
            yield* Console.error("⚠ Daemon may have failed to start");
            yield* Console.error("  Check logs for details");
            process.exit(1);
          }
        }
        break;
      }

      case "stop": {
        const running = yield* Effect.promise(() =>
          isDaemonRunning(daemonConfig)
        );

        if (!running) {
          yield* Console.log("Daemon is not running");
          break;
        }

        yield* Console.log("Stopping daemon...");
        yield* Effect.promise(() => stopDaemon(daemonConfig));
        yield* Console.log("✓ Daemon stopped");
        break;
      }

      case "status": {
        const running = yield* Effect.promise(() =>
          isDaemonRunning(daemonConfig)
        );

        if (running) {
          yield* Console.log("✓ Daemon is running");
          yield* Console.log(
            `  Socket: ${daemonConfig.socketPath}/.s.PGSQL.5432`
          );
          yield* Console.log(`  PID file: ${daemonConfig.pidPath}`);
        } else {
          yield* Console.log("Daemon is not running");
        }
        break;
      }

      default: {
        yield* Console.error(
          `Unknown daemon subcommand: ${subcommand || "(none)"}`
        );
        yield* Console.log(`
Usage: pdf-brain daemon <subcommand>

Subcommands:
  start    Start the daemon in background
  stop     Stop the daemon gracefully
  status   Show daemon status

The daemon solves PGlite's single-connection limitation by running
a background process that owns the database and exposes it via Unix socket.
        `);
        process.exit(1);
      }
    }
  });

  Effect.runPromise(
    daemonProgram.pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Console.error(`Daemon Error: ${JSON.stringify(error)}`);
          process.exit(1);
        })
      )
    )
  );
} else if (args[0] === "migrate") {
  const migrateProgram = Effect.gen(function* () {
    const opts = parseArgs(args.slice(1));
    const migration = yield* Migration;
    const config = LibraryConfig.fromEnv();
    const dbPath = config.dbPath.replace(".db", "");

    if (opts.check) {
      const needed = yield* migration.checkMigrationNeeded(dbPath);
      if (needed) {
        yield* Console.log(
          "Migration needed:\n" + migration.getMigrationMessage()
        );
      } else {
        yield* Console.log("✓ No migration needed - database is compatible");
      }
    } else if (opts.import) {
      yield* migration.importFromDump(opts.import as string, dbPath);
      yield* Console.log("✓ Import complete");
    } else if (opts["generate-script"]) {
      yield* Console.log(migration.generateExportScript(dbPath));
    } else {
      // Default: check and show message
      const needed = yield* migration.checkMigrationNeeded(dbPath);
      if (needed) {
        yield* Console.log(migration.getMigrationMessage());
      } else {
        yield* Console.log("✓ No migration needed - database is compatible");
      }
    }
  });

  Effect.runPromise(
    migrateProgram.pipe(
      Effect.provide(MigrationLive),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          if (error._tag === "MigrationError") {
            yield* Console.error(`Migration Error: ${error.message}`);
          } else {
            yield* Console.error(
              `Error: ${error._tag}: ${JSON.stringify(error)}`
            );
          }
          process.exit(1);
        })
      )
    )
  );
} else {
  // Run with error handling
  Effect.runPromise(
    program.pipe(
      Effect.provide(PDFLibraryLive),
      Effect.scoped,
      Effect.catchAll((error: unknown) =>
        Effect.gen(function* () {
          const errorObj = error as { _tag?: string };
          const errorStr = JSON.stringify(error);
          // Check if it's a database initialization error
          if (
            errorStr.includes("PGlite") ||
            errorStr.includes("version") ||
            errorStr.includes("incompatible")
          ) {
            yield* Console.error(
              `Database Error: ${errorObj._tag || "Unknown"}: ${errorStr}`
            );
            yield* Console.error(
              "\nThis may be a database version compatibility issue."
            );
            yield* Console.error(
              "Run 'pdf-brain migrate --check' to diagnose."
            );
          } else {
            yield* Console.error(
              `Error: ${errorObj._tag || "Unknown"}: ${errorStr}`
            );
          }
          process.exit(1);
        })
      )
    )
  );
}
