# pdf-brain

## 1.1.2

### Patch Changes

- Add @electric-sql/pglite as production dependency for migration service

## 1.1.1

### Patch Changes

- Graceful fallback to heuristics when LLM enrichment fails. Now logs the actual error message for debugging instead of silently falling back.

## 1.1.0

### Minor Changes

- dda38aa: Auto-enrich documents by default on add

  - `pdf-brain add` now runs LLM enrichment automatically (title, summary, tags, concepts)
  - Use `--no-enrich` flag to skip enrichment for faster ingestion
  - Enrichment uses configured provider (ollama or gateway) from config

- 1594e16: Add config system with provider/model selection

  - New config file at `$PDF_LIBRARY_PATH/config.json` for persistent settings
  - CLI commands: `config show`, `config get <key>`, `config set <key> <value>`
  - Configurable providers for embedding, enrichment, and judge LLMs
  - Supports `ollama` (local) and `gateway` (AI Gateway) providers
  - Auto-install ollama models when missing (configurable)
  - API keys read from environment variables only (`AI_GATEWAY_API_KEY`)
  - Fixed embedding model to `mxbai-embed-large` (1024 dimensions)

## 1.0.0

### Major Changes

- 777b207: # 🔄 Database Migration: PGLite → libSQL

  **BREAKING CHANGE**: Complete rewrite of the database layer.

  ## What Changed

  Replaced PGLite (WASM Postgres + pgvector) with libSQL for vector storage. This is a **breaking change** - existing PGLite databases are not compatible. Use the migration script to convert your data.

  ## Why

  PGLite with pgvector was causing crashes under heavy embedding load:

  - WASM memory limits (~2GB ceiling)
  - WAL file accumulation (found 2.7GB orphaned files)
  - Required complex daemon/socket architecture to work around single-connection limit
  - ~15MB bundle size for pgvector WASM

  ## Benefits

  - **Native vector support** - libSQL's `F32_BLOB(N)` type, no extensions needed
  - **Rock-solid WAL** - SQLite's battle-tested WAL mode
  - **Simpler architecture** - No daemon, no socket server, no write queue
  - **Smaller bundle** - ~200KB vs ~15MB
  - **Concurrent access** - libSQL handles it natively

  ## Migration

  If you have existing data in PGLite format:

  ```bash
  # Export from old PGLite database
  bun run scripts/migration/pglite-to-libsql.ts

  # Or re-ingest your documents
  pdf-brain ingest ~/your/pdf/directory
  ```

  ## Removed

  - Daemon service (`pdf-brain daemon start/stop/status`)
  - Socket-based database client
  - Write queue architecture
  - PGLite dependencies (@electric-sql/pglite, pglite-socket, pglite-tools)

## 0.9.1

### Patch Changes

- Fix PGlite daemon crash under heavy embedding load

  Adds gated batch processing to prevent WASM OOM when processing many embeddings:

  - Process embeddings in batches of 50 (configurable)
  - CHECKPOINT after each batch to flush WAL
  - Small delay between batches for GC backpressure
  - Adaptive batch sizing under memory pressure

  Root cause: WAL accumulation without checkpoints exceeded WASM's ~2GB memory limit.

## 0.9.0

### Minor Changes

- 2f3eaf0: Bulletproof pdf-brain with TDD hardening across 5 parallel tracks:

  **UTF-8 Sanitization**

  - `sanitizeText()` strips null bytes (0x00) preventing PostgreSQL TEXT column crashes
  - Applied in both PDFExtractor and MarkdownExtractor before chunking

  **Daemon-First Architecture**

  - Daemon auto-starts on first database operation
  - Graceful fallback to direct PGlite if daemon fails to start
  - No more manual `pdf-brain daemon start` required

  **Enhanced Health Checks**

  - `pdf-brain doctor` now checks: WAL files, corrupted directories, daemon status, Ollama connectivity, orphaned data
  - `--fix` flag auto-repairs detected issues
  - Detects PGlite corruption artifacts like "base 2" directories

  **WAL Auto-Checkpoint**

  - Automatic checkpoint every 50 documents during batch ingest (configurable via `--checkpoint-interval`)
  - TUI progress indicator shows checkpoint status
  - Prevents WAL accumulation and WASM OOM crashes

  **Database Integrity & Cleanup**

  - `detectCorruptedDirs()` finds PG directory corruption patterns
  - `repair --deep` removes corrupted filesystem artifacts
  - Safe: never touches valid PostgreSQL directories

## 0.8.0

### Minor Changes

- c16cf50: Add PGlite daemon for multi-process safety

  PGlite is single-connection only - when multiple CLI invocations create their own PGlite instances, they corrupt the database. This adds a lightweight daemon that owns the PGlite connection and exposes it via Unix socket.

  **New Commands:**

  - `pdf-brain daemon start` - Start background daemon process
  - `pdf-brain daemon stop` - Stop daemon gracefully (runs CHECKPOINT first)
  - `pdf-brain daemon status` - Check if daemon is running

  **How it works:**

  - Daemon owns the PGlite instance and exposes it via Unix socket using `@electric-sql/pglite-socket`
  - CLI commands automatically detect if daemon is running
  - When daemon available: connects via socket (multi-process safe)
  - When daemon not running: falls back to direct PGlite (single-process)

  **For MCP usage:** Start the daemon once, then all MCP tool invocations share the same connection safely.

### Patch Changes

- c16cf50: Fix PGlite WAL accumulation causing unrecoverable crash

  **Problem:** PGlite never checkpoints by default, causing WAL files to accumulate indefinitely. After 930 WAL files (930MB), PGlite WASM runs out of memory on init and crashes with `Aborted()`.

  **Fixes:**

  - Add `checkpoint()` method to Database service, called after batch operations
  - Add graceful shutdown handlers (SIGINT/SIGTERM) that run checkpoint before exit
  - Add `pdf-brain doctor` command to check WAL health and warn users
  - Add embedding dimension validation (reject dim 0, mismatched dimensions)
  - Wrap embedding writes in transactions with rollback on failure
  - Add `dumpDataDir()` method for portable database backups
  - Add recovery script for importing from JSON backups

  **New Commands:**

  - `pdf-brain doctor` - Check database health, warn if WAL is accumulating

  **Breaking Changes:** None

## 0.7.0

### Minor Changes

- 1965a71: Add PGlite daemon for multi-process safety

  PGlite is single-connection only - when multiple CLI invocations create their own PGlite instances, they corrupt the database. This adds a lightweight daemon that owns the PGlite connection and exposes it via Unix socket.

  **New Commands:**

  - `pdf-brain daemon start` - Start background daemon process
  - `pdf-brain daemon stop` - Stop daemon gracefully (runs CHECKPOINT first)
  - `pdf-brain daemon status` - Check if daemon is running

  **How it works:**

  - Daemon owns the PGlite instance and exposes it via Unix socket using `@electric-sql/pglite-socket`
  - CLI commands automatically detect if daemon is running
  - When daemon available: connects via socket (multi-process safe)
  - When daemon not running: falls back to direct PGlite (single-process)

  **For MCP usage:** Start the daemon once, then all MCP tool invocations share the same connection safely.

### Patch Changes

- f50421c: Fix PGlite WAL accumulation causing unrecoverable crash

  **Problem:** PGlite never checkpoints by default, causing WAL files to accumulate indefinitely. After 930 WAL files (930MB), PGlite WASM runs out of memory on init and crashes with `Aborted()`.

  **Fixes:**

  - Add `checkpoint()` method to Database service, called after batch operations
  - Add graceful shutdown handlers (SIGINT/SIGTERM) that run checkpoint before exit
  - Add `pdf-brain doctor` command to check WAL health and warn users
  - Add embedding dimension validation (reject dim 0, mismatched dimensions)
  - Wrap embedding writes in transactions with rollback on failure
  - Add `dumpDataDir()` method for portable database backups
  - Add recovery script for importing from JSON backups

  **New Commands:**

  - `pdf-brain doctor` - Check database health, warn if WAL is accumulating

  **Breaking Changes:** None

## 0.6.1

### Patch Changes

- ec1bab7: Update CLI branding and UX improvements

  - Add ascii art banner to help output
  - Add `--version` / `-v` flag
  - Add `read` as alias for `get` command
  - Rename all references from pdf-library to pdf-brain

## 0.6.0

### Minor Changes

- 45bb5b6: Add expanded context feature for search results

  - New `--expand <chars>` flag for CLI search command (max 4000 chars)
  - New `expandChars` option in `SearchOptions` to control context expansion
  - `SearchResult` now includes optional `expandedContent` and `expandedRange` fields
  - Intelligent budget-based expansion that fetches adjacent chunks without blowing context
  - Deduplication of overlapping expansions when multiple results are from same document
