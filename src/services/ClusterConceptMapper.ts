import { Context, Effect, Layer } from "effect";

/**
 * Input cluster with centroid embedding
 */
export interface ClusterInput {
  id: number;
  summary: string;
  centroid: number[];
}

/**
 * SKOS concept with embedding
 */
export interface ConceptInput {
  id: string;
  label: string;
  embedding: number[];
}

/**
 * Result of mapping a cluster to concepts
 */
export interface MapResult {
  clusterId: number;
  matched: boolean;
  conceptId?: string;
  confidence?: number;
  suggestedLabel?: string;
}

/**
 * Options for cluster mapping
 */
export interface MapOptions {
  threshold: number;
}

/**
 * Service for mapping document clusters to SKOS concepts
 */
export interface ClusterConceptMapperService {
  readonly mapCluster: (
    cluster: ClusterInput,
    concepts: ConceptInput[],
    options: MapOptions
  ) => Effect.Effect<MapResult, ClusterConceptMapperError>;
}

export class ClusterConceptMapperError {
  readonly _tag = "ClusterConceptMapperError";
  constructor(readonly reason: string) {}
}

export const ClusterConceptMapperService =
  Context.GenericTag<ClusterConceptMapperService>(
    "@services/ClusterConceptMapperService"
  );

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class ClusterConceptMapperImpl {
  static Default = Layer.succeed(
    ClusterConceptMapperService,
    ClusterConceptMapperService.of({
      mapCluster: (cluster, concepts, options) =>
        Effect.try({
          try: () => {
            let bestMatch: { id: string; similarity: number } | null = null;

            for (const concept of concepts) {
              const similarity = cosineSimilarity(
                cluster.centroid,
                concept.embedding
              );
              if (similarity >= options.threshold) {
                if (!bestMatch || similarity > bestMatch.similarity) {
                  bestMatch = { id: concept.id, similarity };
                }
              }
            }

            if (bestMatch) {
              return {
                clusterId: cluster.id,
                matched: true,
                conceptId: bestMatch.id,
                confidence: bestMatch.similarity,
              };
            }

            // No match - suggest new concept from summary
            const suggestedLabel = cluster.summary
              .split(/[.!?]/)[0]
              .slice(0, 50);
            return {
              clusterId: cluster.id,
              matched: false,
              suggestedLabel,
            };
          },
          catch: (e) => new ClusterConceptMapperError(String(e)),
        }),
    })
  );
}
