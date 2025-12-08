# 📄 pdf-brain

Local PDF knowledge base with vector search. Extract, embed, and semantically search your PDFs.

## Install

```bash
npm install pdf-brain

# Need Ollama for embeddings
brew install ollama
ollama pull mxbai-embed-large
```

## CLI

```bash
# Add a PDF
npx pdf-brain add /path/to/document.pdf

# Add from URL
npx pdf-brain add https://example.com/paper.pdf

# Add with tags
npx pdf-brain add /path/to/document.pdf --tags "ai,agents"

# Semantic search
npx pdf-brain search "context engineering patterns"

# Full-text search (no embeddings)
npx pdf-brain search "context engineering" --fts

# List all documents
npx pdf-brain list

# List by tag
npx pdf-brain list --tag ai

# Get document details
npx pdf-brain get "document-title"

# Remove a document
npx pdf-brain remove "document-title"

# Update tags
npx pdf-brain tag "document-title" "new,tags,here"

# Show stats
npx pdf-brain stats

# Check Ollama status
npx pdf-brain check
```

## Features

- **Local-first** - Everything runs on your machine, no API costs
- **Vector search** - Semantic search via Ollama embeddings (mxbai-embed-large)
- **Hybrid search** - Combine vector similarity with full-text search
- **iCloud sync** - Default storage in `~/Documents/.pdf-library/`
- **PGlite + pgvector** - Real Postgres vector search, no server needed

## OpenCode Integration

Drop this in `~/.config/opencode/tool/pdf-brain.ts`:

```typescript
import { tool } from "@opencode-ai/plugin";
import { $ } from "bun";

async function run(args: string[]): Promise<string> {
  const result = await $`npx pdf-brain ${args}`.text();
  return result.trim();
}

export const add = tool({
  description: "Add a PDF to the library",
  args: {
    path: tool.schema.string().describe("Path to PDF file or URL"),
    tags: tool.schema.string().optional().describe("Comma-separated tags"),
  },
  async execute({ path, tags }) {
    const args = ["add", path];
    if (tags) args.push("--tags", tags);
    return run(args);
  },
});

export const search = tool({
  description: "Semantic search across all PDFs",
  args: {
    query: tool.schema.string().describe("Natural language search query"),
    limit: tool.schema.number().optional().describe("Max results"),
    fts: tool.schema.boolean().optional().describe("Full-text search only"),
  },
  async execute({ query, limit, fts }) {
    const args = ["search", query];
    if (limit) args.push("--limit", String(limit));
    if (fts) args.push("--fts");
    return run(args);
  },
});

export const list = tool({
  description: "List all PDFs in the library",
  args: { tag: tool.schema.string().optional() },
  async execute({ tag }) {
    const args = ["list"];
    if (tag) args.push("--tag", tag);
    return run(args);
  },
});

export const stats = tool({
  description: "Show library statistics",
  args: {},
  async execute() {
    return run(["stats"]);
  },
});
```

## Configuration

| Variable           | Default                    | Description              |
| ------------------ | -------------------------- | ------------------------ |
| `PDF_LIBRARY_PATH` | `~/Documents/.pdf-library` | Library storage location |
| `OLLAMA_HOST`      | `http://localhost:11434`   | Ollama API endpoint      |
| `OLLAMA_MODEL`     | `mxbai-embed-large`        | Embedding model          |

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│    PDF      │────▶│   Ollama    │────▶│   PGlite    │
│  (extract)  │     │ (embeddings)│     │ (pgvector)  │
└─────────────┘     └─────────────┘     └─────────────┘
      │                    │                   │
   pypdf              mxbai-embed         HNSW index
   chunks              1024 dims          cosine sim
```

1. **Extract** - PDF text extracted via `pypdf`
2. **Chunk** - Text split into ~512 token chunks with overlap
3. **Embed** - Each chunk embedded via Ollama (1024 dimensions)
4. **Store** - PGlite + pgvector with HNSW index + FTS
5. **Search** - Query embedded, compared via cosine similarity

## Storage

```
~/Documents/.pdf-library/
├── library.db          # PGlite database (vectors, FTS, metadata)
└── downloads/          # PDFs downloaded from URLs
```

## License

MIT
