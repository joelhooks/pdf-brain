import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import {
  ClusterConceptMapperService,
  ClusterConceptMapperImpl,
} from "./ClusterConceptMapper.js";

describe("ClusterConceptMapperService", () => {
  it("should map cluster to existing concept when similarity is high", async () => {
    const cluster = {
      id: 1,
      summary: "React hooks and state management",
      centroid: [0.1, 0.2, 0.3],
    };

    const concepts = [
      {
        id: "programming/react-hooks",
        label: "React Hooks",
        embedding: [0.1, 0.2, 0.3],
      },
      { id: "programming/vue", label: "Vue.js", embedding: [0.9, 0.8, 0.7] },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterConceptMapperService;
        return yield* service.mapCluster(cluster, concepts, { threshold: 0.8 });
      }).pipe(Effect.provide(ClusterConceptMapperImpl.Default))
    );

    expect(result.matched).toBe(true);
    expect(result.conceptId).toBe("programming/react-hooks");
  });

  it("should suggest new concept when no match found", async () => {
    const cluster = {
      id: 2,
      summary: "Quantum computing algorithms",
      centroid: [1.0, 0.0, 0.0],
    };

    const concepts = [
      { id: "programming/react", label: "React", embedding: [0.0, 1.0, 0.0] },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterConceptMapperService;
        return yield* service.mapCluster(cluster, concepts, { threshold: 0.8 });
      }).pipe(Effect.provide(ClusterConceptMapperImpl.Default))
    );

    expect(result.matched).toBe(false);
    expect(result.suggestedLabel).toBeDefined();
  });
});
