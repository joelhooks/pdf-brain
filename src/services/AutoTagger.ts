/**
 * AutoTagger - Intelligent document enrichment
 *
 * Enriches documents with:
 * - Clean, properly formatted titles
 * - Author extraction
 * - Semantic tags and categories
 * - Brief summaries
 * - Document type classification
 *
 * Strategy: Local LLM first (Ollama), fallback to Anthropic Haiku
 */

// AI Gateway uses model strings directly, no provider import needed
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, generateText } from "ai";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import {
  TaxonomyService,
  generateConceptEmbedding,
} from "./TaxonomyService.js";
import { EmbeddingProvider } from "./EmbeddingProvider.js";
import { loadConfig } from "../types.js";

// ============================================================================
// Types
// ============================================================================

/** LLM provider options */
export type LLMProvider = "ollama" | "anthropic";

/** Document type classification */
export type DocumentType =
  | "book"
  | "paper"
  | "tutorial"
  | "reference"
  | "guide"
  | "article"
  | "report"
  | "presentation"
  | "notes"
  | "other";

/** Taxonomy concept (minimal interface for AutoTagger) */
export interface TaxonomyConcept {
  id: string;
  prefLabel: string;
  altLabels: string[];
}

/** Proposed new concept from LLM */
export interface ProposedConcept {
  id: string;
  prefLabel: string;
  altLabels?: string[];
  definition?: string;
}

/** Full enrichment result */
export interface EnrichmentResult {
  /** Clean, properly formatted title */
  title: string;
  /** Author name(s) if detected */
  author?: string;
  /** 2-3 sentence summary */
  summary: string;
  /** Document type classification */
  documentType: DocumentType;
  /** Primary category */
  category: string;
  /** Semantic tags (5-10) - DEPRECATED: use concepts instead */
  tags: string[];
  /** Matched concept IDs from taxonomy */
  concepts: string[];
  /** Proposed new concepts to add to taxonomy */
  proposedConcepts?: ProposedConcept[];
  /** Confidence score 0-1 */
  confidence: number;
  /** Which provider was used */
  provider: LLMProvider;
}

/** Lightweight tag-only result */
export interface TagResult {
  /** Tags extracted from path */
  pathTags: string[];
  /** Tags extracted from filename */
  filenameTags: string[];
  /** Tags from content analysis */
  contentTags: string[];
  /** Tags from LLM (if used) */
  llmTags: string[];
  /** All tags combined */
  allTags: string[];
  /** Author if detected */
  author?: string;
  /** Category if detected */
  category?: string;
}

/** Options for enrichment */
export interface EnrichmentOptions {
  /** Preferred LLM provider (default: ollama, falls back to anthropic) */
  provider?: LLMProvider;
  /** Specific model to use (overrides provider default) */
  model?: string;
  /** Skip LLM entirely, use heuristics only */
  heuristicsOnly?: boolean;
  /** Base path to strip from path-based tags */
  basePath?: string;
  /** Available taxonomy concepts for concept-based tagging */
  availableConcepts?: TaxonomyConcept[];
}

// ============================================================================
// Constants
// ============================================================================

/** Default models per provider */
const DEFAULT_MODELS: Record<LLMProvider, string> = {
  ollama: "llama3.2:3b",
  anthropic: "anthropic/claude-haiku-4-5",
};

/** Ollama base URL */
const OLLAMA_BASE_URL = process.env.OLLAMA_HOST || "http://localhost:11434";

/** Stop words for keyword extraction */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "was",
  "are",
  "were",
  "been",
  "be",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "can",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "what",
  "which",
  "who",
  "where",
  "when",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "no",
  "not",
  "only",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "also",
  "now",
  "here",
  "there",
  "then",
  "if",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "any",
  "pdf",
  "epub",
  "doc",
  "file",
  "document",
  "page",
  "pages",
  "chapter",
  "book",
  "ebook",
  "download",
  "copy",
  "version",
  "new",
  "first",
  "last",
  "good",
  "best",
  "free",
]);

/** Patterns to ignore in path segments */
const IGNORE_PATH_PATTERNS = [
  /^\d+$/, // Pure numbers
  /^[a-f0-9-]{36}$/i, // UUIDs
  /^(downloads?|documents?|files?|temp|tmp|cache)$/i,
  /^(users?|home|library|mobile documents)$/i,
  /^[._]/, // Hidden files/folders
  /^com\.[a-z]+\.[a-z]+$/i, // Bundle IDs
  /^3l68kqb4hg/i, // iCloud container IDs
];

/** Patterns to extract author from filename */
const AUTHOR_PATTERNS = [
  /[-–—]\s*([A-Z][a-z]+(?:\s+[A-Z]\.?\s*)?(?:[A-Z][a-z]+)?)\s*\.(?:pdf|epub|md)$/i,
  /by\s+([A-Z][a-z]+(?:\s+[A-Z]\.?\s*)?(?:[A-Z][a-z]+)?)/i,
  /\(([A-Z][a-z]+(?:\s+[A-Z]\.?\s*)?(?:[A-Z][a-z]+)?)\)\s*\.(?:pdf|epub|md)$/i,
];

// ============================================================================
// Schemas
// ============================================================================

/** Schema for proposed concepts */
const ProposedConceptSchema = z.object({
  id: z.string().describe("Suggested concept ID (e.g., 'programming/rust')"),
  prefLabel: z.string().describe("Preferred label"),
  altLabels: z
    .array(z.string())
    .optional()
    .describe("Alternative labels/aliases"),
  definition: z.string().optional().describe("Definition/description"),
});

/** Schema for full enrichment */
const EnrichmentSchema = z.object({
  title: z.string().describe("Clean, properly formatted document title"),
  author: z.string().optional().describe("Author name(s) if identifiable"),
  summary: z.string().describe("2-3 sentence summary of the document"),
  documentType: z
    .enum([
      "book",
      "paper",
      "tutorial",
      "reference",
      "guide",
      "article",
      "report",
      "presentation",
      "notes",
      "other",
    ])
    .describe("Type of document"),
  category: z
    .string()
    .describe("Primary category (e.g., programming, business, design)"),
  tags: z
    .array(z.string())
    .min(3)
    .max(10)
    .describe("5-10 descriptive tags (DEPRECATED: use concepts)"),
  concepts: z.array(z.string()).describe("Matched concept IDs from taxonomy"),
  proposedConcepts: z
    .array(ProposedConceptSchema)
    .optional()
    .describe("New concepts to add to taxonomy"),
});

/** Schema for lightweight tagging */
const TagSchema = z.object({
  tags: z.array(z.string()).min(3).max(7).describe("3-7 descriptive tags"),
  category: z.string().optional().describe("Primary category"),
  author: z.string().optional().describe("Author if identifiable"),
});

// ============================================================================
// Providers
// ============================================================================

/** Create Ollama provider */
const createOllamaProvider = () =>
  createOpenAICompatible({
    name: "ollama",
    baseURL: `${OLLAMA_BASE_URL}/v1`,
  });

/** Check if Ollama is available */
async function isOllamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Check if a specific model is available in Ollama */
async function isModelAvailable(modelName: string): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    return (
      data.models?.some((m) => m.name.startsWith(modelName.split(":")[0])) ??
      false
    );
  } catch {
    return false;
  }
}

/** Get model for provider */
function getModel(provider: LLMProvider, modelName?: string) {
  const model = modelName || DEFAULT_MODELS[provider];

  if (provider === "ollama") {
    return createOllamaProvider()(model);
  }
  // AI Gateway - just pass the model string like "anthropic/claude-haiku-4-5"
  // Vercel AI SDK picks it up automatically
  return model as any;
}

// ============================================================================
// Heuristic Extraction (No LLM)
// ============================================================================

/**
 * Normalize a tag string
 */
function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Clean a filename into a proper title
 */
export function cleanTitle(filename: string): string {
  // Remove extension
  let title = filename.replace(/\.(pdf|epub|md|markdown|txt)$/i, "");

  // Remove common URL encoding artifacts
  title = decodeURIComponent(title);

  // Replace separators with spaces
  title = title.replace(/[-_+]+/g, " ");

  // Remove parenthetical content that looks like metadata
  title = title.replace(
    /\([^)]*(?:edition|ed\.|vol\.|volume|isbn)[^)]*\)/gi,
    ""
  );

  // Clean up whitespace
  title = title.replace(/\s+/g, " ").trim();

  // Title case (but preserve acronyms)
  title = title
    .split(" ")
    .map((word) => {
      if (word === word.toUpperCase() && word.length <= 4) return word; // Acronym
      if (word.length <= 2) return word.toLowerCase(); // Articles
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");

  return title;
}

/**
 * Extract author from filename
 */
export function extractAuthor(filename: string): string | undefined {
  for (const pattern of AUTHOR_PATTERNS) {
    const match = filename.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

/**
 * Extract tags from file path
 */
export function extractPathTags(filePath: string, basePath?: string): string[] {
  let path = filePath;

  if (basePath && path.startsWith(basePath)) {
    path = path.slice(basePath.length);
  }

  const segments = path
    .split("/")
    .filter((s) => s && !s.includes("."))
    .filter((s) => s.length >= 2)
    .filter((s) => !IGNORE_PATH_PATTERNS.some((p) => p.test(s)))
    .map(normalizeTag)
    .filter((s) => s.length >= 2);

  return [...new Set(segments)];
}

/**
 * Extract keywords from content using TF-IDF-like scoring
 */
export function extractContentKeywords(
  content: string,
  maxKeywords: number = 5
): string[] {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .filter((w) => !STOP_WORDS.has(w))
    .filter((w) => !/^\d+$/.test(w));

  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  const totalWords = words.length || 1;
  const scored = [...freq.entries()]
    .map(([word, count]) => ({
      word,
      score:
        count *
        (count / totalWords > 0.1 ? 0.5 : 1) *
        Math.min(word.length / 8, 1.5),
    }))
    .sort((a, b) => b.score - a.score);

  return scored
    .slice(0, maxKeywords)
    .map((s) => normalizeTag(s.word))
    .filter((w) => w.length >= 4);
}

/**
 * Extract tags from filename
 */
export function extractFilenameTags(filename: string): string[] {
  const name = filename.replace(/\.(pdf|epub|md|markdown|txt)$/i, "");

  const cleaned = name
    .replace(/[-_+]+/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3)
    .filter((w) => !STOP_WORDS.has(w))
    .filter((w) => !/^\d+$/.test(w))
    .map(normalizeTag)
    .filter((w) => w.length >= 3);

  return [...new Set(words)].slice(0, 3);
}

// ============================================================================
// LLM-based Enrichment
// ============================================================================

/**
 * Parse JSON from LLM response text
 * Handles markdown code blocks, raw JSON, and common formatting issues
 */
function parseJSONFromText(text: string): unknown {
  // Try to extract JSON from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = codeBlockMatch ? codeBlockMatch[1].trim() : text;

  // Try to find JSON object in text
  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in response");
  }

  let cleaned = jsonMatch[0];

  // Fix common LLM JSON issues:
  // - Trailing commas before closing brackets
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  // - Single quotes instead of double quotes
  cleaned = cleaned.replace(/'/g, '"');
  // - Unquoted keys
  cleaned = cleaned.replace(
    /(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g,
    '$1"$2":'
  );

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Last resort: try to extract just the tags array
    const tagsMatch = cleaned.match(/"tags"\s*:\s*\[([\s\S]*?)\]/);
    if (tagsMatch) {
      const tags = tagsMatch[1]
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter((t) => t.length > 0);
      return { tags };
    }
    throw new Error(`Failed to parse JSON: ${e}`);
  }
}

/**
 * Format concepts for LLM prompt
 */
function formatConceptsForPrompt(concepts: TaxonomyConcept[]): string {
  if (concepts.length === 0) {
    return "No taxonomy concepts available yet.";
  }

  const lines = concepts.map((c) => {
    const aliases =
      c.altLabels.length > 0 ? ` (aliases: ${c.altLabels.join(", ")})` : "";
    return `- ${c.id}: ${c.prefLabel}${aliases}`;
  });

  return `Available concepts (use these IDs when applicable):\n${lines.join(
    "\n"
  )}`;
}

/**
 * Use LLM to judge if two concepts are duplicates or distinct
 * More accurate than pure embedding similarity
 *
 * Supports both providers:
 * - gateway: Uses AI Gateway with configured model (e.g., "anthropic/claude-haiku-4-5")
 * - ollama: Uses Ollama with configured model (e.g., "llama3.2")
 */
async function llmJudgeDuplicate(
  proposed: ProposedConcept,
  existing: { id: string; prefLabel: string; definition?: string | null }
): Promise<{ isDuplicate: boolean; available: boolean }> {
  const config = loadConfig();

  const prompt = `You are a taxonomy curator. Determine if these two concepts are essentially the SAME concept (duplicates that should be merged) or DISTINCT concepts that both belong in a knowledge taxonomy.

PROPOSED CONCEPT:
Name: ${proposed.prefLabel}
Definition: ${proposed.definition || "(no definition)"}

EXISTING CONCEPT:
Name: ${existing.prefLabel}
Definition: ${existing.definition || "(no definition)"}

Consider:
- Are they synonyms or alternate names for the same thing? → DUPLICATE
- Are they related but represent different ideas, theories, or domains? → DISTINCT
- Would a subject matter expert consider them separate entries? → DISTINCT

Reply with ONLY one word: DUPLICATE or DISTINCT`;

  if (config.judge.provider === "gateway") {
    // Try AI Gateway
    const gatewayKey = process.env.AI_GATEWAY_API_KEY;
    if (!gatewayKey) {
      console.log(
        "  [AutoTagger] AI_GATEWAY_API_KEY not set, LLM judge unavailable"
      );
      return { isDuplicate: false, available: false };
    }

    try {
      const result = await generateText({
        model: config.judge.model as any,
        prompt,
      });
      const answer = result.text.trim().toUpperCase();
      return { isDuplicate: answer.includes("DUPLICATE"), available: true };
    } catch (e) {
      console.log(`  [AutoTagger] Gateway LLM judge failed: ${e}`);
      return { isDuplicate: false, available: false };
    }
  } else {
    // Use Ollama
    const ollamaHost = config.ollama.host;
    const ollamaModel = config.judge.model;

    try {
      const response = await fetch(`${ollamaHost}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ollamaModel,
          prompt,
          stream: false,
        }),
      });

      if (!response.ok) {
        return { isDuplicate: false, available: false };
      }

      const data = (await response.json()) as { response?: string };
      const answer = (data.response || "").trim().toUpperCase();
      return { isDuplicate: answer.includes("DUPLICATE"), available: true };
    } catch (e) {
      // Ollama not available
      return { isDuplicate: false, available: false };
    }
  }
}

/**
 * Auto-accept novel proposed concepts after deduplication check
 * Uses embedding similarity to find candidates, then LLM to judge duplicates
 *
 * @returns Effect with count of accepted and rejected proposals
 */
function autoAcceptProposals(
  proposals: ProposedConcept[]
): Effect.Effect<
  { accepted: number; rejected: number },
  EnrichmentError,
  TaxonomyService | EmbeddingProvider
> {
  return Effect.gen(function* () {
    if (proposals.length === 0) {
      return { accepted: 0, rejected: 0 };
    }

    const taxonomy = yield* TaxonomyService;
    const embeddingProvider = yield* EmbeddingProvider;

    let accepted = 0;
    let rejected = 0;

    for (const proposal of proposals) {
      // Generate embedding for proposal
      const proposalText = proposal.definition
        ? `${proposal.prefLabel}: ${proposal.definition}`
        : proposal.prefLabel;

      const embedding = yield* embeddingProvider.embed(proposalText);

      // Find similar concepts (lower threshold for LLM review candidates)
      const similar = yield* taxonomy.findSimilarConcepts(embedding, 0.75);

      if (similar.length > 0) {
        // Use LLM to judge if it's actually a duplicate
        const judgeResult = yield* Effect.tryPromise({
          try: () => llmJudgeDuplicate(proposal, similar[0]),
          catch: () => ({ isDuplicate: false, available: false }),
        });

        if (judgeResult.isDuplicate) {
          console.log(
            `  [AutoTagger] Rejected duplicate: "${proposal.prefLabel}" ≈ "${similar[0].prefLabel}"`
          );
          rejected++;
          continue;
        }
      }

      // Novel concept - accept
      yield* taxonomy.addConcept({
        id: proposal.id,
        prefLabel: proposal.prefLabel,
        altLabels: proposal.altLabels,
        definition: proposal.definition,
      });
      yield* taxonomy.storeConceptEmbedding(proposal.id, embedding);

      console.log(
        `  [AutoTagger] Accepted novel concept: ${proposal.id} - "${proposal.prefLabel}"`
      );
      accepted++;
    }

    return { accepted, rejected };
  }).pipe(
    Effect.mapError(
      (e) =>
        new EnrichmentError(
          `Auto-accept failed: ${
            "_tag" in e && (e._tag === "OllamaError" || e._tag === "GatewayError")
              ? e.reason
              : "_tag" in e && e._tag === "TaxonomyError"
              ? e.reason
              : String(e)
          }`,
          e
        )
    )
  );
}

/**
 * Extract RAG context: Find relevant concepts using document content embedding
 *
 * @param content - Document content (first ~2000 chars)
 * @returns Effect with relevant concepts for LLM context
 */
function extractRAGContext(
  content: string
): Effect.Effect<TaxonomyConcept[], EnrichmentError, TaxonomyService | EmbeddingProvider> {
  return Effect.gen(function* () {
    const embeddingProvider = yield* EmbeddingProvider;
    const taxonomy = yield* TaxonomyService;

    // Extract sample (~2000 chars)
    const sample = content.slice(0, 2000);

    // Generate embedding for content
    const embedding = yield* embeddingProvider.embed(sample);

    // Find similar concepts (threshold 0.5 for broader matching)
    const conceptsFromDB = yield* taxonomy.findSimilarConcepts(
      embedding,
      0.5,
      5
    );

    // Convert to TaxonomyConcept interface
    return conceptsFromDB.map((c) => ({
      id: c.id,
      prefLabel: c.prefLabel,
      altLabels: c.altLabels,
    }));
  }).pipe(
    Effect.mapError(
      (e) =>
        new EnrichmentError(
          `RAG context extraction failed: ${
            "_tag" in e && (e._tag === "OllamaError" || e._tag === "GatewayError")
              ? e.reason
              : "_tag" in e && e._tag === "TaxonomyError"
              ? e.reason
              : String(e)
          }`,
          e
        )
    )
  );
}

/**
 * Generate full enrichment using LLM
 * Uses generateText for better compatibility with local models
 */
async function enrichWithLLM(
  filename: string,
  content: string,
  provider: LLMProvider,
  availableConcepts: TaxonomyConcept[] = [],
  model?: string
): Promise<Omit<EnrichmentResult, "provider" | "confidence">> {
  const truncatedContent = content.slice(0, 6000);
  const conceptsList = formatConceptsForPrompt(availableConcepts);

  // For Anthropic, use structured output
  if (provider === "anthropic") {
    const { object } = await generateObject({
      model: getModel(provider, model),
      schema: EnrichmentSchema,
      prompt: `Analyze this document and extract metadata for a personal knowledge library.

Filename: ${filename}

Content (excerpt):
${truncatedContent}

${conceptsList}

Extract:
- title: Clean, properly formatted title
- author: Author name(s) if identifiable
- summary: 2-3 sentences
- documentType: book/paper/tutorial/reference/guide/article/report/presentation/notes/other
- category: Primary category (lowercase-hyphenated)
- tags: 5-10 specific tags (lowercase-hyphenated)
- concepts: Match IDs from the available concepts list above
- proposedConcepts: ONLY if document covers topics truly missing from taxonomy

For proposedConcepts, use SKOS-style short IDs:
- id: "parent/child" format, 2-3 words max (e.g., "education/spaced-repetition", "programming/error-handling")
- prefLabel: 1-3 words (e.g., "Spaced Repetition", "Error Handling")
- definition: One sentence max
Do NOT propose concepts that are variations of existing ones.`,
    });

    return {
      title: object.title,
      author: object.author,
      summary: object.summary,
      documentType: object.documentType,
      category: normalizeTag(object.category),
      tags: object.tags.map(normalizeTag).filter((t) => t.length >= 2),
      concepts: object.concepts,
      proposedConcepts: validateProposedConcepts(object.proposedConcepts),
    };
  }

  // For local models, use generateText with JSON prompt and multishot examples
  const { text } = await generateText({
    model: getModel(provider, model),
    prompt: `<role>You are a librarian cataloging documents for a personal knowledge library.</role>

<taxonomy>
${conceptsList}
</taxonomy>

<instructions>
Analyze the document and return a JSON object with:
- title: Clean, properly formatted title
- author: Author name if identifiable, null otherwise
- summary: 2-3 sentences describing the document's content and significance
- documentType: book|paper|tutorial|reference|guide|article|report|presentation|notes|other
- category: Primary category (lowercase-hyphenated)
- tags: 5-10 specific tags (lowercase-hyphenated, no generic terms like "document" or "pdf")
- concepts: IDs from the taxonomy above that apply to this document
- proposedConcepts: New concepts ONLY if the document covers topics not in the taxonomy
</instructions>

<rules>
- concepts: Use ONLY IDs from the taxonomy list
- proposedConcepts: Use "parent/short-name" format (2-3 words max). Valid parents: programming, education, design, business, meta, psychology, research, writing
- If taxonomy covers the topics, leave proposedConcepts as empty array []
</rules>

<examples>
<example>
<input>
Filename: cognitive_load_theory_sweller.pdf
Content: This paper reviews cognitive load theory, which describes how working memory limitations affect learning...
</input>
<output>{"title":"Cognitive Load Theory","author":"John Sweller","summary":"Reviews cognitive load theory and its implications for instructional design. A foundational paper in educational psychology.","documentType":"paper","category":"education","tags":["cognitive-load","working-memory","instructional-design","learning-theory"],"concepts":["education/cognitive-load","education/learning-science"],"proposedConcepts":[]}</output>
</example>

<example>
<input>
Filename: react_server_components.pdf
Content: React Server Components allow rendering on the server, reducing client bundle size...
</input>
<output>{"title":"React Server Components","author":null,"summary":"Technical guide to React Server Components architecture and implementation patterns. Covers streaming, data fetching, and bundle optimization.","documentType":"tutorial","category":"programming","tags":["react","server-components","performance","streaming","bundle-size"],"concepts":["programming/react"],"proposedConcepts":[{"id":"programming/server-components","prefLabel":"Server Components","definition":"UI components rendered on the server to reduce client bundle size."}]}</output>
</example>

<example>
<input>
Filename: bootstrapping_saas_patio11.pdf
Content: Patrick McKenzie discusses strategies for bootstrapping software businesses without venture capital...
</input>
<output>{"title":"Bootstrapping SaaS Businesses","author":"Patrick McKenzie","summary":"Strategies for building profitable software businesses without external funding. Covers pricing, marketing, and sustainable growth.","documentType":"article","category":"business","tags":["bootstrapping","saas","pricing","indie-hacking","profitability"],"concepts":["business/bootstrapping","business/marketing"],"proposedConcepts":[]}</output>
</example>

<example>
<input>
Filename: information_architecture_rosenfeld.pdf
Content: This book covers the principles of organizing information for websites and digital products...
</input>
<output>{"title":"Information Architecture for the Web","author":"Louis Rosenfeld","summary":"Comprehensive guide to organizing and structuring information in digital products. Covers navigation, labeling, and search systems.","documentType":"book","category":"design","tags":["information-architecture","ux","navigation","taxonomy","findability"],"concepts":["design/information-architecture"],"proposedConcepts":[]}</output>
</example>

<example>
<input>
Filename: spaced_repetition_memory.pdf
Content: This research examines how spaced repetition systems improve long-term retention compared to massed practice...
</input>
<output>{"title":"Spaced Repetition and Memory","author":null,"summary":"Research on spaced repetition learning techniques and their effectiveness for long-term retention. Compares to traditional study methods.","documentType":"paper","category":"education","tags":["spaced-repetition","memory","retention","learning-techniques","flashcards"],"concepts":["education/learning-science"],"proposedConcepts":[{"id":"education/spaced-repetition","prefLabel":"Spaced Repetition","definition":"Learning technique using increasing intervals between reviews to optimize retention."}]}</output>
</example>
</examples>

<document>
Filename: ${filename}
Content: ${truncatedContent}
</document>

Return ONLY the JSON object:`,
  });

  const parsed = parseJSONFromText(text) as {
    title?: string;
    author?: string | null;
    summary?: string;
    documentType?: string;
    category?: string;
    tags?: string[];
    concepts?: string[];
    proposedConcepts?: ProposedConcept[];
  };

  // Debug: log raw proposed concepts before validation
  if (parsed.proposedConcepts && parsed.proposedConcepts.length > 0) {
    console.log(
      `  [AutoTagger] Raw proposedConcepts: ${JSON.stringify(
        parsed.proposedConcepts
      )}`
    );
  }

  const validatedConcepts = validateProposedConcepts(parsed.proposedConcepts);

  return {
    title: parsed.title || cleanTitle(filename),
    author: parsed.author || undefined,
    summary: parsed.summary || "",
    documentType: (parsed.documentType as DocumentType) || "other",
    category: normalizeTag(parsed.category || "uncategorized"),
    tags: (parsed.tags || []).map(normalizeTag).filter((t) => t.length >= 2),
    concepts: parsed.concepts || [],
    proposedConcepts: validatedConcepts,
  };
}

/**
 * Validate proposed concept ID format
 * Valid: "parent/short-name" with 2-4 words total, lowercase, hyphenated
 * Invalid: titles, sentences, "new/concept", missing slash, spaces
 */
function isValidConceptId(id: string): boolean {
  // Must have exactly one slash
  if (!id.includes("/") || id.split("/").length !== 2) return false;

  const [parent, child] = id.split("/");

  // Parent must be a known category (1 word, lowercase)
  const validParents = [
    "programming",
    "education",
    "design",
    "business",
    "meta",
    "psychology",
    "research",
    "writing",
  ];
  if (!validParents.includes(parent)) return false;

  // Child must be short (1-3 words hyphenated, no spaces)
  if (child.includes(" ")) return false;
  if (child.length > 30) return false; // Too long
  if (child === "concept" || child === "new") return false; // Generic garbage

  // Must be lowercase
  if (id !== id.toLowerCase()) return false;

  // Count words (hyphen-separated)
  const wordCount = child.split("-").length;
  if (wordCount > 4) return false; // Too many words

  return true;
}

/**
 * Filter and validate proposed concepts from LLM output
 * EXPORTED for testing
 */
export function validateProposedConcepts(
  concepts: ProposedConcept[] | undefined
): ProposedConcept[] {
  if (!concepts || !Array.isArray(concepts)) return [];

  return concepts.filter((c) => {
    if (!c.id || !c.prefLabel) return false;
    if (!isValidConceptId(c.id)) {
      console.log(`  [AutoTagger] Rejected invalid concept ID: "${c.id}"`);
      return false;
    }
    // prefLabel should be short (1-4 words)
    const labelWords = c.prefLabel.trim().split(/\s+/).length;
    if (labelWords > 5) {
      console.log(
        `  [AutoTagger] Rejected verbose prefLabel: "${c.prefLabel}"`
      );
      return false;
    }
    return true;
  });
}

/**
 * Generate tags only using LLM (lighter weight)
 */
async function tagWithLLM(
  filename: string,
  content: string,
  provider: LLMProvider,
  model?: string
): Promise<{ tags: string[]; category?: string; author?: string }> {
  const truncatedContent = content.slice(0, 4000);

  // For Anthropic, use structured output
  if (provider === "anthropic") {
    const { object } = await generateObject({
      model: getModel(provider, model),
      schema: TagSchema,
      prompt: `Generate tags for this document. Filename: ${filename}\n\nContent:\n${truncatedContent}`,
    });

    return {
      tags: object.tags.map(normalizeTag).filter((t) => t.length >= 2),
      category: object.category ? normalizeTag(object.category) : undefined,
      author: object.author,
    };
  }

  // For local models, use generateText with JSON prompt
  const { text } = await generateText({
    model: getModel(provider, model),
    prompt: `Generate tags for this document. Return ONLY a JSON object.

Filename: ${filename}

Content (excerpt):
${truncatedContent}

Return JSON:
{
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "category": "primary-category",
  "author": "Author Name or null"
}

Rules:
- 3-7 specific tags, lowercase, hyphenated (e.g., "machine-learning")
- Focus on topics, technologies, domain
- Avoid generic tags like "book", "document"`,
  });

  const parsed = parseJSONFromText(text) as {
    tags?: string[];
    category?: string;
    author?: string | null;
  };

  return {
    tags: (parsed.tags || []).map(normalizeTag).filter((t) => t.length >= 2),
    category: parsed.category ? normalizeTag(parsed.category) : undefined,
    author: parsed.author || undefined,
  };
}

// ============================================================================
// Service Definition
// ============================================================================

/** Error for enrichment failures */
export class EnrichmentError {
  readonly _tag = "EnrichmentError";
  constructor(readonly message: string, readonly cause?: unknown) {}
}

/**
 * AutoTagger service interface
 *
 * NOTE: enrich() now requires TaxonomyService and EmbeddingProvider for auto-accept and RAG context
 */
export interface AutoTagger {
  /**
   * Full document enrichment (title, summary, tags, etc.)
   * Uses local LLM first, falls back to Anthropic
   *
   * Requires: TaxonomyService and EmbeddingProvider for auto-accept and RAG context
   */
  readonly enrich: (
    filePath: string,
    content: string,
    options?: EnrichmentOptions
  ) => Effect.Effect<
    EnrichmentResult,
    EnrichmentError,
    TaxonomyService | EmbeddingProvider
  >;

  /**
   * Lightweight tagging only
   * Combines heuristics with optional LLM enhancement
   */
  readonly generateTags: (
    filePath: string,
    content?: string,
    options?: EnrichmentOptions
  ) => Effect.Effect<TagResult, EnrichmentError>;

  /**
   * Check if local LLM (Ollama) is available
   */
  readonly isLocalAvailable: () => Effect.Effect<boolean>;
}

export const AutoTagger = Context.GenericTag<AutoTagger>("AutoTagger");

/**
 * Create the AutoTagger service
 * Requires TaxonomyService and Ollama for auto-accept and RAG context
 */
export const AutoTaggerLive = Layer.effect(
  AutoTagger,
  Effect.gen(function* () {
    return AutoTagger.of({
      enrich: (
        filePath: string,
        content: string,
        options?: EnrichmentOptions
      ) =>
        Effect.gen(function* () {
          const filename = filePath.split("/").pop() || "";
          const opts = options || {};
          let availableConcepts = opts.availableConcepts || [];

          // If heuristics only, build from extraction
          if (opts.heuristicsOnly) {
            const pathTags = extractPathTags(filePath, opts.basePath);
            const filenameTags = extractFilenameTags(filename);
            const contentTags = extractContentKeywords(content, 5);

            return {
              title: cleanTitle(filename),
              author: extractAuthor(filename),
              summary:
                content.slice(0, 200).replace(/\s+/g, " ").trim() + "...",
              documentType: "other" as DocumentType,
              category: pathTags[0] || "uncategorized",
              tags: [
                ...new Set([...pathTags, ...filenameTags, ...contentTags]),
              ].slice(0, 10),
              concepts: [],
              confidence: 0.3,
              provider: "ollama" as LLMProvider, // Placeholder
            };
          }

          // STEP 1: Extract RAG context (relevant concepts from taxonomy)
          // This helps LLM match existing concepts instead of proposing duplicates
          const ragConcepts = yield* extractRAGContext(content).pipe(
            Effect.catchAll(() =>
              // If RAG extraction fails, continue with empty list
              Effect.succeed([])
            )
          );

          // Merge RAG concepts with provided concepts (RAG first for priority)
          const conceptsForPrompt: TaxonomyConcept[] = [
            ...ragConcepts,
            ...availableConcepts.filter(
              (c) => !ragConcepts.some((r) => r.id === c.id)
            ),
          ];

          console.log(
            `  [AutoTagger] RAG context: ${ragConcepts.length} relevant concepts found`
          );

          // Load config for provider/model defaults
          const config = loadConfig();

          // Use options or fallback to config (map "gateway" to "anthropic" for LLMProvider type)
          let provider: LLMProvider =
            opts.provider ||
            (config.enrichment.provider === "gateway" ? "anthropic" : "ollama");
          let model: string | undefined = opts.model || config.enrichment.model;

          if (provider === "ollama") {
            const available = yield* Effect.promise(() => isOllamaAvailable());
            if (!available) {
              console.warn(
                "Ollama not available, falling back to Anthropic/Gateway"
              );
              provider = "anthropic";
              model =
                config.enrichment.provider === "gateway"
                  ? config.enrichment.model
                  : DEFAULT_MODELS.anthropic;
            } else if (!model) {
              // Check if default model is available
              const modelAvailable = yield* Effect.promise(() =>
                isModelAvailable(DEFAULT_MODELS.ollama)
              );
              if (!modelAvailable) {
                console.warn(
                  `Model ${DEFAULT_MODELS.ollama} not available, falling back to Anthropic/Gateway`
                );
                provider = "anthropic";
                model =
                  config.enrichment.provider === "gateway"
                    ? config.enrichment.model
                    : DEFAULT_MODELS.anthropic;
              }
            }
          }

          // STEP 2: Run enrichment with RAG-enhanced concept list
          // If LLM fails (schema mismatch, JSON parse error, etc.), fall back to heuristics
          const result = yield* Effect.tryPromise({
            try: () =>
              enrichWithLLM(
                filename,
                content,
                provider,
                conceptsForPrompt,
                model
              ),
            catch: (error) =>
              new EnrichmentError(
                `Enrichment failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                error
              ),
          }).pipe(
            Effect.catchAll((error) => {
              // Log the actual error for debugging
              console.warn(
                `  [AutoTagger] LLM enrichment failed: ${error.message}`
              );
              console.warn(`  [AutoTagger] Falling back to heuristics`);

              // Fall back to heuristics instead of failing
              const pathTags = extractPathTags(filePath, opts.basePath);
              const filenameTags = extractFilenameTags(filename);
              const contentTags = extractContentKeywords(content, 5);

              return Effect.succeed({
                title: cleanTitle(filename),
                author: extractAuthor(filename),
                summary:
                  content.slice(0, 200).replace(/\s+/g, " ").trim() + "...",
                documentType: "other" as DocumentType,
                category: pathTags[0] || "uncategorized",
                tags: [
                  ...new Set([...pathTags, ...filenameTags, ...contentTags]),
                ].slice(0, 10),
                concepts: [],
                proposedConcepts: undefined,
              });
            })
          );

          // STEP 3: Auto-accept novel proposed concepts
          const validatedProposals = result.proposedConcepts || [];
          if (validatedProposals.length > 0) {
            console.log(
              `  [AutoTagger] Processing ${validatedProposals.length} proposed concepts...`
            );

            const { accepted, rejected } = yield* autoAcceptProposals(
              validatedProposals
            ).pipe(
              Effect.catchAll((error) => {
                // If auto-accept fails, log and continue (don't fail enrichment)
                console.warn(
                  `  [AutoTagger] Auto-accept failed: ${error.message}`
                );
                return Effect.succeed({ accepted: 0, rejected: 0 });
              })
            );

            console.log(
              `  [AutoTagger] Auto-accept results: ${accepted} accepted, ${rejected} rejected`
            );
          }

          return {
            ...result,
            confidence: provider === "ollama" ? 0.7 : 0.9,
            provider,
          };
        }),

      generateTags: (
        filePath: string,
        content?: string,
        options?: EnrichmentOptions
      ) =>
        Effect.gen(function* () {
          const filename = filePath.split("/").pop() || "";
          const opts = options || {};

          // Always extract heuristic tags
          const pathTags = extractPathTags(filePath, opts.basePath);
          const filenameTags = extractFilenameTags(filename);
          const contentTags = content ? extractContentKeywords(content, 5) : [];
          const author = extractAuthor(filename);

          let llmTags: string[] = [];
          let category: string | undefined;
          let llmAuthor: string | undefined;

          // Add LLM tags if not heuristics-only and we have content
          if (!opts.heuristicsOnly && content) {
            // Load config for provider/model defaults
            const config = loadConfig();

            let provider: LLMProvider =
              opts.provider ||
              (config.enrichment.provider === "gateway"
                ? "anthropic"
                : "ollama");
            let model: string | undefined =
              opts.model || config.enrichment.model;

            if (provider === "ollama") {
              const available = yield* Effect.promise(() =>
                isOllamaAvailable()
              );
              if (!available) {
                provider = "anthropic";
                model =
                  config.enrichment.provider === "gateway"
                    ? config.enrichment.model
                    : DEFAULT_MODELS.anthropic;
              }
            }

            const llmResult = yield* Effect.tryPromise({
              try: () => tagWithLLM(filename, content, provider, model),
              catch: (error) =>
                new EnrichmentError(
                  `LLM tagging failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  error
                ),
            }).pipe(
              Effect.catchAll((error) => {
                console.warn(
                  "LLM tagging failed, using heuristics only:",
                  error.message
                );
                return Effect.succeed({
                  tags: [],
                  category: undefined,
                  author: undefined,
                });
              })
            );

            llmTags = llmResult.tags;
            category = llmResult.category;
            llmAuthor = llmResult.author;
          }

          // Combine all tags (LLM first for priority)
          const allTags = [
            ...new Set([
              ...llmTags,
              ...pathTags,
              ...filenameTags,
              ...contentTags,
            ]),
          ]
            .filter((t) => t.length >= 2)
            .slice(0, 10);

          return {
            pathTags,
            filenameTags,
            contentTags,
            llmTags,
            allTags,
            author: llmAuthor || author,
            category: category || pathTags[0],
          };
        }),

      isLocalAvailable: () => Effect.promise(() => isOllamaAvailable()),
    });
  })
);
