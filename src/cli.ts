#!/usr/bin/env bun
/**
 * PDF Brain CLI
 */

import { Effect, Console, Layer } from "effect";
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
import {
  AutoTagger,
  AutoTaggerLive,
  type EnrichmentResult,
} from "./services/AutoTagger.js";
import { PDFExtractor, PDFExtractorLive } from "./services/PDFExtractor.js";

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
import { Config, loadConfig, saveConfig } from "./types.js";
import { Migration, MigrationLive } from "./services/Migration.js";
import {
  TaxonomyService,
  TaxonomyServiceImpl,
  type TaxonomyJSON,
  type Concept,
} from "./services/TaxonomyService.js";
import { Ollama, OllamaLive } from "./services/Ollama.js";

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
}): DoctorHealthResult {
  const checks: HealthCheck[] = [];

  // WAL health check
  checks.push({
    name: "WAL Files",
    healthy: data.walHealth.healthy,
    details:
      data.walHealth.warnings.length > 0
        ? data.walHealth.warnings.join("; ")
        : undefined,
  });

  // Corrupted directories check
  checks.push({
    name: "Corrupted Directories",
    healthy: data.corruptedDirs.healthy,
    details:
      data.corruptedDirs.issues.length > 0
        ? `Found: ${data.corruptedDirs.issues.join(", ")}`
        : undefined,
  });

  // Ollama check
  checks.push({
    name: "Ollama",
    healthy: data.ollamaReachable,
    details: data.ollamaReachable ? undefined : "Unreachable",
  });

  // Orphaned data check
  const hasOrphans =
    data.orphanedData.chunks > 0 || data.orphanedData.embeddings > 0;
  checks.push({
    name: "Orphaned Data",
    healthy: !hasOrphans,
    details: hasOrphans
      ? `${data.orphanedData.chunks} chunks, ${data.orphanedData.embeddings} embeddings`
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

const HELP = `
                 ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
                 ┃                                                ┃
    ██████╗      ┃   Local knowledge base with vector search      ┃
    ██╔══██╗     ┃   ─────────────────────────────────────────    ┃
    ██████╔╝     ┃   PDFs & Markdown → Chunks → Embeddings        ┃
    ██╔═══╝      ┃   Powered by LibSQL + Ollama                   ┃
    ██║          ┃                                                ┃
    ╚═╝  BRAIN   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Usage:
  pdf-brain <command> [options]

Commands:
  add <path|url>          Add a PDF or Markdown file (local path or URL)
    --title <title>       Custom title (default: filename or frontmatter)
    --tags <tags>         Comma-separated tags
    --no-enrich           Skip LLM enrichment (title/summary/tags extraction)

  search <query>          Unified search across documents and concepts
    --limit <n>           Max results (default: 10)
    --tag <tag>           Filter documents by tag
    --fts                 Full-text search only (skip embeddings)
    --expand <chars>      Expand context around matches (max: 4000)
                          Returns surrounding chunks up to char budget
    --concepts-only       Search only taxonomy concepts
    --docs-only           Search only documents (skip concepts)
    --include-clusters    Multi-scale retrieval with cluster summaries

  list                    List all documents in the library
    --tag <tag>           Filter by tag

  read <id|title>         Get document details and metadata

  remove <id|title>       Remove a document from the library

  tag <id|title> <tags>   Set tags on a document

  stats                   Show library statistics
                          Documents, chunks, embeddings count

  config show             Display all configuration settings
  config get <path>       Get specific config value (e.g. embedding.model)
  config set <path> <val> Set specific config value

  check                   Verify Ollama is running and model available

  doctor                  Comprehensive health check (WAL, corrupted dirs, Ollama, orphaned data)
    --fix                 Auto-repair detected issues

  repair                  Fix database integrity issues
                           Removes orphaned chunks/embeddings

  ingest <directory>      Batch ingest PDFs/Markdown from directory
    --recursive           Include subdirectories (default: true)
    --tags <tags>         Apply tags to all ingested files
    --auto-tag            Auto-generate tags using LLM (local first)
    --enrich              Full enrichment: title, summary, tags (slower)
    --sample <n>          Process only first N files (for testing)
    --checkpoint-interval <n>  Checkpoint every N docs (default: 50)
    --no-tui              Disable TUI, use simple progress output

  export                  Export library for backup or sharing
    --output <path>       Output file (default: ./pdf-brain-export.tar.gz)

  import <file>           Import library from export archive
    --force               Overwrite existing library

  migrate                 Database migration utilities
    --check               Check if migration is needed
    --import <file>       Import from SQL dump
    --generate-script     Generate export script for current DB

  taxonomy list           List all concepts
    --tree                Show hierarchy tree
    --format <fmt>        Output format: json|table (default: table)

  taxonomy tree [id]      Show visual concept tree (box-drawing)
                          If id provided, shows subtree from that concept

  taxonomy add <id>       Add a new concept
    --label <label>       Preferred label (required)
    --broader <parent>    Parent concept ID
    --definition <text>   Concept definition

  taxonomy assign <doc-id> <concept-id>
                          Assign concept to document
    --confidence <0-1>    Confidence score (default: 1.0)

  taxonomy search <query> Find concepts by label/altLabel

  taxonomy seed           Load taxonomy from JSON file
    --file <path>         JSON file path (default: data/taxonomy.json)

Options:
  --help, -h              Show this help
  --version, -v           Show version

Examples:
  pdf-brain add ./book.pdf --tags "programming,rust"
  pdf-brain add ./notes.md --tags "docs,api"
  pdf-brain add https://example.com/paper.pdf --title "Research Paper"
  pdf-brain search "machine learning" --limit 5
  pdf-brain search "error handling" --expand 2000
  pdf-brain search "design patterns" --concepts-only  # Search concepts only
  pdf-brain search "react hooks" --docs-only          # Search documents only
  pdf-brain stats
  pdf-brain ingest ~/Documents/books --tags "books"
  pdf-brain ingest ./papers --auto-tag --sample 5
  pdf-brain ingest ./books --enrich  # Full metadata extraction
`;

export function parseArgs(args: string[]) {
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

      yield* Console.log(
        `Searching: "${query}"${ftsOnly ? " (FTS only)" : ""}${modeLabel}${
          expandChars > 0 ? ` (expand: ${expandChars} chars)` : ""
        }\n`
      );

      // Search concepts first (if enabled)
      if (searchConcepts) {
        const taxonomy = yield* TaxonomyService;
        const ollamaService = yield* Ollama;

        // Try vector search on concepts using Ollama embeddings
        const conceptResults = yield* Effect.gen(function* () {
          const healthCheck = yield* Effect.either(ollamaService.checkHealth());
          if (healthCheck._tag === "Right") {
            const queryEmbedding = yield* ollamaService.embed(query);
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

        if (conceptResults.length > 0) {
          yield* Console.log(`📚 Concepts (${conceptResults.length}):\n`);
          for (const c of conceptResults) {
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

        if (results.length > 0) {
          if (searchConcepts) {
            yield* Console.log(`📄 Documents (${results.length}):\n`);
          }
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
              yield* Console.log(
                `  ${r.expandedContent.replace(/\n/g, "\n  ")}`
              );
              yield* Console.log(`  --- End context ---`);
            } else {
              // Default: truncated snippet
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

      // If no results at all
      if (conceptsOnly) {
        // Already handled above
      } else if (docsOnly) {
        // Already handled above
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

    case "config": {
      const subcommand = args[1];
      const config = loadConfig();
      const libraryPath =
        process.env.PDF_LIBRARY_PATH ||
        `${process.env.HOME}/Documents/.pdf-library`;
      const configPath = `${libraryPath}/config.json`;

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
        yield* Console.log(
          `Note: API keys read from env vars (AI_GATEWAY_API_KEY)`
        );
      } else if (subcommand === "get") {
        const path = args[2];
        if (!path) {
          yield* Console.error("Error: Path required");
          yield* Console.error("Usage: pdf-brain config get <path>");
          yield* Console.error("Example: pdf-brain config get embedding.model");
          process.exit(1);
        }

        // Navigate config object by path (e.g., "embedding.model")
        const parts = path.split(".");
        let value: any = config;
        for (const part of parts) {
          if (value && typeof value === "object" && part in value) {
            value = (value as any)[part];
          } else {
            yield* Console.error(`Config path not found: ${path}`);
            process.exit(1);
          }
        }

        yield* Console.log(
          typeof value === "object" ? JSON.stringify(value) : String(value)
        );
      } else if (subcommand === "set") {
        const path = args[2];
        const newValue = args[3];

        if (!path || newValue === undefined) {
          yield* Console.error("Error: Path and value required");
          yield* Console.error("Usage: pdf-brain config set <path> <value>");
          yield* Console.error(
            "Example: pdf-brain config set embedding.model nomic-embed-text"
          );
          process.exit(1);
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
            process.exit(1);
          }
        }

        const lastPart = parts[parts.length - 1];
        if (target && typeof target === "object" && lastPart in target) {
          // Type coercion: boolean or string
          const oldValue = (target as any)[lastPart];
          let parsedValue: any = newValue;

          if (typeof oldValue === "boolean") {
            parsedValue = newValue === "true" || newValue === "1";
          } else if (typeof oldValue === "number") {
            parsedValue = parseFloat(newValue);
          }

          (target as any)[lastPart] = parsedValue;
          saveConfig(config);
          yield* Console.log(`✓ Updated ${path}: ${parsedValue}`);
        } else {
          yield* Console.error(`Config path not found: ${path}`);
          process.exit(1);
        }
      } else {
        yield* Console.error(`Unknown config subcommand: ${subcommand}`);
        yield* Console.error("Available: show, get, set");
        process.exit(1);
      }
      break;
    }

    case "doctor": {
      const opts = parseArgs(args.slice(1));
      const shouldFix = opts.fix === true;
      const config = LibraryConfig.fromEnv();
      const libraryPath = join(config.libraryPath, "library");
      const walPath = join(libraryPath, "pg_wal");

      yield* Console.log("🔍 Checking database health...\n");

      // Check if library directory exists
      if (!existsSync(libraryPath)) {
        yield* Console.log("✓ Library not initialized yet (nothing to check)");
        break;
      }

      // 1. Check WAL files
      let walHealth: WALHealthResult;
      if (existsSync(walPath)) {
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

        walHealth = assessWALHealth({
          fileCount: walFiles.length,
          totalSizeBytes,
        });
      } else {
        walHealth = { healthy: true, warnings: [] };
      }

      // 2. Check for corrupted directories
      const libraryDirs = existsSync(libraryPath)
        ? readdirSync(libraryPath)
        : [];
      const corruptedDirs = checkCorruptedDirs(libraryPath, libraryDirs);

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

      // Assess overall health
      const doctorHealth = assessDoctorHealth({
        walHealth,
        corruptedDirs,
        ollamaReachable,
        orphanedData,
      });

      // Display results
      yield* Console.log("📊 Health Check Results:\n");
      for (const check of doctorHealth.checks) {
        const icon = check.healthy ? "✓" : "✗";
        const status = check.healthy ? "healthy" : "ISSUE";
        yield* Console.log(`${icon} ${check.name}: ${status}`);
        if (check.details) {
          yield* Console.log(`  ${check.details}`);
        }
      }

      yield* Console.log("");

      if (doctorHealth.healthy) {
        yield* Console.log("✅ All checks passed! Database is healthy.");
      } else {
        yield* Console.log("⚠️  Issues detected.\n");

        // Auto-fix if requested
        if (shouldFix) {
          yield* Console.log("🔧 Attempting auto-repair...\n");

          // Fix corrupted directories
          if (!corruptedDirs.healthy) {
            for (const dir of corruptedDirs.issues) {
              const dirPath = join(libraryPath, dir);
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

          yield* Console.log(
            "\n  Run 'pdf-brain doctor --fix' to auto-repair issues."
          );
        }
      }
      break;
    }

    case "check": {
      yield* library.checkReady();
      yield* Console.log("✓ Ollama is ready");
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
        process.exit(1);
      }

      // Resolve and validate directories
      const targetDirs: string[] = [];
      for (const dir of directories) {
        const targetDir = dir.startsWith("/") ? dir : join(process.cwd(), dir);
        if (!existsSync(targetDir)) {
          yield* Console.error(`Error: Directory not found: ${targetDir}`);
          process.exit(1);
        }
        const dirStat = statSync(targetDir);
        if (!dirStat.isDirectory()) {
          yield* Console.error(`Error: Not a directory: ${targetDir}`);
          process.exit(1);
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
      const useTui = opts["no-tui"] !== true;
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

      if (newFiles.length < files.length) {
        yield* Console.log(
          `Skipping ${files.length - newFiles.length} already-ingested files`
        );
      }

      if (newFiles.length === 0) {
        yield* Console.log("All files already ingested");
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
      }
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
  // libSQL auto-syncs on close, no explicit checkpoint needed
  process.exit(0);
}

// Register signal handlers
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Handle taxonomy command separately (don't need full PDFLibrary)
const args = process.argv.slice(2);

if (args[0] === "taxonomy") {
  const taxonomyProgram = Effect.gen(function* () {
    const subcommand = args[1];
    const opts = parseArgs(args.slice(2));
    const config = LibraryConfig.fromEnv();
    const taxonomy = yield* TaxonomyService;

    switch (subcommand) {
      case "list": {
        const concepts = yield* taxonomy.listConcepts();

        const formatOpt = (opts.format as string) || "table";

        if (formatOpt === "json") {
          yield* Console.log(JSON.stringify(concepts, null, 2));
        } else if (opts.tree) {
          // Tree view
          const trees = yield* Effect.promise(() =>
            buildTreeStructure(taxonomy)
          );
          if (trees.length === 0) {
            yield* Console.log("No concepts found");
          } else {
            for (const tree of trees) {
              const lines = renderConceptTree(tree, "", true);
              for (const line of lines) {
                yield* Console.log(line);
              }
            }
          }
        } else {
          // Table view
          if (concepts.length === 0) {
            yield* Console.log("No concepts found");
          } else {
            yield* Console.log(`Concepts: ${concepts.length}\n`);
            for (const concept of concepts) {
              yield* Console.log(`• ${concept.prefLabel} (${concept.id})`);
              if (concept.definition) {
                yield* Console.log(`  ${concept.definition}`);
              }
            }
          }
        }
        break;
      }

      case "tree": {
        const conceptId = args[2];
        const trees = yield* Effect.promise(() =>
          buildTreeStructure(taxonomy, conceptId)
        );

        if (trees.length === 0) {
          yield* Console.log(
            conceptId ? `Concept not found: ${conceptId}` : "No concepts found"
          );
        } else {
          for (const tree of trees) {
            const lines = renderConceptTree(tree, "", true);
            for (const line of lines) {
              yield* Console.log(line);
            }
          }
        }
        break;
      }

      case "add": {
        const id = args[2];
        const label = opts.label as string | undefined;

        if (!id || !label) {
          yield* Console.error("Error: ID and --label required");
          yield* Console.error(
            "Usage: pdf-brain taxonomy add <id> --label <label> [--broader <parent>] [--definition <text>]"
          );
          process.exit(1);
        }

        const altLabels: string[] = [];
        const definition = opts.definition as string | undefined;

        yield* taxonomy.addConcept({
          id,
          prefLabel: label,
          altLabels,
          definition,
        });

        if (opts.broader) {
          yield* taxonomy.addBroader(id, opts.broader as string);
        }

        yield* Console.log(`✓ Added concept: ${label} (${id})`);
        if (opts.broader) {
          yield* Console.log(`  Parent: ${opts.broader}`);
        }
        break;
      }

      case "assign": {
        const docId = args[2];
        const conceptId = args[3];

        if (!docId || !conceptId) {
          yield* Console.error("Error: Document ID and Concept ID required");
          yield* Console.error(
            "Usage: pdf-brain taxonomy assign <doc-id> <concept-id> [--confidence 0.9]"
          );
          process.exit(1);
        }

        const confidence = opts.confidence
          ? parseFloat(opts.confidence as string)
          : 1.0;

        yield* taxonomy.assignToDocument(
          docId,
          conceptId,
          confidence,
          "manual"
        );
        yield* Console.log(
          `✓ Assigned concept ${conceptId} to document ${docId}`
        );
        if (confidence !== 1.0) {
          yield* Console.log(`  Confidence: ${confidence}`);
        }
        break;
      }

      case "search": {
        const query = args[2];
        if (!query) {
          yield* Console.error("Error: Query required");
          yield* Console.error("Usage: pdf-brain taxonomy search <query>");
          process.exit(1);
        }

        const concepts = yield* taxonomy.listConcepts();
        const queryLower = query.toLowerCase();

        const matches = concepts.filter(
          (c) =>
            c.prefLabel.toLowerCase().includes(queryLower) ||
            c.altLabels.some((alt) => alt.toLowerCase().includes(queryLower))
        );

        if (matches.length === 0) {
          yield* Console.log(`No concepts matching "${query}"`);
        } else {
          yield* Console.log(`Found ${matches.length} matches:\n`);
          for (const concept of matches) {
            yield* Console.log(`• ${concept.prefLabel} (${concept.id})`);
            if (concept.definition) {
              yield* Console.log(`  ${concept.definition}`);
            }
          }
        }
        break;
      }

      case "seed": {
        const filePath = (opts.file as string) || "data/taxonomy.json";

        if (!existsSync(filePath)) {
          yield* Console.error(`Error: File not found: ${filePath}`);
          process.exit(1);
        }

        const fileContent = readFileSync(filePath, "utf-8");
        const taxonomyData = JSON.parse(fileContent) as TaxonomyJSON;

        yield* taxonomy.seedFromJSON(taxonomyData);

        const conceptCount = taxonomyData.concepts.length;
        const hierarchyCount = taxonomyData.hierarchy?.length || 0;
        const relationsCount = taxonomyData.relations?.length || 0;

        yield* Console.log(`✓ Loaded taxonomy from ${filePath}`);
        yield* Console.log(`  Concepts: ${conceptCount}`);
        if (hierarchyCount > 0) {
          yield* Console.log(`  Hierarchy relations: ${hierarchyCount}`);
        }
        if (relationsCount > 0) {
          yield* Console.log(`  Related relations: ${relationsCount}`);
        }
        break;
      }

      default:
        yield* Console.error(`Unknown taxonomy subcommand: ${subcommand}`);
        yield* Console.error(
          "Run 'pdf-brain --help' to see available commands"
        );
        process.exit(1);
    }
  });

  // Create TaxonomyService layer with same DB as PDFLibrary
  const config = LibraryConfig.fromEnv();
  const TaxonomyServiceLive = TaxonomyServiceImpl.make({
    url: `file:${config.dbPath}`,
  });

  Effect.runPromise(
    taxonomyProgram.pipe(
      Effect.provide(TaxonomyServiceLive),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          if (error._tag === "TaxonomyError") {
            yield* Console.error(`Taxonomy Error: ${error.reason}`);
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
  // AutoTagger now requires TaxonomyService and Ollama for auto-accept
  const config = LibraryConfig.fromEnv();
  const TaxonomyServiceLive = TaxonomyServiceImpl.make({
    url: `file:${config.dbPath}`,
  });

  const AppLayer = Layer.merge(
    Layer.merge(Layer.merge(PDFLibraryLive, AutoTaggerLive), PDFExtractorLive),
    Layer.merge(TaxonomyServiceLive, OllamaLive)
  );

  Effect.runPromise(
    program.pipe(
      Effect.provide(AppLayer),
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
