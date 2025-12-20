# Partial Index Strategy for Tag Filtering

## Executive Summary

This document outlines a strategy for using libSQL partial indexes to optimize vector search filtered by tags. Based on analysis of 168 documents with 309 unique tags, we've identified 6 high-usage tags that warrant dedicated partial indexes to improve query performance.

**Key Findings:**

- **100% of documents** have 2+ tags (strong co-occurrence pattern)
- **6 tags** appear in ≥20% of documents (high-usage candidates for partial indexes)
- **80 tags** appear in 1-5% of documents (medium-usage, consider selective indexing)
- **214 tags** appear in <1% of documents (rare, skip indexing)

**Recommendation:**
Create partial indexes for the **6 high-usage tags** initially. Monitor query patterns and expand to medium-usage tags if needed.

---

## Tag Distribution Analysis

### Database Statistics

- **Total Documents:** 168
- **Unique Tags:** 309
- **Documents with no tags:** 0 (0.0%)
- **Documents with 2+ tags:** 168 (100.0%)

### Tag Usage Patterns

#### High Usage (≥20% of documents) - **6 tags**

These are prime candidates for partial indexes:

| Tag          | Document Count | Percentage |
| ------------ | -------------- | ---------- |
| books        | 133            | 79.2%      |
| joel         | 132            | 78.6%      |
| 03-resources | 132            | 78.6%      |
| business     | 115            | 68.5%      |
| copywriting  | 43             | 25.6%      |
| hackers      | 35             | 20.8%      |

#### Medium Usage (5-20% of documents) - **9 tags**

Consider for future indexing if query patterns warrant:

| Tag                           | Document Count | Percentage |
| ----------------------------- | -------------- | ---------- |
| just-fucking-ship             | 21             | 12.5%      |
| software-development          | 15             | 8.9%       |
| copy-hackers-worksheets       | 14             | 8.3%       |
| copy-hackers-worksheets-2     | 14             | 8.3%       |
| testing                       | 11             | 6.5%       |
| template                      | 10             | 6.0%       |
| checklist                     | 9              | 5.4%       |
| a-b-testing-manual-bundle-... | 9              | 5.4%       |
| manual                        | 9              | 5.4%       |

#### Low Usage (1-5% of documents) - **80 tags**

Not worth indexing individually. Rely on full index for these.

#### Rare Usage (<1% of documents) - **214 tags**

Definitely skip indexing. Use full index.

### Tag Co-occurrence Patterns

The top 10 tag combinations reveal strong clustering:

| Tag Combination            | Document Count |
| -------------------------- | -------------- |
| 03-resources + books       | 132            |
| 03-resources + joel        | 132            |
| books + joel               | 132            |
| 03-resources + business    | 115            |
| books + business           | 115            |
| business + joel            | 115            |
| 03-resources + copywriting | 43             |
| books + copywriting        | 43             |
| business + copywriting     | 43             |
| copywriting + joel         | 43             |

**Insight:** The tags `03-resources`, `books`, and `joel` appear together in 132/168 documents (78.6%). This suggests a core corpus of personal business/copywriting books. Partial indexes will significantly speed up queries filtering on these tags.

---

## libSQL Partial Index Mechanics

### Current Full Index

```sql
CREATE INDEX embeddings_idx ON embeddings(libsql_vector_idx(embedding))
```

This index covers all embeddings. When filtering by tags, we:

1. Use `vector_top_k('embeddings_idx', vector32(?), limit*3)` to get top candidates
2. Join to `documents` table
3. Filter by tag using `EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)`
4. Limit to final count

**Problem:** We're fetching `limit*3` candidates to account for tag filtering. For high-usage tags (79% of docs match), this wastes 70% of the work.

### Partial Index Strategy

```sql
CREATE INDEX idx_tag_<tagname> ON embeddings(libsql_vector_idx(embedding))
WHERE chunk_id IN (
  SELECT c.id
  FROM chunks c
  JOIN documents d ON d.id = c.doc_id
  WHERE EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = '<tagname>')
)
```

This creates a DiskANN index **only** for embeddings whose chunks belong to documents with a specific tag.

**Benefits:**

- Smaller index size (faster search)
- No post-filter waste (fetch exactly what you need)
- Direct `vector_top_k('idx_tag_<tagname>', vector32(?), limit)` call

**Tradeoffs:**

- Index maintenance overhead (rebuilds when tags change)
- Storage cost (6 indexes = ~6x storage for high-usage tags)
- Complexity (query router must select correct index)

---

## Recommended Implementation

### Phase 1: High-Usage Tags (Initial Rollout)

Create partial indexes for the **6 high-usage tags** (≥20% coverage):

```sql
-- books (79.2% coverage)
CREATE INDEX IF NOT EXISTS idx_tag_books ON embeddings(libsql_vector_idx(embedding))
WHERE chunk_id IN (
  SELECT c.id
  FROM chunks c
  JOIN documents d ON d.id = c.doc_id
  WHERE EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = 'books')
);

-- joel (78.6% coverage)
CREATE INDEX IF NOT EXISTS idx_tag_joel ON embeddings(libsql_vector_idx(embedding))
WHERE chunk_id IN (
  SELECT c.id
  FROM chunks c
  JOIN documents d ON d.id = c.doc_id
  WHERE EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = 'joel')
);

-- 03-resources (78.6% coverage)
CREATE INDEX IF NOT EXISTS idx_tag_03_resources ON embeddings(libsql_vector_idx(embedding))
WHERE chunk_id IN (
  SELECT c.id
  FROM chunks c
  JOIN documents d ON d.id = c.doc_id
  WHERE EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = '03-resources')
);

-- business (68.5% coverage)
CREATE INDEX IF NOT EXISTS idx_tag_business ON embeddings(libsql_vector_idx(embedding))
WHERE chunk_id IN (
  SELECT c.id
  FROM chunks c
  JOIN documents d ON d.id = c.doc_id
  WHERE EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = 'business')
);

-- copywriting (25.6% coverage)
CREATE INDEX IF NOT EXISTS idx_tag_copywriting ON embeddings(libsql_vector_idx(embedding))
WHERE chunk_id IN (
  SELECT c.id
  FROM chunks c
  JOIN documents d ON d.id = c.doc_id
  WHERE EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = 'copywriting')
);

-- hackers (20.8% coverage)
CREATE INDEX IF NOT EXISTS idx_tag_hackers ON embeddings(libsql_vector_idx(embedding))
WHERE chunk_id IN (
  SELECT c.id
  FROM chunks c
  JOIN documents d ON d.id = c.doc_id
  WHERE EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = 'hackers')
);
```

### Phase 2: Medium-Usage Tags (If Query Patterns Justify)

Monitor query patterns. If users frequently filter by medium-usage tags (5-20% coverage), add selective indexes:

- `just-fucking-ship` (12.5%)
- `software-development` (8.9%)
- `testing` (6.5%)

Use the same pattern as above, substituting tag names.

### Query Router Logic

The database service must select the correct index based on the query:

```typescript
// In LibSQLDatabase.vectorSearch()
function selectIndexForTags(tags: string[]): string {
  // Single-tag queries: use partial index if available
  if (tags.length === 1) {
    const tag = tags[0];
    const partialIndexes = new Set([
      "books",
      "joel",
      "03-resources",
      "business",
      "copywriting",
      "hackers",
    ]);

    if (partialIndexes.has(tag)) {
      // Use partial index (escape tag name for SQL)
      return `idx_tag_${tag.replace(/[^a-z0-9]/g, "_")}`;
    }
  }

  // Multi-tag or non-indexed tag: use full index
  return "embeddings_idx";
}

// Usage in query
const indexName = selectIndexForTags(tags || []);
const sql = `
  SELECT ... 
  FROM vector_top_k('${indexName}', vector32(?), ?) AS top
  ...
`;
```

**Note:** For multi-tag queries (e.g., `tags: ['books', 'copywriting']`), use the full index and post-filter. Creating indexes for every tag combination is impractical (309 tags = 47,736 pairs).

---

## Query Patterns

### Pattern 1: Single Tag, High-Usage (Use Partial Index)

**Query:** Find documents tagged `copywriting` similar to query vector.

**SQL:**

```sql
SELECT
  c.doc_id,
  d.title,
  c.page,
  c.chunk_index,
  c.content,
  vector_distance_cos(e.embedding, vector32(?)) as distance
FROM vector_top_k('idx_tag_copywriting', vector32(?), ?) AS top
JOIN embeddings e ON e.rowid = top.id
JOIN chunks c ON c.id = e.chunk_id
JOIN documents d ON d.id = c.doc_id
ORDER BY distance ASC
LIMIT ?;
```

**Optimization:** No post-filtering needed. Fetch exactly `limit` results.

### Pattern 2: Single Tag, Low/Rare Usage (Use Full Index + Filter)

**Query:** Find documents tagged `user-onboarding` (rare tag, 3.6% coverage).

**SQL:**

```sql
SELECT
  c.doc_id,
  d.title,
  c.page,
  c.chunk_index,
  c.content,
  vector_distance_cos(e.embedding, vector32(?)) as distance
FROM vector_top_k('embeddings_idx', vector32(?), ?) AS top
JOIN embeddings e ON e.rowid = top.id
JOIN chunks c ON c.id = e.chunk_id
JOIN documents d ON d.id = c.doc_id
WHERE EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)
ORDER BY distance ASC
LIMIT ?;
```

**Note:** Fetch `limit * 3` from index, filter, then limit to final count.

### Pattern 3: Multiple Tags (Use Full Index + Filter)

**Query:** Find documents tagged BOTH `copywriting` AND `email`.

**SQL:**

```sql
SELECT
  c.doc_id,
  d.title,
  c.page,
  c.chunk_index,
  c.content,
  vector_distance_cos(e.embedding, vector32(?)) as distance
FROM vector_top_k('embeddings_idx', vector32(?), ?) AS top
JOIN embeddings e ON e.rowid = top.id
JOIN chunks c ON c.id = e.chunk_id
JOIN documents d ON d.id = c.doc_id
WHERE
  EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)
  AND EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)
ORDER BY distance ASC
LIMIT ?;
```

**Note:** OR queries use `(... OR ...)` instead of multiple `EXISTS` clauses.

### Pattern 4: No Tags (Use Full Index)

**Query:** Find all similar documents (no tag filter).

**SQL:**

```sql
SELECT
  c.doc_id,
  d.title,
  c.page,
  c.chunk_index,
  c.content,
  vector_distance_cos(e.embedding, vector32(?)) as distance
FROM vector_top_k('embeddings_idx', vector32(?), ?) AS top
JOIN embeddings e ON e.rowid = top.id
JOIN chunks c ON c.id = e.chunk_id
JOIN documents d ON d.id = c.doc_id
ORDER BY distance ASC
LIMIT ?;
```

---

## Migration Approach

### Step 1: Baseline Performance Metrics

Before creating partial indexes, benchmark current performance:

```typescript
// Run in scripts/benchmark-vector-search.ts
const queries = [
  { tag: "books", expectedDocs: 133 },
  { tag: "copywriting", expectedDocs: 43 },
  { tag: "just-fucking-ship", expectedDocs: 21 },
  { tag: null, expectedDocs: 168 }, // no filter
];

for (const { tag, expectedDocs } of queries) {
  const start = performance.now();
  await vectorSearch(queryEmbedding, {
    limit: 10,
    tags: tag ? [tag] : undefined,
  });
  const duration = performance.now() - start;
  console.log(
    `Tag: ${tag || "none"}, Docs: ${expectedDocs}, Time: ${duration.toFixed(
      2
    )}ms`
  );
}
```

**Expected baseline:** 50-200ms per query (depends on corpus size, fetch multiplier).

### Step 2: Create Partial Indexes

Add index creation to `initSchema()` in `LibSQLDatabase.ts`:

```typescript
// After creating embeddings_idx
const highUsageTags = [
  "books",
  "joel",
  "03-resources",
  "business",
  "copywriting",
  "hackers",
];

for (const tag of highUsageTags) {
  const indexName = `idx_tag_${tag.replace(/[^a-z0-9]/g, "_")}`;
  await client.execute(`
    CREATE INDEX IF NOT EXISTS ${indexName} 
    ON embeddings(libsql_vector_idx(embedding))
    WHERE chunk_id IN (
      SELECT c.id 
      FROM chunks c 
      JOIN documents d ON d.id = c.doc_id 
      WHERE EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = '${tag}')
    )
  `);
}
```

**Warning:** Index creation is **slow** for large corpora. For 168 docs with ~10k embeddings, expect 5-10 minutes per index. Run during maintenance windows.

### Step 3: Update Query Router

Implement the `selectIndexForTags()` function (shown in "Query Router Logic" section).

### Step 4: Benchmark Again

Re-run benchmarks from Step 1. Compare:

- **High-usage tag queries:** Should be 2-3x faster (no post-filter waste)
- **Low-usage tag queries:** Should be unchanged (still using full index)
- **No-tag queries:** Should be unchanged (still using full index)

### Step 5: Monitor Index Maintenance

Track index rebuild frequency:

- **When tags change:** libSQL should auto-update partial indexes (verify with `EXPLAIN` if possible)
- **When new documents added:** Indexes update incrementally
- **Storage cost:** Check `.db` file size growth (expect +30-50% for 6 indexes)

If maintenance becomes costly, consider dropping indexes for tags that rarely appear in queries.

---

## Storage & Maintenance Cost Analysis

### Estimated Storage Impact

Assuming 168 documents, ~10,000 embeddings, 1024-dim F32_BLOB (4KB per embedding):

- **Full index:** ~40MB (10k embeddings × 4KB)
- **Per partial index (high-usage tag):**
  - `books` (79.2%): ~32MB
  - `joel` (78.6%): ~31MB
  - `business` (68.5%): ~27MB
  - `copywriting` (25.6%): ~10MB
  - `hackers` (20.8%): ~8MB

**Total additional storage:** ~108MB (2.7x increase)

**Mitigation:** For a 10GB database, this is acceptable. For larger corpora, be selective about which tags get indexes.

### Maintenance Triggers

Partial indexes must rebuild when:

1. **Tag added/removed from document:** Triggers WHERE clause re-evaluation
2. **Document deleted:** Cascades to chunks → embeddings (index auto-updates)
3. **Embedding updated:** Rare, but possible if re-embedding corpus

**Cost:** libSQL handles this via shadow tables. Expect minimal overhead for single-document updates. Bulk operations (e.g., re-tagging 100 docs) may lock indexes temporarily.

---

## Alternative: Tag Denormalization

Instead of partial indexes, consider denormalizing tags into the `chunks` table:

```sql
ALTER TABLE chunks ADD COLUMN doc_tags TEXT DEFAULT '[]';

-- Trigger to sync tags from documents
CREATE TRIGGER IF NOT EXISTS sync_chunk_tags
AFTER UPDATE OF tags ON documents
BEGIN
  UPDATE chunks SET doc_tags = NEW.tags WHERE doc_id = NEW.id;
END;
```

**Pros:**

- Simpler query (no JOIN to documents for tag filtering)
- Single full index, no partial indexes

**Cons:**

- Storage bloat (tags repeated for every chunk)
- Sync complexity (triggers must handle INSERT/UPDATE/DELETE)
- Harder to reason about (tags live in two places)

**Verdict:** Stick with partial indexes. libSQL's DiskANN is optimized for this use case.

---

## Recommendations

### Do This Now

1. **Benchmark current performance** (establish baseline)
2. **Create partial indexes for 6 high-usage tags** (accept storage cost)
3. **Implement query router** (single-tag → partial index, else → full index)
4. **Re-benchmark** (validate 2-3x speedup for filtered queries)

### Consider Later

1. **Add medium-usage tag indexes** (if query logs show frequent use)
2. **Drop rare-tag indexes** (if query logs show they're unused)
3. **Monitor index maintenance cost** (watch for rebuild storms during bulk updates)

### Don't Do This

1. **Don't index every tag** (309 indexes = maintenance hell)
2. **Don't create multi-tag combo indexes** (47k indexes for all pairs)
3. **Don't denormalize tags into chunks** (complexity > benefit)

---

## Appendix: SQL Reference

### Check Index Usage (Heuristic)

libSQL doesn't expose EXPLAIN for vector queries, but you can check if an index exists:

```sql
SELECT name FROM sqlite_master
WHERE type='index' AND tbl_name='embeddings';
```

### Drop a Partial Index

```sql
DROP INDEX IF EXISTS idx_tag_books;
```

### Rebuild All Indexes

```sql
REINDEX embeddings;
```

### Check Index Metadata (Shadow Tables)

```sql
SELECT * FROM libsql_vector_meta_shadow
WHERE table_name = 'embeddings';
```

This shows DiskANN parameters (block_size, etc.) for each index.

---

## Conclusion

The tag distribution analysis reveals a **clear tiering** of tag usage:

- **6 high-usage tags** (≥20%) warrant dedicated partial indexes
- **9 medium-usage tags** (5-20%) are candidates for future indexing
- **294 low/rare tags** (<5%) should rely on the full index

**Expected Performance Gain:**

- **High-usage tag queries:** 2-3x faster (no post-filter waste)
- **Storage cost:** +2.7x for indexes (acceptable for this corpus size)

**Next Steps:**

1. Implement partial indexes for high-usage tags
2. Benchmark before/after
3. Monitor query patterns to refine index selection

This strategy balances **query performance**, **storage cost**, and **maintenance complexity** for the current corpus. As the library grows, revisit tag distribution and adjust indexes accordingly.
