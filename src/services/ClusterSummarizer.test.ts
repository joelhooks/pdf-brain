import { describe, it, expect, mock } from "bun:test";
import { Effect, Layer } from "effect";
import {
  ClusterSummarizerService,
  ClusterSummarizerImpl,
  type ClusterSummary,
} from "./ClusterSummarizer.js";

// Mock the AI SDK
const mockGenerateObject = mock(() =>
  Promise.resolve({
    object: {
      summary:
        "This cluster explores React hooks, focusing on useState and useEffect patterns, along with best practices for creating custom hooks.",
      keyTopics: ["React hooks", "useState", "useEffect", "custom hooks"],
      representativeQuote: "React hooks enable state in functional components",
    },
  })
);

mock.module("ai", () => ({
  generateObject: mockGenerateObject,
}));

describe("ClusterSummarizerService - LLM Abstractive Summarization", () => {
  it("should generate LLM-based abstractive summary with key topics", async () => {
    const chunks = [
      {
        id: "1",
        content:
          "React hooks enable state in functional components. This revolutionary feature changed how we write React components.",
      },
      {
        id: "2",
        content:
          "useState and useEffect are the most common hooks. They handle state and side effects respectively.",
      },
      {
        id: "3",
        content:
          "Custom hooks allow reusable stateful logic. You can extract component logic into reusable functions.",
      },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterSummarizerService;
        return yield* service.summarize(chunks, { clusterId: 1 });
      }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
    );

    expect(result.clusterId).toBe(1);
    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(20);
    expect(result.chunkCount).toBe(3);

    // LLM-based summary should have key topics
    expect(result.keyTopics).toBeDefined();
    expect(result.keyTopics!.length).toBeGreaterThan(0);
    expect(result.keyTopics).toContain("React hooks");

    // Representative quote is optional
    if (result.representativeQuote) {
      expect(result.representativeQuote.length).toBeGreaterThan(0);
    }
  });

  it("should include representative quote when LLM provides one", async () => {
    mockGenerateObject.mockImplementationOnce(() =>
      Promise.resolve({
        object: {
          summary:
            "Comprehensive guide to TypeScript generics and type inference.",
          keyTopics: ["TypeScript", "generics", "type inference"],
          representativeQuote:
            "Generics provide a way to make components work with any data type",
        },
      })
    );

    const chunks = [
      {
        id: "1",
        content:
          "Generics provide a way to make components work with any data type. They are fundamental to TypeScript.",
      },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterSummarizerService;
        return yield* service.summarize(chunks, { clusterId: 2 });
      }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
    );

    expect(result.representativeQuote).toBeDefined();
    expect(result.representativeQuote).toBe(
      "Generics provide a way to make components work with any data type"
    );
  });

  it("should handle empty chunks array with fallback", async () => {
    const chunks: Array<{ id: string; content: string }> = [];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterSummarizerService;
        return yield* service.summarize(chunks, { clusterId: 2 });
      }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
    );

    expect(result.clusterId).toBe(2);
    expect(result.chunkCount).toBe(0);
    expect(result.summary).toBeDefined();
    expect(result.summary).toBe("Empty cluster with no documents.");
  });

  it("should limit chunks based on maxChunks option", async () => {
    const chunks = [
      {
        id: "1",
        content: "First chunk about React hooks and their usage patterns.",
      },
      { id: "2", content: "Second chunk about useState for state management." },
      { id: "3", content: "Third chunk about useEffect for side effects." },
      { id: "4", content: "Fourth chunk about useContext for prop drilling." },
      { id: "5", content: "Fifth chunk about custom hooks for reusability." },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterSummarizerService;
        return yield* service.summarize(chunks, {
          clusterId: 3,
          maxChunks: 3,
        });
      }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
    );

    expect(result.clusterId).toBe(3);
    expect(result.chunkCount).toBe(5); // Total count, not limited
  });

  it("should fall back to extractive summarization when LLM fails", async () => {
    // Mock LLM failure
    mockGenerateObject.mockImplementationOnce(() =>
      Promise.reject(new Error("API unavailable"))
    );

    const chunks = [
      {
        id: "1",
        content:
          "React hooks enable state in functional components. This is important.",
      },
      {
        id: "2",
        content: "useState is the most basic hook. It manages component state.",
      },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterSummarizerService;
        return yield* service.summarize(chunks, { clusterId: 4 });
      }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
    );

    expect(result.clusterId).toBe(4);
    expect(result.summary).toBeDefined();
    // Extractive fallback should still produce a summary
    expect(result.summary.length).toBeGreaterThan(10);
    // No key topics in extractive mode
    expect(result.keyTopics).toBeUndefined();
  });

  it("should use claude-haiku-4-5 model via AI SDK", async () => {
    const chunks = [
      { id: "1", content: "Test content for model verification." },
    ];

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterSummarizerService;
        return yield* service.summarize(chunks, { clusterId: 5 });
      }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
    );

    // Verify generateObject was called with correct model
    expect(mockGenerateObject).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = mockGenerateObject.mock.calls as any[];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][0]?.model).toBe(
      "anthropic/claude-haiku-4-5"
    );
  });
});
