# pdf-brain Agent Notes

## libSQL Quirks

**COUNT(\*) returns 0 for vector tables** - libSQL's vector extension has a quirk where `SELECT COUNT(*) FROM embeddings` returns 0. Always count a specific column instead:

```sql
-- WRONG: returns 0
SELECT COUNT(*) FROM embeddings

-- CORRECT: returns actual count
SELECT COUNT(chunk_id) FROM embeddings
```

**Vector index shadow tables are MASSIVE** - The `*_idx_shadow` tables store neighbor graphs for HNSW search. Each row averages ~100KB. For 500k embeddings, expect ~48GB just for the index.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    DB SIZE BREAKDOWN (500k chunks)                  │
├─────────────────────────────────────────────────────────────────────┤
│  embeddings_idx_shadow    ~48GB (92%)  - HNSW neighbor graphs       │
│  embeddings               ~1.9GB (4%)  - 500k × 1024 dims × 4 bytes │
│  chunks                   ~180MB (<1%) - actual text content        │
│  chunks_fts               ~200MB       - full-text search index     │
└─────────────────────────────────────────────────────────────────────┘
```

**Potential optimizations:**

- Use `compress_neighbors=float8` in index (already enabled)
- Consider smaller embedding models (384 dims vs 1024)
- Batch similar documents to reduce total chunks
- Use partial indexing (only index recent/important docs)

## AI SDK Pattern

Use the simple model string pattern with Vercel AI Gateway:

```typescript
import { generateObject } from "ai";
import { z } from "zod";

const { object } = await generateObject({
  model: "anthropic/claude-haiku-4-5",
  schema: MyZodSchema,
  prompt: "...",
});
```

No provider setup needed - uses `AI_GATEWAY_API_KEY` env var automatically.

## Key Files

- `src/services/LibSQLDatabase.ts` - Database layer with Effect
- `src/services/AutoTagger.ts` - LLM enrichment logic
- `src/services/TaxonomyService.ts` - SKOS concept management
- `src/cli.ts` - CLI commands
- `data/taxonomy.json` - Starter taxonomy seed data
