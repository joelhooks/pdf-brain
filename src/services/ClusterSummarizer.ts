import { Context, Effect, Layer } from "effect";
import { generateObject } from "ai";
import { z } from "zod";

/**
 * Summary metadata for a document cluster
 */
export interface ClusterSummary {
  readonly clusterId: number;
  readonly summary: string;
  readonly chunkCount: number;
  /** Key topics extracted from the cluster (LLM-based only) */
  readonly keyTopics?: string[];
  /** Representative quote from the cluster (LLM-based only) */
  readonly representativeQuote?: string;
}

/**
 * Options for generating cluster summaries
 */
export interface SummarizeOptions {
  readonly clusterId: number;
  readonly maxChunks?: number;
}

/**
 * Service for generating text summaries of document clusters
 */
export interface ClusterSummarizerService {
  readonly summarize: (
    chunks: Array<{ id: string; content: string }>,
    options: SummarizeOptions
  ) => Effect.Effect<ClusterSummary, ClusterSummarizerError>;
}

/**
 * Error type for cluster summarization failures
 */
export class ClusterSummarizerError {
  readonly _tag = "ClusterSummarizerError";
  constructor(readonly reason: string) {}
}

export const ClusterSummarizerService =
  Context.GenericTag<ClusterSummarizerService>(
    "@services/ClusterSummarizerService"
  );

/**
 * Schema for LLM-based abstractive summary
 */
const SummarySchema = z.object({
  summary: z
    .string()
    .describe("2-4 sentence abstractive summary of the cluster's main themes"),
  keyTopics: z
    .array(z.string())
    .describe("3-6 key topics or themes covered in the cluster"),
  representativeQuote: z
    .string()
    .optional()
    .describe("Most representative or impactful quote from the chunks"),
});

/**
 * Generate extractive summary as fallback when LLM unavailable
 *
 * Extracts first meaningful sentence from each chunk and combines them.
 * Simple but reliable - no external dependencies.
 *
 * @param chunks - Document chunks to summarize
 * @param options - Summarization options
 * @returns Extractive summary without LLM-specific fields
 */
function generateExtractiveSummary(
  chunks: Array<{ id: string; content: string }>,
  options: SummarizeOptions
): ClusterSummary {
  if (chunks.length === 0) {
    return {
      clusterId: options.clusterId,
      summary: "Empty cluster with no documents.",
      chunkCount: 0,
    };
  }

  // Extractive summary: first sentence from each chunk
  const maxChunks = options.maxChunks ?? chunks.length;
  const chunksToSummarize = chunks.slice(0, maxChunks);

  const sentences = chunksToSummarize
    .map((c) => {
      const firstSentence = c.content.split(/[.!?]/)[0];
      return firstSentence.trim();
    })
    .filter((s) => s.length > 10)
    .slice(0, 3);

  const summary =
    sentences.length > 0
      ? `This cluster covers: ${sentences.join(". ")}.`
      : "Cluster contains very short text fragments.";

  return {
    clusterId: options.clusterId,
    summary,
    chunkCount: chunks.length,
  };
}

/**
 * Generate LLM-based abstractive summary using Claude Haiku
 *
 * Creates a cohesive summary by analyzing chunk content holistically.
 * Automatically falls back to extractive summarization if LLM unavailable.
 *
 * Uses AI SDK with Vercel AI Gateway - no provider setup needed.
 * Model: anthropic/claude-haiku-4-5 (fast, cost-effective)
 *
 * @param chunks - Document chunks to summarize
 * @param options - Summarization options (clusterId, maxChunks)
 * @returns Abstractive summary with keyTopics and optional representativeQuote
 */
async function generateAbstractiveSummary(
  chunks: Array<{ id: string; content: string }>,
  options: SummarizeOptions
): Promise<ClusterSummary> {
  // Handle empty clusters without LLM
  if (chunks.length === 0) {
    return {
      clusterId: options.clusterId,
      summary: "Empty cluster with no documents.",
      chunkCount: 0,
    };
  }

  const maxChunks = options.maxChunks ?? chunks.length;
  const chunksToSummarize = chunks.slice(0, maxChunks);

  // Combine chunk contents for LLM analysis
  const combinedContent = chunksToSummarize
    .map((c, i) => `[Chunk ${i + 1}]\n${c.content}`)
    .join("\n\n");

  // Truncate if too long (keep under 6000 chars for context)
  const truncatedContent = combinedContent.slice(0, 6000);

  try {
    const { object } = await generateObject({
      model: "anthropic/claude-haiku-4-5",
      schema: SummarySchema,
      prompt: `Analyze these document chunks from a knowledge library cluster and create an abstractive summary.

${truncatedContent}

Generate:
- summary: A cohesive 2-4 sentence summary that captures the main themes and insights
- keyTopics: 3-6 key topics or concepts covered across these chunks
- representativeQuote: (optional) The most representative or impactful quote from the chunks

Focus on synthesizing ideas across chunks, not just listing them.`,
    });

    return {
      clusterId: options.clusterId,
      summary: object.summary,
      chunkCount: chunks.length,
      keyTopics: object.keyTopics,
      representativeQuote: object.representativeQuote,
    };
  } catch (error) {
    // Fallback to extractive summarization if LLM fails
    console.warn(
      "LLM summarization failed, falling back to extractive:",
      error
    );
    return generateExtractiveSummary(chunks, options);
  }
}

/**
 * Default implementation using LLM-based abstractive summarization
 * with extractive fallback when LLM unavailable
 */
export class ClusterSummarizerImpl {
  static Default = Layer.succeed(
    ClusterSummarizerService,
    ClusterSummarizerService.of({
      summarize: (chunks, options) =>
        Effect.tryPromise({
          try: () => generateAbstractiveSummary(chunks, options),
          catch: (e) => new ClusterSummarizerError(String(e)),
        }),
    })
  );
}
