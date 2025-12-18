---
"pdf-brain": minor
---

Add expanded context feature for search results

- New `--expand <chars>` flag for CLI search command (max 4000 chars)
- New `expandChars` option in `SearchOptions` to control context expansion
- `SearchResult` now includes optional `expandedContent` and `expandedRange` fields
- Intelligent budget-based expansion that fetches adjacent chunks without blowing context
- Deduplication of overlapping expansions when multiple results are from same document
