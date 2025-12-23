# pdf-brain

Local **PDF & Markdown** knowledge base with semantic search and AI-powered enrichment.

> **Works with PDFs AND Markdown files** - Index your research papers, books, notes, docs, and any `.md` files in one unified, searchable knowledge base.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  PDF / MD   │────▶│   Ollama    │────▶│   Ollama    │────▶│   libSQL    │
│  (extract)  │     │    (LLM)    │     │ (embeddings)│     │  (vectors)  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │                   │
   pdf-parse         llama3.2:3b        mxbai-embed          HNSW index
   + markdown        enrichment          1024 dims           cosine sim
```

## Features

- **PDF + Markdown** - Index `.pdf` and `.md` files with the same workflow
- **Local-first** - Everything runs on your machine, no API costs
- **AI enrichment** - LLM extracts titles, summaries, tags, and concepts
- **SKOS taxonomy** - Organize documents with hierarchical concepts
- **Vector search** - Semantic search via Ollama embeddings
- **Hybrid search** - Combine vector similarity with full-text search
- **MCP server** - Use with Claude, Cursor, and other AI assistants

## Quick Start

```bash
# 1. Install
npm install -g pdf-brain

# 2. Install Ollama (macOS)
brew install ollama

# 3. Pull required models
ollama pull mxbai-embed-large   # embeddings (required)
ollama pull llama3.2:3b         # enrichment (optional but recommended)

# 4. Start Ollama
ollama serve

# 5. Initialize (creates DB + seeds starter taxonomy)
pdf-brain init

# 6. Add your first document
pdf-brain add ~/Documents/paper.pdf --enrich
```

## Installation

### Prerequisites

**Ollama** is required for embeddings. The LLM model is optional but recommended for enrichment.

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows
# Download from https://ollama.com/download
```

### Models

```bash
# Required: Embedding model (1024 dimensions)
ollama pull mxbai-embed-large

# Recommended: Local LLM for enrichment
ollama pull llama3.2:3b

# Start Ollama server
ollama serve
```

### Install pdf-brain

```bash
# npm
npm install -g pdf-brain

# or run directly
npx pdf-brain <command>
```

## CLI Reference

### Basic Commands

```bash
# Check Ollama status
pdf-brain check

# Show library stats
pdf-brain stats

# Initialize library (creates DB, seeds taxonomy)
pdf-brain init
```

### Adding Documents

```bash
# Add a PDF
pdf-brain add /path/to/document.pdf

# Add a Markdown file
pdf-brain add /path/to/notes.md

# Add from URL (PDF or MD)
pdf-brain add https://example.com/paper.pdf
pdf-brain add https://raw.githubusercontent.com/user/repo/main/README.md

# Add with manual tags
pdf-brain add document.pdf --tags "ai,agents,research"

# Add with AI enrichment (extracts title, summary, concepts)
pdf-brain add document.pdf --enrich
pdf-brain add notes.md --enrich
```

### Searching

```bash
# Semantic search (uses embeddings)
pdf-brain search "context engineering patterns"

# Full-text search only (faster, no embeddings)
pdf-brain search "context engineering" --fts

# Hybrid search (combines both)
pdf-brain search "machine learning" --hybrid

# Limit results
pdf-brain search "query" --limit 5

# Expand context around matches
pdf-brain search "query" --expand 500
```

### Managing Documents

```bash
# List all documents
pdf-brain list

# List by tag
pdf-brain list --tag ai

# Get document details
pdf-brain read "document-title"

# Remove a document
pdf-brain remove "document-title"

# Update tags
pdf-brain tag "document-title" "new,tags,here"
```

### Taxonomy Commands

The taxonomy system uses SKOS (Simple Knowledge Organization System) for hierarchical concept organization.

```bash
# List all concepts
pdf-brain taxonomy list

# Show concept tree
pdf-brain taxonomy tree

# Show subtree from a concept
pdf-brain taxonomy tree programming

# Search concepts
pdf-brain taxonomy search "machine learning"

# Add a new concept
pdf-brain taxonomy add ai/transformers --label "Transformers" --broader ai-ml

# Assign concept to document
pdf-brain taxonomy assign "doc-id" "programming/typescript"

# Seed taxonomy from JSON file
pdf-brain taxonomy seed --file data/taxonomy.json
```

### Bulk Ingest

Recursively ingest directories containing PDFs and/or Markdown files:

```bash
# Ingest a directory with full LLM enrichment
pdf-brain ingest ~/Documents/papers --enrich

# Ingest your Obsidian vault or notes folder
pdf-brain ingest ~/Documents/obsidian --enrich

# Ingest multiple directories (PDFs, Markdown, mixed)
pdf-brain ingest ~/papers ~/books ~/notes --enrich

# With manual tags
pdf-brain ingest ~/books --tags "books,reference"

# Auto-tag only (faster, heuristics + light LLM)
pdf-brain ingest ~/docs --auto-tag

# Process only first N files (for testing)
pdf-brain ingest ~/papers --enrich --sample 10

# Disable TUI for simple output
pdf-brain ingest ~/papers --enrich --no-tui
```

**Supported formats:**

- `.pdf` - Research papers, books, documents
- `.md` - Notes, documentation, Obsidian vaults, READMEs

## Enrichment

When you add documents with `--enrich`, the LLM extracts:

| Field                | Description                                 |
| -------------------- | ------------------------------------------- |
| **title**            | Clean, properly formatted title             |
| **author**           | Author name(s) if detectable                |
| **summary**          | 2-3 sentence summary                        |
| **documentType**     | book, paper, tutorial, guide, article, etc. |
| **category**         | Primary category                            |
| **tags**             | 5-10 descriptive tags                       |
| **concepts**         | Matched concepts from your taxonomy         |
| **proposedConcepts** | New concepts the LLM suggests adding        |

### LLM Providers

Enrichment supports multiple providers via the config system:

```bash
# Check current config
pdf-brain config show

# Use local Ollama (default)
pdf-brain config set enrichment.provider ollama
pdf-brain config set enrichment.model llama3.2:3b

# Use AI Gateway (Anthropic, OpenAI, etc.)
pdf-brain config set enrichment.provider gateway
pdf-brain config set enrichment.model anthropic/claude-haiku-4-5
export AI_GATEWAY_API_KEY=your-key

# Provider priority: config > CLI flag > auto-detect
pdf-brain add paper.pdf --enrich              # uses config
pdf-brain add paper.pdf --enrich --provider ollama  # override
```

### Enrichment Fallback

If LLM enrichment fails (API error, rate limit, malformed response), pdf-brain automatically falls back to heuristic-based enrichment:

- **Title**: Cleaned from filename
- **Tags**: Extracted from path, filename, and content keywords
- **Category**: Inferred from directory structure

The actual error is logged so you can debug provider issues.

## Taxonomy

The taxonomy is a hierarchical concept system for organizing documents. It ships with a starter taxonomy covering:

- **Programming** - TypeScript, React, Next.js, Testing, Architecture, DevOps, AI/ML
- **Education** - Instructional Design, Learning Science, Course Creation, Assessment
- **Business** - Marketing, Copywriting, Bootstrapping, Product, Sales
- **Design** - UX, Visual Design, Systems Thinking, Information Architecture
- **Meta** - Productivity, Note-taking, Knowledge Management, Writing

### Growing Your Taxonomy

When enriching documents, the LLM may propose new concepts. These are saved for review:

```bash
# See proposed concepts from enrichment
pdf-brain taxonomy proposed

# Accept a specific concept
pdf-brain taxonomy accept ai/rag --broader ai-ml

# Accept all proposed concepts
pdf-brain taxonomy accept --all

# Reject a concept
pdf-brain taxonomy reject ai/rag

# Clear all proposals
pdf-brain taxonomy clear-proposed

# Manually add a concept
pdf-brain taxonomy add ai/rag --label "RAG" --broader ai-ml

# Or edit data/taxonomy.json and re-seed
pdf-brain taxonomy seed --file data/taxonomy.json
```

### Custom Taxonomy

Create your own `taxonomy.json`:

```json
{
  "concepts": [
    { "id": "cooking", "prefLabel": "Cooking" },
    { "id": "cooking/baking", "prefLabel": "Baking" },
    { "id": "cooking/grilling", "prefLabel": "Grilling" }
  ],
  "hierarchy": [
    { "conceptId": "cooking/baking", "broaderId": "cooking" },
    { "conceptId": "cooking/grilling", "broaderId": "cooking" }
  ]
}
```

```bash
pdf-brain taxonomy seed --file my-taxonomy.json
```

## Configuration

### Config File

pdf-brain stores configuration in `$PDF_LIBRARY_PATH/config.json`:

```bash
# Show all config
pdf-brain config show

# Get a specific value
pdf-brain config get enrichment.provider

# Set a value
pdf-brain config set enrichment.model anthropic/claude-haiku-4-5
```

### Config Options

```json
{
  "ollama": {
    "host": "http://localhost:11434"
  },
  "embedding": {
    "provider": "ollama",
    "model": "mxbai-embed-large"
  },
  "enrichment": {
    "provider": "gateway",
    "model": "anthropic/claude-haiku-4-5"
  },
  "judge": {
    "provider": "gateway",
    "model": "anthropic/claude-haiku-4-5"
  }
}
```

| Setting               | Default                  | Description                          |
| --------------------- | ------------------------ | ------------------------------------ |
| `ollama.host`         | `http://localhost:11434` | Ollama API endpoint                  |
| `embedding.provider`  | `ollama`                 | Embedding provider (ollama only)     |
| `embedding.model`     | `mxbai-embed-large`      | Embedding model (1024 dims)          |
| `enrichment.provider` | `ollama`                 | LLM provider: `ollama` or `gateway`  |
| `enrichment.model`    | `llama3.2:3b`            | Model for document enrichment        |
| `judge.provider`      | `ollama`                 | Provider for concept deduplication   |
| `judge.model`         | `llama3.2:3b`            | Model for judging duplicate concepts |

### Environment Variables

| Variable             | Default                    | Description              |
| -------------------- | -------------------------- | ------------------------ |
| `PDF_LIBRARY_PATH`   | `~/Documents/.pdf-library` | Library storage location |
| `OLLAMA_HOST`        | `http://localhost:11434`   | Ollama API endpoint      |
| `AI_GATEWAY_API_KEY` | -                          | API key for AI Gateway   |

### AI Gateway

For cloud LLM providers (Anthropic, OpenAI, etc.), use the AI Gateway:

```bash
# Set your API key
export AI_GATEWAY_API_KEY=your-key

# Configure to use gateway
pdf-brain config set enrichment.provider gateway
pdf-brain config set enrichment.model anthropic/claude-haiku-4-5

# Other supported models:
# - anthropic/claude-sonnet-4-20250514
# - openai/gpt-4o-mini
# - openai/gpt-4o
```

## Storage

```
~/Documents/.pdf-library/
├── library.db          # libSQL database (vectors, FTS, metadata, taxonomy)
├── library.db-shm      # Shared memory (WAL mode)
├── library.db-wal      # Write-ahead log
└── downloads/          # PDFs downloaded from URLs
```

### Database Size

The database can get **large** due to vector index overhead. For ~500k chunks:

| Component    | Size   | Notes                             |
| ------------ | ------ | --------------------------------- |
| Text content | ~180MB | Actual chunk text                 |
| Embeddings   | ~1.9GB | 500k × 1024 dims × 4 bytes        |
| Vector index | ~48GB  | HNSW neighbor graphs (~100KB/row) |
| FTS index    | ~200MB | Full-text search                  |

The `*_idx_shadow` tables store HNSW neighbor graphs for approximate nearest neighbor search. Each row averages ~100KB.

**libSQL quirk**: `SELECT COUNT(*) FROM embeddings` returns 0. Always count a specific column:

```sql
SELECT COUNT(chunk_id) FROM embeddings  -- correct
```

## How It Works

1. **Extract** - PDF text via `pdf-parse`, Markdown parsed directly
2. **Enrich** (optional) - LLM extracts metadata, matches taxonomy concepts
3. **Chunk** - Text split into ~512 token chunks with overlap
4. **Embed** - Each chunk embedded via Ollama (1024 dimensions)
5. **Store** - libSQL with vector index (HNSW) + FTS5
6. **Search** - Query embedded, compared via cosine similarity

## MCP Integration

pdf-brain ships as an MCP server for AI coding assistants:

```json
{
  "mcpServers": {
    "pdf-brain": {
      "command": "npx",
      "args": ["pdf-brain", "mcp"]
    }
  }
}
```

### Document Tools

| Tool                  | Description                                   |
| --------------------- | --------------------------------------------- |
| `pdf-brain_add`       | Add PDF/Markdown to library (supports URLs)   |
| `pdf-brain_batch_add` | Bulk ingest from directory                    |
| `pdf-brain_search`    | Unified semantic search (docs + concepts)     |
| `pdf-brain_list`      | List documents, optionally filter by tag      |
| `pdf-brain_read`      | Get document details and metadata             |
| `pdf-brain_remove`    | Remove document from library                  |
| `pdf-brain_tag`       | Set tags on a document                        |
| `pdf-brain_stats`     | Library statistics (docs, chunks, embeddings) |

### Taxonomy Tools

| Tool                        | Description                              |
| --------------------------- | ---------------------------------------- |
| `pdf-brain_taxonomy_list`   | List all concepts (optional tree format) |
| `pdf-brain_taxonomy_tree`   | Visual concept tree with box-drawing     |
| `pdf-brain_taxonomy_add`    | Add new concept to taxonomy              |
| `pdf-brain_taxonomy_assign` | Assign concept to document               |
| `pdf-brain_taxonomy_search` | Search concepts by label                 |
| `pdf-brain_taxonomy_seed`   | Load taxonomy from JSON file             |

### Config Tools

| Tool                    | Description               |
| ----------------------- | ------------------------- |
| `pdf-brain_config_show` | Display all config        |
| `pdf-brain_config_get`  | Get specific config value |
| `pdf-brain_config_set`  | Set config value          |

### Utility Tools

| Tool               | Description                   |
| ------------------ | ----------------------------- |
| `pdf-brain_check`  | Check if Ollama is ready      |
| `pdf-brain_repair` | Fix database integrity issues |

## Troubleshooting

### "Ollama not available"

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# Start Ollama
ollama serve

# Check models
ollama list
```

### "Model not found"

```bash
# Pull required models
ollama pull mxbai-embed-large
ollama pull llama3.2:3b
```

### "Database locked"

The database uses WAL mode. If you see lock errors:

```bash
# Check for zombie processes
lsof ~/Documents/.pdf-library/library.db*

# Force checkpoint
sqlite3 ~/Documents/.pdf-library/library.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

### Slow enrichment

Enrichment is CPU-intensive. For large batches:

- Use `--auto-tag` instead of `--enrich` for faster processing
- Run overnight for large libraries
- Consider GPU acceleration for Ollama

## Development

```bash
# Clone
git clone https://github.com/joelhooks/pdf-brain
cd pdf-brain

# Install
bun install

# Run CLI
bun run src/cli.ts <command>

# Run tests
bun test

# Type check
bun run typecheck
```

## License

MIT
