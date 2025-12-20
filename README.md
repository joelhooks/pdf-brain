# pdf-brain

Local PDF & Markdown knowledge base with semantic search and AI-powered enrichment.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   PDF/MD    │────▶│   Ollama    │────▶│   Ollama    │────▶│   libSQL    │
│  (extract)  │     │    (LLM)    │     │ (embeddings)│     │  (vectors)  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │                   │
   pdf-parse         llama3.2:3b        mxbai-embed          HNSW index
   markdown          enrichment          1024 dims           cosine sim
```

## Features

- **Local-first** - Everything runs on your machine, no API costs
- **AI enrichment** - LLM extracts titles, summaries, tags, and concepts
- **SKOS taxonomy** - Organize documents with hierarchical concepts
- **Vector search** - Semantic search via Ollama embeddings
- **Hybrid search** - Combine vector similarity with full-text search
- **Markdown support** - Index `.md` files alongside PDFs

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

# Add from URL
pdf-brain add https://example.com/paper.pdf

# Add with manual tags
pdf-brain add document.pdf --tags "ai,agents,research"

# Add with AI enrichment (extracts title, summary, concepts)
pdf-brain add document.pdf --enrich

# Add Markdown file
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

```bash
# Ingest a directory with full LLM enrichment
pdf-brain ingest ~/Documents/papers --enrich

# Ingest multiple directories
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

Enrichment tries local Ollama first, falls back to Anthropic if configured:

```bash
# Uses Ollama by default (llama3.2:3b)
pdf-brain add paper.pdf --enrich

# Set Anthropic API key for fallback
export ANTHROPIC_API_KEY=sk-ant-...
```

## Taxonomy

The taxonomy is a hierarchical concept system for organizing documents. It ships with a starter taxonomy covering:

- **Programming** - TypeScript, React, Next.js, Testing, Architecture, DevOps, AI/ML
- **Education** - Instructional Design, Learning Science, Course Creation, Assessment
- **Business** - Marketing, Copywriting, Bootstrapping, Product, Sales
- **Design** - UX, Visual Design, Systems Thinking, Information Architecture
- **Meta** - Productivity, Note-taking, Knowledge Management, Writing

### Growing Your Taxonomy

When enriching documents, the LLM may propose new concepts. These are logged but not automatically added. To review and add them:

```bash
# See proposed concepts from recent ingests
pdf-brain taxonomy proposed

# Add a proposed concept
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

| Variable            | Default                    | Description              |
| ------------------- | -------------------------- | ------------------------ |
| `PDF_LIBRARY_PATH`  | `~/Documents/.pdf-library` | Library storage location |
| `OLLAMA_HOST`       | `http://localhost:11434`   | Ollama API endpoint      |
| `OLLAMA_MODEL`      | `mxbai-embed-large`        | Embedding model          |
| `ANTHROPIC_API_KEY` | -                          | Fallback for enrichment  |

## Storage

```
~/Documents/.pdf-library/
├── library.db          # libSQL database (vectors, FTS, metadata, taxonomy)
├── library.db-shm      # Shared memory (WAL mode)
├── library.db-wal      # Write-ahead log
└── downloads/          # PDFs downloaded from URLs
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

Tools exposed:

- `pdf-brain_add` - Add document to library
- `pdf-brain_search` - Semantic search
- `pdf-brain_list` - List documents
- `pdf-brain_read` - Get document details
- `pdf-brain_stats` - Library statistics

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
