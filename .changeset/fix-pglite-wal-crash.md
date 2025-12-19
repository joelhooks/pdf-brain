---
"pdf-brain": patch
---

Fix PGlite WAL accumulation causing unrecoverable crash

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
