---
"pdf-brain": minor
---

Add PGlite daemon for multi-process safety

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
