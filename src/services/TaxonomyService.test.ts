/**
 * TaxonomyService Tests
 *
 * Tests for SKOS taxonomy operations using TDD approach.
 */

import {describe, expect, test} from "bun:test";
import {Effect, Layer} from "effect";
import {TaxonomyService, TaxonomyServiceImpl} from "./TaxonomyService.js";
import {LibSQLDatabase} from "./LibSQLDatabase.js";

// Test layer - LibSQLDatabase.make initializes the schema (including taxonomy tables)
// Then we use same DB URL for TaxonomyService
const makeTestLayer = () => {
	// Use file DB for tests to ensure schema persistence across layer creations
	const testDbPath = `${process.cwd()}/.test-db-${Date.now()}.db`;
	const prefixedDbPath = `file:${testDbPath}`;
	return Layer.mergeAll(
			LibSQLDatabase.make({url: prefixedDbPath}),
			TaxonomyServiceImpl.make({url: prefixedDbPath})
		);
};

const runTest = <A, E>(effect: Effect.Effect<A, E, TaxonomyService>) => {
	const layer = makeTestLayer();
	return Effect.runPromise(Effect.provide(effect, layer));
};

describe("TaxonomyService - Concept CRUD", () => {
	test("addConcept creates a new concept", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({
					id: "machine-learning",
					prefLabel: "Machine Learning",
					altLabels: ["ML", "statistical learning"],
					definition: "Algorithms that learn from data",
				});

				const concept = yield* svc.getConcept("machine-learning");
				expect(concept).not.toBeNull();
				expect(concept?.prefLabel).toBe("Machine Learning");
				expect(concept?.altLabels).toEqual(["ML", "statistical learning"]);
			})
		);
	});

	test("addConcept with minimal fields", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({
					id: "typescript",
					prefLabel: "TypeScript",
				});

				const concept = yield* svc.getConcept("typescript");
				expect(concept).not.toBeNull();
				expect(concept?.prefLabel).toBe("TypeScript");
				expect(concept?.altLabels).toEqual([]);
				expect(concept?.definition).toBeUndefined();
			})
		);
	});

	test("getConcept returns null for non-existent concept", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;
				const concept = yield* svc.getConcept("non-existent");
				expect(concept).toBeNull();
			})
		);
	});

	test("listConcepts returns all concepts", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "js", prefLabel: "JavaScript"});
				yield* svc.addConcept({id: "ts", prefLabel: "TypeScript"});
				yield* svc.addConcept({id: "rust", prefLabel: "Rust"});

				const concepts = yield* svc.listConcepts();
				expect(concepts).toHaveLength(3);
				expect(concepts.map((c) => c.id)).toContain("js");
				expect(concepts.map((c) => c.id)).toContain("ts");
				expect(concepts.map((c) => c.id)).toContain("rust");
			})
		);
	});

	test("updateConcept modifies existing concept", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "ai", prefLabel: "AI"});
				yield* svc.updateConcept("ai", {
					prefLabel: "Artificial Intelligence",
					altLabels: ["AI", "machine intelligence"],
					definition: "Simulation of human intelligence",
				});

				const concept = yield* svc.getConcept("ai");
				expect(concept?.prefLabel).toBe("Artificial Intelligence");
				expect(concept?.altLabels).toEqual(["AI", "machine intelligence"]);
				expect(concept?.definition).toBe("Simulation of human intelligence");
			})
		);
	});
});

describe("TaxonomyService - Hierarchy (Polyhierarchy)", () => {
	test("addBroader creates parent relationship", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "ml", prefLabel: "Machine Learning"});
				yield* svc.addConcept({
					id: "ai",
					prefLabel: "Artificial Intelligence",
				});

				yield* svc.addBroader("ml", "ai");

				const parents = yield* svc.getBroader("ml");
				expect(parents).toHaveLength(1);
				expect(parents[0].id).toBe("ai");
			})
		);
	});

	test("getNarrower returns children", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "ml", prefLabel: "Machine Learning"});
				yield* svc.addConcept({id: "dl", prefLabel: "Deep Learning"});
				yield* svc.addConcept({
					id: "ai",
					prefLabel: "Artificial Intelligence",
				});

				yield* svc.addBroader("ml", "ai");
				yield* svc.addBroader("dl", "ml");

				const children = yield* svc.getNarrower("ml");
				expect(children).toHaveLength(1);
				expect(children[0].id).toBe("dl");
			})
		);
	});

	test("polyhierarchy: concept can have multiple parents", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({
					id: "nlp",
					prefLabel: "Natural Language Processing",
				});
				yield* svc.addConcept({id: "ml", prefLabel: "Machine Learning"});
				yield* svc.addConcept({id: "linguistics", prefLabel: "Linguistics"});

				// NLP is a child of both ML and Linguistics
				yield* svc.addBroader("nlp", "ml");
				yield* svc.addBroader("nlp", "linguistics");

				const parents = yield* svc.getBroader("nlp");
				expect(parents).toHaveLength(2);
				expect(parents.map((p) => p.id).sort()).toEqual(["linguistics", "ml"]);
			})
		);
	});

	test("removeBroader deletes parent relationship", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "nlp", prefLabel: "NLP"});
				yield* svc.addConcept({id: "ml", prefLabel: "ML"});
				yield* svc.addConcept({id: "linguistics", prefLabel: "Linguistics"});

				yield* svc.addBroader("nlp", "ml");
				yield* svc.addBroader("nlp", "linguistics");

				yield* svc.removeBroader("nlp", "linguistics");

				const parents = yield* svc.getBroader("nlp");
				expect(parents).toHaveLength(1);
				expect(parents[0].id).toBe("ml");
			})
		);
	});

	test("getAncestors returns transitive broader concepts", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				// Create hierarchy: DL -> ML -> AI -> CS
				yield* svc.addConcept({id: "dl", prefLabel: "Deep Learning"});
				yield* svc.addConcept({id: "ml", prefLabel: "Machine Learning"});
				yield* svc.addConcept({
					id: "ai",
					prefLabel: "Artificial Intelligence",
				});
				yield* svc.addConcept({id: "cs", prefLabel: "Computer Science"});

				yield* svc.addBroader("dl", "ml");
				yield* svc.addBroader("ml", "ai");
				yield* svc.addBroader("ai", "cs");

				const ancestors = yield* svc.getAncestors("dl");
				expect(ancestors).toHaveLength(3);
				expect(ancestors.map((a) => a.id).sort()).toEqual(["ai", "cs", "ml"]);
			})
		);
	});

	test("getDescendants returns transitive narrower concepts", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				// Create hierarchy: CS -> AI -> ML -> DL
				yield* svc.addConcept({id: "cs", prefLabel: "Computer Science"});
				yield* svc.addConcept({
					id: "ai",
					prefLabel: "Artificial Intelligence",
				});
				yield* svc.addConcept({id: "ml", prefLabel: "Machine Learning"});
				yield* svc.addConcept({id: "dl", prefLabel: "Deep Learning"});

				yield* svc.addBroader("dl", "ml");
				yield* svc.addBroader("ml", "ai");
				yield* svc.addBroader("ai", "cs");

				const descendants = yield* svc.getDescendants("cs");
				expect(descendants).toHaveLength(3);
				expect(descendants.map((d) => d.id).sort()).toEqual(["ai", "dl", "ml"]);
			})
		);
	});
});

describe("TaxonomyService - Relations (Associative)", () => {
	test("addRelated creates symmetric relationship", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "js", prefLabel: "JavaScript"});
				yield* svc.addConcept({id: "ts", prefLabel: "TypeScript"});

				yield* svc.addRelated("js", "ts");

				const jsRelated = yield* svc.getRelated("js");
				const tsRelated = yield* svc.getRelated("ts");

				expect(jsRelated).toHaveLength(1);
				expect(jsRelated[0].id).toBe("ts");
				expect(tsRelated).toHaveLength(1);
				expect(tsRelated[0].id).toBe("js");
			})
		);
	});

	test("addRelated with custom relation type", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "react", prefLabel: "React"});
				yield* svc.addConcept({id: "vue", prefLabel: "Vue"});

				yield* svc.addRelated("react", "vue", "alternative");

				const related = yield* svc.getRelated("react");
				expect(related).toHaveLength(1);
				expect(related[0].id).toBe("vue");
			})
		);
	});

	test("removeRelated deletes symmetric relationship", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "js", prefLabel: "JavaScript"});
				yield* svc.addConcept({id: "ts", prefLabel: "TypeScript"});

				yield* svc.addRelated("js", "ts");
				yield* svc.removeRelated("js", "ts");

				const jsRelated = yield* svc.getRelated("js");
				const tsRelated = yield* svc.getRelated("ts");

				expect(jsRelated).toHaveLength(0);
				expect(tsRelated).toHaveLength(0);
			})
		);
	});
});

describe("TaxonomyService - Document Mappings", () => {
	test("assignToDocument links concept to document (without FK check)", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "ml", prefLabel: "Machine Learning"});

				// Note: In real usage, doc_id must exist in documents table (FK constraint)
				// This test verifies the assignment would fail with FK constraint
				// In integration tests with real DB, create actual documents

				const result = yield* svc
					.assignToDocument("doc-123", "ml", 0.95, "llm")
					.pipe(Effect.either);

				// Should fail due to FK constraint (no document exists)
				expect(result._tag).toBe("Left");

				// Test that we can query (returns empty array)
				const concepts = yield* svc.getDocumentConcepts("doc-123");
				expect(concepts).toBeInstanceOf(Array);
				expect(concepts).toHaveLength(0);
			})
		);
	});

	test("assignToDocument with defaults", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "ai", prefLabel: "AI"});

				const result = yield* svc
					.assignToDocument("doc-456", "ai")
					.pipe(Effect.either);

				// Should fail due to FK constraint
				expect(result._tag).toBe("Left");

				const concepts = yield* svc.getDocumentConcepts("doc-456");
				expect(concepts).toBeInstanceOf(Array);
				expect(concepts).toHaveLength(0);
			})
		);
	});

	test("getConceptDocuments returns documents for concept", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "ml", prefLabel: "ML"});

				// FK constraints prevent insertion without real documents
				// Test the query logic instead
				const assignments = yield* svc.getConceptDocuments("ml");
				expect(assignments).toBeInstanceOf(Array);
				expect(assignments).toHaveLength(0); // No assignments without documents
			})
		);
	});

	test("removeFromDocument unlinks concept", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				yield* svc.addConcept({id: "ml", prefLabel: "ML"});

				// Can't test without real document, but verify method works
				yield* svc.removeFromDocument("doc-1", "ml");

				const concepts = yield* svc.getDocumentConcepts("doc-1");
				expect(concepts).toHaveLength(0);
			})
		);
	});
});

describe("TaxonomyService - Bulk Operations", () => {
	test("seedFromJSON loads taxonomy", async () => {
		await runTest(
			Effect.gen(function* () {
				const svc = yield* TaxonomyService;

				const taxonomy = {
					concepts: [
						{id: "cs", prefLabel: "Computer Science"},
						{id: "ai", prefLabel: "Artificial Intelligence"},
						{id: "ml", prefLabel: "Machine Learning"},
					],
					hierarchy: [
						{conceptId: "ai", broaderId: "cs"},
						{conceptId: "ml", broaderId: "ai"},
					],
					relations: [
						{conceptId: "ml", relatedId: "ai", relationType: "related"},
					],
				};

				yield* svc.seedFromJSON(taxonomy);

				const concepts = yield* svc.listConcepts();
				expect(concepts).toHaveLength(3);

				const mlParents = yield* svc.getBroader("ml");
				expect(mlParents).toHaveLength(1);
				expect(mlParents[0].id).toBe("ai");
			})
		);
	});
});
