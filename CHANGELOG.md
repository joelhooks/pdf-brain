# pdf-brain

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
