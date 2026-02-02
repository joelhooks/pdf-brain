/**
 * TaxonomyService - SKOS Taxonomy Operations
 *
 * Implements W3C SKOS (Simple Knowledge Organization System) for controlled vocabulary.
 * Supports polyhierarchy (multiple parents), transitive queries, and document mappings.
 */

import { Context, Effect, Layer } from "effect";
import { createClient, type Client, type InValue } from "@libsql/client";
import { DatabaseError } from "../types.js";
import { EmbeddingProvider, EmbeddingError } from "./EmbeddingProvider.js";

// ============================================================================
// Types
// ============================================================================

/** SKOS Concept */
export interface Concept {
  id: string;
  prefLabel: string;
  altLabels: string[];
  definition?: string;
  createdAt: Date;
}

/** Concept-Document assignment */
export interface ConceptAssignment {
  docId: string;
  conceptId: string;
  confidence: number;
  source: string;
}

/** Taxonomy JSON structure for bulk import */
export interface TaxonomyJSON {
  concepts: Array<{
    id: string;
    prefLabel: string;
    altLabels?: string[];
    definition?: string;
  }>;
  hierarchy?: Array<{
    conceptId: string;
    broaderId: string;
  }>;
  relations?: Array<{
    conceptId: string;
    relatedId: string;
    relationType?: string;
  }>;
}

/** Concept creation params */
export interface CreateConceptParams {
  id: string;
  prefLabel: string;
  altLabels?: string[];
  definition?: string;
}

/** Concept update params */
export interface UpdateConceptParams {
  prefLabel?: string;
  altLabels?: string[];
  definition?: string;
}

/** Custom error for taxonomy operations */
export class TaxonomyError {
  readonly _tag = "TaxonomyError";
  constructor(readonly reason: string) {}
}

// ============================================================================
// Service Definition
// ============================================================================

/**
 * TaxonomyService interface
 */
export interface TaxonomyService {
  // Concept CRUD
  readonly addConcept: (
    params: CreateConceptParams
  ) => Effect.Effect<void, TaxonomyError>;
  readonly getConcept: (
    id: string
  ) => Effect.Effect<Concept | null, TaxonomyError>;
  readonly listConcepts: () => Effect.Effect<Concept[], TaxonomyError>;
  readonly updateConcept: (
    id: string,
    updates: UpdateConceptParams
  ) => Effect.Effect<void, TaxonomyError>;

  // Hierarchy (polyhierarchy - multiple parents allowed)
  readonly addBroader: (
    conceptId: string,
    broaderId: string
  ) => Effect.Effect<void, TaxonomyError>;
  readonly removeBroader: (
    conceptId: string,
    broaderId: string
  ) => Effect.Effect<void, TaxonomyError>;
  readonly getBroader: (
    conceptId: string
  ) => Effect.Effect<Concept[], TaxonomyError>;
  readonly getNarrower: (
    conceptId: string
  ) => Effect.Effect<Concept[], TaxonomyError>;
  readonly getAncestors: (
    conceptId: string
  ) => Effect.Effect<Concept[], TaxonomyError>;
  readonly getDescendants: (
    conceptId: string
  ) => Effect.Effect<Concept[], TaxonomyError>;

  // Relations (SKOS 'related' - symmetric)
  readonly addRelated: (
    conceptId: string,
    relatedId: string,
    type?: string
  ) => Effect.Effect<void, TaxonomyError>;
  readonly removeRelated: (
    conceptId: string,
    relatedId: string
  ) => Effect.Effect<void, TaxonomyError>;
  readonly getRelated: (
    conceptId: string
  ) => Effect.Effect<Concept[], TaxonomyError>;

  // Document mappings
  readonly assignToDocument: (
    docId: string,
    conceptId: string,
    confidence?: number,
    source?: string
  ) => Effect.Effect<void, TaxonomyError>;
  readonly removeFromDocument: (
    docId: string,
    conceptId: string
  ) => Effect.Effect<void, TaxonomyError>;
  readonly getDocumentConcepts: (
    docId: string
  ) => Effect.Effect<ConceptAssignment[], TaxonomyError>;
  readonly getConceptDocuments: (
    conceptId: string
  ) => Effect.Effect<ConceptAssignment[], TaxonomyError>;

  // Bulk operations
  readonly seedFromJSON: (
    taxonomy: TaxonomyJSON
  ) => Effect.Effect<void, TaxonomyError>;

  // Concept Embeddings (vector search)
  readonly storeConceptEmbedding: (
    conceptId: string,
    embedding: number[]
  ) => Effect.Effect<void, TaxonomyError>;
  readonly findSimilarConcepts: (
    embedding: number[],
    threshold?: number,
    limit?: number
  ) => Effect.Effect<Concept[], TaxonomyError>;
}

export const TaxonomyService = Context.GenericTag<TaxonomyService>(
  "@services/TaxonomyService"
);

// ============================================================================
// Implementation
// ============================================================================

/**
 * Parse row from concepts table
 */
const parseConceptRow = (row: {
  id: string;
  pref_label: string;
  alt_labels: string;
  definition: string | null;
  created_at: string;
}): Concept => ({
  id: row.id,
  prefLabel: row.pref_label,
  altLabels: JSON.parse(row.alt_labels) as string[],
  definition: row.definition || undefined,
  createdAt: new Date(row.created_at),
});

/**
 * Parse row from document_concepts table
 */
const parseAssignmentRow = (row: {
  doc_id: string;
  concept_id: string;
  confidence: number;
  source: string;
}): ConceptAssignment => ({
  docId: row.doc_id,
  conceptId: row.concept_id,
  confidence: row.confidence,
  source: row.source,
});

/**
 * TaxonomyService static factory (mirrors LibSQLDatabase pattern)
 */
export class TaxonomyServiceImpl {
  /**
   * Create a TaxonomyService layer
   *
   * @param config - LibSQL client configuration
   *   - url: ":memory:" for in-memory, "file:./path.db" for local file, or remote URL
   *   - authToken: Optional auth token for Turso/remote databases
   *
   * Requires: Ollama service for embedding generation
   */
  static make(config: { url: string; authToken?: string }) {
    return Layer.scoped(
      TaxonomyService,
      Effect.gen(function* () {
        // Create libSQL client
        const client = createClient({
          url: config.url,
          authToken: config.authToken,
        });

        // Cleanup on scope close
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            client.close();
          })
        );

        // Helper to execute queries
        const execute = (
          sql: string,
          args: InValue[]
        ): Effect.Effect<{ rows: Record<string, unknown>[] }, DatabaseError> =>
          Effect.tryPromise({
            try: async () => {
              const result = await client.execute({ sql, args });
              return {
                rows: result.rows as Record<string, unknown>[],
              };
            },
            catch: (e) => new DatabaseError({ reason: String(e) }),
          });

        const mapError = (e: DatabaseError): TaxonomyError =>
          new TaxonomyError(e.reason);

        return TaxonomyService.of({
          // ======================================================================
          // Concept CRUD
          // ======================================================================

          addConcept: (params) =>
            Effect.gen(function* () {
              const { id, prefLabel, altLabels = [], definition } = params;

              yield* execute(
                `INSERT INTO concepts (id, pref_label, alt_labels, definition, created_at)
             VALUES (?, ?, ?, ?, ?)`,
                [
                  id,
                  prefLabel,
                  JSON.stringify(altLabels),
                  definition || null,
                  new Date().toISOString(),
                ]
              );
            }).pipe(Effect.mapError(mapError)),

          getConcept: (id) =>
            Effect.gen(function* () {
              const result = yield* execute(
                "SELECT * FROM concepts WHERE id = ?",
                [id]
              );

              if (result.rows.length === 0) {
                return null;
              }

              return parseConceptRow(
                result.rows[0] as Parameters<typeof parseConceptRow>[0]
              );
            }).pipe(Effect.mapError(mapError)),

          listConcepts: () =>
            Effect.gen(function* () {
              const result = yield* execute(
                "SELECT * FROM concepts ORDER BY pref_label ASC",
                []
              );

              return result.rows.map((row) =>
                parseConceptRow(row as Parameters<typeof parseConceptRow>[0])
              );
            }).pipe(Effect.mapError(mapError)),

          updateConcept: (id, updates) =>
            Effect.gen(function* () {
              const fields: string[] = [];
              const args: InValue[] = [];

              if (updates.prefLabel !== undefined) {
                fields.push("pref_label = ?");
                args.push(updates.prefLabel);
              }

              if (updates.altLabels !== undefined) {
                fields.push("alt_labels = ?");
                args.push(JSON.stringify(updates.altLabels));
              }

              if (updates.definition !== undefined) {
                fields.push("definition = ?");
                args.push(updates.definition);
              }

              if (fields.length === 0) {
                return;
              }

              args.push(id);
              const sql = `UPDATE concepts SET ${fields.join(
                ", "
              )} WHERE id = ?`;

              yield* execute(sql, args);
            }).pipe(Effect.mapError(mapError)),

          // ======================================================================
          // Hierarchy
          // ======================================================================

          addBroader: (conceptId, broaderId) =>
            Effect.gen(function* () {
              yield* execute(
                `INSERT INTO concept_hierarchy (concept_id, broader_id)
             VALUES (?, ?)
             ON CONFLICT DO NOTHING`,
                [conceptId, broaderId]
              );
            }).pipe(Effect.mapError(mapError)),

          removeBroader: (conceptId, broaderId) =>
            Effect.gen(function* () {
              yield* execute(
                `DELETE FROM concept_hierarchy 
             WHERE concept_id = ? AND broader_id = ?`,
                [conceptId, broaderId]
              );
            }).pipe(Effect.mapError(mapError)),

          getBroader: (conceptId) =>
            Effect.gen(function* () {
              const result = yield* execute(
                `SELECT c.* FROM concepts c
             JOIN concept_hierarchy ch ON c.id = ch.broader_id
             WHERE ch.concept_id = ?`,
                [conceptId]
              );

              return result.rows.map((row) =>
                parseConceptRow(row as Parameters<typeof parseConceptRow>[0])
              );
            }).pipe(Effect.mapError(mapError)),

          getNarrower: (conceptId) =>
            Effect.gen(function* () {
              const result = yield* execute(
                `SELECT c.* FROM concepts c
             JOIN concept_hierarchy ch ON c.id = ch.concept_id
             WHERE ch.broader_id = ?`,
                [conceptId]
              );

              return result.rows.map((row) =>
                parseConceptRow(row as Parameters<typeof parseConceptRow>[0])
              );
            }).pipe(Effect.mapError(mapError)),

          getAncestors: (conceptId) =>
            Effect.gen(function* () {
              const result = yield* execute(
                `WITH RECURSIVE ancestors AS (
               SELECT broader_id FROM concept_hierarchy WHERE concept_id = ?
               UNION
               SELECT ch.broader_id FROM concept_hierarchy ch
               JOIN ancestors a ON ch.concept_id = a.broader_id
             )
             SELECT c.* FROM concepts c
             WHERE c.id IN (SELECT broader_id FROM ancestors)`,
                [conceptId]
              );

              return result.rows.map((row) =>
                parseConceptRow(row as Parameters<typeof parseConceptRow>[0])
              );
            }).pipe(Effect.mapError(mapError)),

          getDescendants: (conceptId) =>
            Effect.gen(function* () {
              const result = yield* execute(
                `WITH RECURSIVE descendants AS (
               SELECT concept_id FROM concept_hierarchy WHERE broader_id = ?
               UNION
               SELECT ch.concept_id FROM concept_hierarchy ch
               JOIN descendants d ON ch.broader_id = d.concept_id
             )
             SELECT c.* FROM concepts c
             WHERE c.id IN (SELECT concept_id FROM descendants)`,
                [conceptId]
              );

              return result.rows.map((row) =>
                parseConceptRow(row as Parameters<typeof parseConceptRow>[0])
              );
            }).pipe(Effect.mapError(mapError)),

          // ======================================================================
          // Relations
          // ======================================================================

          addRelated: (conceptId, relatedId, type = "related") =>
            Effect.gen(function* () {
              // Add both directions for symmetric relationship
              yield* execute(
                `INSERT INTO concept_relations (concept_id, related_id, relation_type)
             VALUES (?, ?, ?)
             ON CONFLICT DO NOTHING`,
                [conceptId, relatedId, type]
              );

              yield* execute(
                `INSERT INTO concept_relations (concept_id, related_id, relation_type)
             VALUES (?, ?, ?)
             ON CONFLICT DO NOTHING`,
                [relatedId, conceptId, type]
              );
            }).pipe(Effect.mapError(mapError)),

          removeRelated: (conceptId, relatedId) =>
            Effect.gen(function* () {
              // Remove both directions
              yield* execute(
                `DELETE FROM concept_relations 
             WHERE (concept_id = ? AND related_id = ?) 
                OR (concept_id = ? AND related_id = ?)`,
                [conceptId, relatedId, relatedId, conceptId]
              );
            }).pipe(Effect.mapError(mapError)),

          getRelated: (conceptId) =>
            Effect.gen(function* () {
              const result = yield* execute(
                `SELECT c.* FROM concepts c
             JOIN concept_relations cr ON c.id = cr.related_id
             WHERE cr.concept_id = ?`,
                [conceptId]
              );

              return result.rows.map((row) =>
                parseConceptRow(row as Parameters<typeof parseConceptRow>[0])
              );
            }).pipe(Effect.mapError(mapError)),

          // ======================================================================
          // Document Mappings
          // ======================================================================

          assignToDocument: (
            docId,
            conceptId,
            confidence = 1.0,
            source = "llm"
          ) =>
            Effect.gen(function* () {
              yield* execute(
                `INSERT INTO document_concepts (doc_id, concept_id, confidence, source)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (doc_id, concept_id) DO UPDATE SET
               confidence = excluded.confidence,
               source = excluded.source`,
                [docId, conceptId, confidence, source]
              );
            }).pipe(Effect.mapError(mapError)),

          removeFromDocument: (docId, conceptId) =>
            Effect.gen(function* () {
              yield* execute(
                `DELETE FROM document_concepts 
             WHERE doc_id = ? AND concept_id = ?`,
                [docId, conceptId]
              );
            }).pipe(Effect.mapError(mapError)),

          getDocumentConcepts: (docId) =>
            Effect.gen(function* () {
              const result = yield* execute(
                `SELECT * FROM document_concepts WHERE doc_id = ?`,
                [docId]
              );

              return result.rows.map((row) =>
                parseAssignmentRow(
                  row as Parameters<typeof parseAssignmentRow>[0]
                )
              );
            }).pipe(Effect.mapError(mapError)),

          getConceptDocuments: (conceptId) =>
            Effect.gen(function* () {
              const result = yield* execute(
                `SELECT * FROM document_concepts WHERE concept_id = ?`,
                [conceptId]
              );

              return result.rows.map((row) =>
                parseAssignmentRow(
                  row as Parameters<typeof parseAssignmentRow>[0]
                )
              );
            }).pipe(Effect.mapError(mapError)),

          // ======================================================================
          // Bulk Operations
          // ======================================================================

          seedFromJSON: (taxonomy) =>
            Effect.gen(function* () {
              // Add all concepts
              for (const concept of taxonomy.concepts) {
                yield* execute(
                  `INSERT INTO concepts (id, pref_label, alt_labels, definition, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT DO NOTHING`,
                  [
                    concept.id,
                    concept.prefLabel,
                    JSON.stringify(concept.altLabels || []),
                    concept.definition || null,
                    new Date().toISOString(),
                  ]
                );
              }

              // Add hierarchy relationships
              if (taxonomy.hierarchy) {
                for (const rel of taxonomy.hierarchy) {
                  yield* execute(
                    `INSERT INTO concept_hierarchy (concept_id, broader_id)
                 VALUES (?, ?)
                 ON CONFLICT DO NOTHING`,
                    [rel.conceptId, rel.broaderId]
                  );
                }
              }

              // Add associative relations
              if (taxonomy.relations) {
                for (const rel of taxonomy.relations) {
                  const relType = rel.relationType || "related";

                  // Add both directions for symmetry
                  yield* execute(
                    `INSERT INTO concept_relations (concept_id, related_id, relation_type)
                 VALUES (?, ?, ?)
                 ON CONFLICT DO NOTHING`,
                    [rel.conceptId, rel.relatedId, relType]
                  );

                  yield* execute(
                    `INSERT INTO concept_relations (concept_id, related_id, relation_type)
                 VALUES (?, ?, ?)
                 ON CONFLICT DO NOTHING`,
                    [rel.relatedId, rel.conceptId, relType]
                  );
                }
              }
            }).pipe(Effect.mapError(mapError)),

          // ======================================================================
          // Concept Embeddings (Vector Search)
          // ======================================================================

          storeConceptEmbedding: (conceptId, embedding) =>
            Effect.gen(function* () {
              // Store embedding as F32_BLOB using vector32() function
              yield* execute(
                `INSERT INTO concept_embeddings (concept_id, embedding)
             VALUES (?, vector32(?))
             ON CONFLICT (concept_id) DO UPDATE SET
               embedding = excluded.embedding`,
                [conceptId, JSON.stringify(embedding)]
              );
            }).pipe(Effect.mapError(mapError)),

          findSimilarConcepts: (embedding, threshold = 0.85, limit = 5) =>
            Effect.gen(function* () {
              const queryVec = JSON.stringify(embedding);

              // Use vector_top_k with DiskANN index for fast ANN search
              // Convert distance to similarity score: score = 1 - distance/2
              // Filter by threshold: if score >= threshold, then distance <= 2*(1-threshold)
              const maxDistance = 2 * (1 - threshold);

              const result = yield* execute(
                `SELECT 
                c.id,
                c.pref_label,
                c.alt_labels,
                c.definition,
                c.created_at,
                vector_distance_cos(e.embedding, vector32(?)) as distance
              FROM vector_top_k('concept_embeddings_idx', vector32(?), ?) AS top
              JOIN concept_embeddings e ON e.rowid = top.id
              JOIN concepts c ON c.id = e.concept_id
              WHERE vector_distance_cos(e.embedding, vector32(?)) <= ?
              ORDER BY distance ASC`,
                [queryVec, queryVec, limit * 2, queryVec, maxDistance]
              );

              return result.rows.map((row) =>
                parseConceptRow(row as Parameters<typeof parseConceptRow>[0])
              );
            }).pipe(Effect.mapError(mapError)),
        });
      })
    );
  }
}

/**
 * Generate embedding for a concept using EmbeddingProvider
 * Standalone function that requires EmbeddingProvider service
 */
export const generateConceptEmbedding = (concept: Concept) =>
  Effect.gen(function* () {
    const embedProvider = yield* EmbeddingProvider;

    // Create text from prefLabel + definition for embedding
    // This ensures concepts are embedded in the same vector space as documents
    const text = concept.definition
      ? `${concept.prefLabel}: ${concept.definition}`
      : concept.prefLabel;

    // Generate embedding using EmbeddingProvider
    const embedding = yield* embedProvider.embed(text);

    return embedding;
  }).pipe(
    Effect.mapError(
      (e): TaxonomyError =>
        new TaxonomyError(
          `Failed to generate embedding: ${
            e._tag === "EmbeddingError" ? e.reason : String(e)
          }`
        )
    )
  );

/**
 * Default TaxonomyService layer - for testing with in-memory DB
 */
export const Default = TaxonomyServiceImpl.make({ url: ":memory:" });
