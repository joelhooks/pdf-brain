# pdf-brain

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
