/**
 * Database Service Interface
 *
 * Defines the contract for database implementations.
 * Currently implemented by LibSQLDatabase.
 */

import { Context, Effect } from "effect";
import type {
  DatabaseError,
  Document,
  SearchOptions,
  SearchResult,
} from "../types.js";

// ============================================================================
// Service Definition
// ============================================================================

export class Database extends Context.Tag("Database")<
  Database,
  {
    // Document operations
    readonly addDocument: (doc: Document) => Effect.Effect<void, DatabaseError>;
    readonly getDocument: (
      id: string
    ) => Effect.Effect<Document | null, DatabaseError>;
    readonly getDocumentByPath: (
      path: string
    ) => Effect.Effect<Document | null, DatabaseError>;
    readonly listDocuments: (
      tag?: string
    ) => Effect.Effect<Document[], DatabaseError>;
    readonly deleteDocument: (id: string) => Effect.Effect<void, DatabaseError>;
    readonly updateTags: (
      id: string,
      tags: string[]
    ) => Effect.Effect<void, DatabaseError>;

    // Chunk operations
    readonly addChunks: (
      chunks: Array<{
        id: string;
        docId: string;
        page: number;
        chunkIndex: number;
        content: string;
      }>
    ) => Effect.Effect<void, DatabaseError>;
    readonly addEmbeddings: (
      embeddings: Array<{ chunkId: string; embedding: number[] }>
    ) => Effect.Effect<void, DatabaseError>;

    // Search operations
    readonly vectorSearch: (
      embedding: number[],
      options?: SearchOptions
    ) => Effect.Effect<SearchResult[], DatabaseError>;
    readonly ftsSearch: (
      query: string,
      options?: SearchOptions
    ) => Effect.Effect<SearchResult[], DatabaseError>;

    // Context expansion
    readonly getExpandedContext: (
      docId: string,
      chunkIndex: number,
      options?: { maxChars?: number; direction?: "before" | "after" | "both" }
    ) => Effect.Effect<
      { content: string; startIndex: number; endIndex: number },
      DatabaseError
    >;

    // Stats
    readonly getStats: () => Effect.Effect<
      { documents: number; chunks: number; embeddings: number },
      DatabaseError
    >;

    // Maintenance
    readonly repair: () => Effect.Effect<
      {
        orphanedChunks: number;
        orphanedEmbeddings: number;
        zeroVectorEmbeddings: number;
      },
      DatabaseError
    >;

    // WAL management (libSQL syncs automatically, but interface kept for compatibility)
    readonly checkpoint: () => Effect.Effect<void, DatabaseError>;

    // Backup/restore
    readonly dumpDataDir: () => Effect.Effect<Blob, DatabaseError>;

    // Streaming operations (for large datasets)
    readonly streamEmbeddings: (
      batchSize: number
    ) => AsyncGenerator<
      Array<{ chunkId: string; embedding: number[] }>,
      void,
      unknown
    >;

    // Bulk operations (for batch processing)
    readonly bulkInsertClusterAssignments: (
      assignments: Array<{
        chunkId: string;
        clusterId: number;
        distance: number;
      }>
    ) => Effect.Effect<void, DatabaseError>;
  }
>() {}
