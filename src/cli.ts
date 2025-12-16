#!/usr/bin/env bun
/**
 * PDF Library CLI
 */

import { Effect, Console } from "effect";
import { mkdirSync, existsSync } from "fs";
import { basename, join } from "path";
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
function filenameFromURL(url: string): string {
  const urlObj = new URL(url);
  const pathname = urlObj.pathname;
  const filename = basename(pathname);
  // If already has .pdf, .md, or .markdown extension, keep it
  if (filename.endsWith(".pdf") || filename.endsWith(".md") || filename.endsWith(".markdown")) {
    return filename;
  }
  // Otherwise, try to infer from URL
  // GitHub raw URLs often have .md in path
  if (pathname.includes(".md")) {
    return `${filename}.md`;
  }
  // Default to .pdf for backwards compatibility
  return `${filename}.pdf`;
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
      const isPDF = contentType.includes("pdf") || url.endsWith(".pdf");
      const isMarkdown = 
        contentType.includes("text/markdown") || 
        contentType.includes("text/plain") || 
        contentType.includes("text/x-markdown") ||
        url.endsWith(".md") || 
        url.endsWith(".markdown");
      
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
pdf-library - Local PDF and Markdown knowledge base with vector search

Usage:
  pdf-library <command> [options]

Commands:
  add <path|url>          Add a PDF or Markdown file to the library (supports URLs)
    --title <title>       Custom title (default: filename)
    --tags <tags>         Comma-separated tags

  search <query>          Semantic search across all documents
    --limit <n>           Max results (default: 10)
    --tag <tag>           Filter by tag
    --fts                 Full-text search only (no embeddings)

  list                    List all documents
    --tag <tag>           Filter by tag

  get <id|title>          Get document details

  remove <id|title>       Remove a document

  tag <id|title> <tags>   Set tags on a document

  stats                   Show library statistics

  check                   Check if Ollama is ready

  repair                  Fix database integrity issues
                          Removes orphaned chunks/embeddings

  export                  Export library database for sharing
    --output <path>       Output file (default: ./pdf-library-export.tar.gz)

  import <file>           Import library database from export
    --force               Overwrite existing library

  migrate                 Database migration utilities
    --check               Check if migration is needed
    --import <file>       Import from SQL dump file
    --generate-script     Generate export script for current database

Options:
  --help, -h              Show this help

Examples:
  pdf-library add ./book.pdf --tags "programming,rust"
  pdf-library add ./notes.md --tags "documentation,api"
  pdf-library add https://example.com/paper.pdf --title "Research Paper"
  pdf-library add https://raw.githubusercontent.com/user/repo/main/README.md
  pdf-library search "machine learning" --limit 5
  pdf-library migrate --check
  pdf-library migrate --import backup.sql
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
        new AddOptions({ title, tags }),
      );
      yield* Console.log(`✓ Added: ${doc.title}`);
      yield* Console.log(`  ID: ${doc.id}`);
      yield* Console.log(`  Pages: ${doc.pageCount}`);
      yield* Console.log(
        `  Size: ${(doc.sizeBytes / 1024 / 1024).toFixed(2)} MB`,
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

      yield* Console.log(
        `Searching: "${query}"${ftsOnly ? " (FTS only)" : ""}\n`,
      );

      const results = ftsOnly
        ? yield* library.ftsSearch(query, new SearchOptions({ limit, tags }))
        : yield* library.search(
            query,
            new SearchOptions({ limit, tags, hybrid: true }),
          );

      if (results.length === 0) {
        yield* Console.log("No results found");
      } else {
        for (const r of results) {
          yield* Console.log(
            `[${r.score.toFixed(3)}] ${r.title} (p.${r.page})`,
          );
          yield* Console.log(
            `  ${r.content.slice(0, 200).replace(/\n/g, " ")}...`,
          );
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
          tag ? `No documents with tag "${tag}"` : "Library is empty",
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
        `Size: ${(doc.sizeBytes / 1024 / 1024).toFixed(2)} MB`,
      );
      yield* Console.log(`Added: ${doc.addedAt}`);
      yield* Console.log(
        `Tags: ${doc.tags.length ? doc.tags.join(", ") : "(none)"}`,
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
        `✓ Updated tags for "${doc.title}": ${tagList.join(", ")}`,
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
            `  • Removed ${result.orphanedChunks} orphaned chunks`,
          );
        }
        if (result.orphanedEmbeddings > 0) {
          yield* Console.log(
            `  • Removed ${result.orphanedEmbeddings} orphaned embeddings`,
          );
        }
        if (result.zeroVectorEmbeddings > 0) {
          yield* Console.log(
            `  • Removed ${result.zeroVectorEmbeddings} zero-dimension embeddings`,
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
        join(process.cwd(), "pdf-library-export.tar.gz");

      yield* Console.log(`Exporting library database...`);
      yield* Console.log(`  Source: ${config.libraryPath}/library`);
      yield* Console.log(`  Output: ${outputPath}`);

      // Get stats first
      const stats = yield* library.stats();
      yield* Console.log(
        `  Contents: ${stats.documents} docs, ${stats.chunks} chunks, ${stats.embeddings} embeddings`,
      );

      // Use tar to create archive
      const tarResult = Bun.spawnSync(
        ["tar", "-czf", outputPath, "-C", config.libraryPath, "library"],
        { stdout: "pipe", stderr: "pipe" },
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
        { stdout: "pipe", stderr: "pipe" },
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

// Handle migrate command separately (doesn't need full PDFLibrary)
const args = process.argv.slice(2);

if (args[0] === "migrate") {
  const migrateProgram = Effect.gen(function* () {
    const opts = parseArgs(args.slice(1));
    const migration = yield* Migration;
    const config = LibraryConfig.fromEnv();
    const dbPath = config.dbPath.replace(".db", "");

    if (opts.check) {
      const needed = yield* migration.checkMigrationNeeded(dbPath);
      if (needed) {
        yield* Console.log(
          "Migration needed:\n" + migration.getMigrationMessage(),
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
              `Error: ${error._tag}: ${JSON.stringify(error)}`,
            );
          }
          process.exit(1);
        }),
      ),
    ),
  );
} else {
  // Run with error handling
  Effect.runPromise(
    program.pipe(
      Effect.provide(PDFLibraryLive),
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
              `Database Error: ${errorObj._tag || "Unknown"}: ${errorStr}`,
            );
            yield* Console.error(
              "\nThis may be a database version compatibility issue.",
            );
            yield* Console.error(
              "Run 'pdf-library migrate --check' to diagnose.",
            );
          } else {
            yield* Console.error(
              `Error: ${errorObj._tag || "Unknown"}: ${errorStr}`,
            );
          }
          process.exit(1);
        }),
      ),
    ),
  );
}
