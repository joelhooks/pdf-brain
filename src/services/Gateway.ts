/**
 * Vercel AI Gateway Embedding Service
 */

import {
  Effect,
  Context,
  Layer,
  Schedule,
  Duration,
  Chunk,
  Stream,
} from "effect";
import { embed, embedMany } from "ai";
import { GatewayError, loadConfig } from "../types.js";

// ============================================================================
// Service Definition
// ============================================================================

export class Gateway extends Context.Tag("Gateway")<
  Gateway,
  {
    readonly embed: (text: string) => Effect.Effect<number[], GatewayError>;
    readonly embedBatch: (
      texts: string[],
      concurrency?: number,
    ) => Effect.Effect<number[][], GatewayError>;
    readonly checkHealth: () => Effect.Effect<void, GatewayError>;
  }
>() {}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Detected embedding dimension (set on first embedding call)
 * Different models/providers have different dimensions:
 * - openai/text-embedding-3-small: 1536
 * - openai/text-embedding-3-large: 3072
 * - cohere/embed-english-v3.0: 1024
 */
let detectedEmbeddingDimension: number | null = null;

/**
 * Get the detected embedding dimension (for use by database schema)
 */
export function getGatewayEmbeddingDimension(): number | null {
  return detectedEmbeddingDimension;
}

/**
 * Validates embedding dimensions and values before database insert
 *
 * On first call, records the dimension for consistency checking.
 * Subsequent calls verify dimension matches the first.
 *
 * @param embedding - The embedding vector to validate
 * @returns Effect that fails with GatewayError if invalid
 */
function validateEmbedding(
  embedding: number[],
): Effect.Effect<number[], GatewayError> {
  if (embedding.length === 0) {
    return Effect.fail(
      new GatewayError({
        reason: "Invalid embedding: dimension 0 (empty vector)",
      }),
    );
  }

  // First embedding sets the expected dimension
  if (detectedEmbeddingDimension === null) {
    detectedEmbeddingDimension = embedding.length;
    console.log(
      `[Gateway] Detected embedding dimension: ${detectedEmbeddingDimension}`,
    );
  } else if (embedding.length !== detectedEmbeddingDimension) {
    // Subsequent embeddings must match
    return Effect.fail(
      new GatewayError({
        reason: `Invalid embedding: dimension ${embedding.length} (expected ${detectedEmbeddingDimension})`,
      }),
    );
  }

  if (embedding.some((v) => !Number.isFinite(v))) {
    return Effect.fail(
      new GatewayError({
        reason:
          "Invalid embedding: contains non-finite values (NaN or Infinity)",
      }),
    );
  }

  return Effect.succeed(embedding);
}

export const GatewayLive = Layer.effect(
  Gateway,
  Effect.gen(function* () {
    const config = loadConfig();
    const model = config.embedding.model; // e.g., "openai/text-embedding-3-small"

    // Check API key at initialization time
    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) {
      return yield* Effect.fail(
        new GatewayError({ reason: "AI_GATEWAY_API_KEY not set" }),
      );
    }

    const embedSingle = (text: string): Effect.Effect<number[], GatewayError> =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: async () => {
            const { embedding } = await embed({ model, value: text });
            return embedding;
          },
          catch: (e) =>
            new GatewayError({
              reason: `Embedding failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            }),
        });

        // Validate embedding before returning to prevent database corruption
        return yield* validateEmbedding(result);
      }).pipe(
        // Retry with exponential backoff on transient failures
        Effect.retry(
          Schedule.exponential(Duration.millis(100)).pipe(
            Schedule.compose(Schedule.recurs(3)),
          ),
        ),
      );

    return {
      embed: embedSingle,

      embedBatch: (texts: string[], concurrency = 10) =>
        Stream.fromIterable(texts).pipe(
          Stream.mapEffect(embedSingle, { concurrency }),
          Stream.runCollect,
          Effect.map(Chunk.toArray),
        ),

      checkHealth: () =>
        Effect.gen(function* () {
          if (!process.env.AI_GATEWAY_API_KEY) {
            return yield* Effect.fail(
              new GatewayError({ reason: "AI_GATEWAY_API_KEY not set" }),
            );
          }
          // Do a test embedding to verify connectivity and model access
          yield* embedSingle("health check");
        }),
    };
  }),
);
