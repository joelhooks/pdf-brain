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
  // If no .pdf extension, add it
  return filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
}

/**
 * Download a PDF from URL to local path
 */
function downloadPDF(url: string, destPath: string) {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("pdf") && !url.endsWith(".pdf")) {
        throw new Error(`Not a PDF: content-type is ${contentType}`);
      }
      const buffer = await response.arrayBuffer();
      await Bun.write(destPath, buffer);
      return destPath;
    },
    catch: (e) => new URLFetchError({ url, reason: String(e) }),
  });
}

const HELP = `
pdf-library - Local PDF knowledge base with vector search

Usage:
  pdf-library <command> [options]

Commands:
  add <path|url>          Add a PDF to the library (supports URLs)
    --title <title>       Custom title (default: filename)
    --tags <tags>         Comma-separated tags

  search <query>          Semantic search across all PDFs
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

  migrate                 Database migration utilities
    --check               Check if migration is needed
    --import <file>       Import from SQL dump file
    --generate-script     Generate export script for current database

Options:
  --help, -h              Show this help

Examples:
  pdf-library add ./book.pdf --tags "programming,rust"
  pdf-library add https://example.com/paper.pdf --title "Research Paper"
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
          title = basename(filename, ".pdf");
        }

        yield* Console.log(`Downloading: ${pathOrUrl}`);
        yield* downloadPDF(pathOrUrl, localPath);
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
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          // Check if it's a database initialization error
          const errorStr = JSON.stringify(error);
          if (
            errorStr.includes("PGlite") ||
            errorStr.includes("version") ||
            errorStr.includes("incompatible")
          ) {
            yield* Console.error(
              `Database Error: ${error._tag}: ${JSON.stringify(error)}`,
            );
            yield* Console.error(
              "\nThis may be a database version compatibility issue.",
            );
            yield* Console.error(
              "Run 'pdf-library migrate --check' to diagnose.",
            );
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
}
