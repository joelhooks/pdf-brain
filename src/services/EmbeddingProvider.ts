/**
 * Unified Embedding Provider - Routes to Ollama or Gateway based on config
 */
import { Effect, Context, Layer } from "effect";
import { loadConfig, OllamaError, GatewayError } from "../types.js";
import { Ollama, OllamaLive } from "./Ollama.js";
import { Gateway, GatewayLive } from "./Gateway.js";

// ============================================================================
// Service Definition
// ============================================================================

// Union error type
export type EmbeddingError = OllamaError | GatewayError;

export class EmbeddingProvider extends Context.Tag("EmbeddingProvider")<
  EmbeddingProvider,
  {
    readonly embed: (text: string) => Effect.Effect<number[], EmbeddingError>;
    readonly embedBatch: (
      texts: string[],
      concurrency?: number,
    ) => Effect.Effect<number[][], EmbeddingError>;
    readonly checkHealth: () => Effect.Effect<void, EmbeddingError>;
    readonly provider: "ollama" | "gateway";
  }
>() {}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Live implementation that routes based on config.embedding.provider
 */
export const EmbeddingProviderLive = Layer.effect(
  EmbeddingProvider,
  Effect.gen(function* () {
    const config = loadConfig();
    const provider = config.embedding.provider;

    if (provider === "gateway") {
      // Use Gateway
      const gateway = yield* Gateway;
      return {
        embed: gateway.embed,
        embedBatch: gateway.embedBatch,
        checkHealth: gateway.checkHealth,
        provider: "gateway" as const,
      };
    } else {
      // Default to Ollama
      const ollama = yield* Ollama;
      return {
        embed: ollama.embed,
        embedBatch: ollama.embedBatch,
        checkHealth: ollama.checkHealth,
        provider: "ollama" as const,
      };
    }
  }),
);

/**
 * Full layer with dependencies - use this in app composition
 */
export const EmbeddingProviderFullLive = Layer.provide(
  EmbeddingProviderLive,
  Layer.merge(OllamaLive, GatewayLive),
);
