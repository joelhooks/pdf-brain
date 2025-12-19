---
"pdf-brain": minor
---

Bulletproof pdf-brain with TDD hardening across 5 parallel tracks:

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
