/**
 * Tests for unified search result types
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import {
  EntityType,
  ConceptSearchResult,
  DocumentSearchResult,
  UnifiedSearchResult,
  SearchResult,
  SearchOptions,
  LibraryConfig,
  loadConfig,
  saveConfig,
} from "./types";

describe("Unified Search Types", () => {
  describe("EntityType", () => {
    test("should accept 'document' literal", () => {
      const entityType: EntityType = "document";
      expect(entityType).toBe("document");
    });

    test("should accept 'concept' literal", () => {
      const entityType: EntityType = "concept";
      expect(entityType).toBe("concept");
    });
  });

  describe("DocumentSearchResult", () => {
    test("should create valid document search result", () => {
      const result = new DocumentSearchResult({
        docId: "doc-123",
        title: "Test Document",
        page: 1,
        chunkIndex: 0,
        content: "Test content",
        score: 0.95,
        matchType: "vector",
        entityType: "document",
      });

      expect(result.entityType).toBe("document");
      expect(result.docId).toBe("doc-123");
      expect(result.score).toBe(0.95);
    });

    test("should support optional expanded content", () => {
      const result = new DocumentSearchResult({
        docId: "doc-123",
        title: "Test Document",
        page: 1,
        chunkIndex: 0,
        content: "Test content",
        score: 0.95,
        matchType: "vector",
        entityType: "document",
        expandedContent: "Expanded test content",
        expandedRange: { start: 0, end: 2 },
      });

      expect(result.expandedContent).toBe("Expanded test content");
      expect(result.expandedRange).toEqual({ start: 0, end: 2 });
    });
  });

  describe("ConceptSearchResult", () => {
    test("should create valid concept search result", () => {
      const result = new ConceptSearchResult({
        conceptId: "concept-456",
        prefLabel: "Machine Learning",
        definition: "A subset of artificial intelligence...",
        score: 0.88,
        entityType: "concept",
      });

      expect(result.entityType).toBe("concept");
      expect(result.conceptId).toBe("concept-456");
      expect(result.prefLabel).toBe("Machine Learning");
      expect(result.score).toBe(0.88);
    });
  });

  describe("UnifiedSearchResult", () => {
    test("should accept DocumentSearchResult", () => {
      const docResult: UnifiedSearchResult = new DocumentSearchResult({
        docId: "doc-123",
        title: "Test Document",
        page: 1,
        chunkIndex: 0,
        content: "Test content",
        score: 0.95,
        matchType: "vector",
        entityType: "document",
      });

      expect(docResult.entityType).toBe("document");
    });

    test("should accept ConceptSearchResult", () => {
      const conceptResult: UnifiedSearchResult = new ConceptSearchResult({
        conceptId: "concept-456",
        prefLabel: "Machine Learning",
        definition: "A subset of artificial intelligence...",
        score: 0.88,
        entityType: "concept",
      });

      expect(conceptResult.entityType).toBe("concept");
    });

    test("should discriminate by entityType", () => {
      const results: UnifiedSearchResult[] = [
        new DocumentSearchResult({
          docId: "doc-123",
          title: "Test Document",
          page: 1,
          chunkIndex: 0,
          content: "Test content",
          score: 0.95,
          matchType: "vector",
          entityType: "document",
        }),
        new ConceptSearchResult({
          conceptId: "concept-456",
          prefLabel: "Machine Learning",
          definition: "A subset of artificial intelligence...",
          score: 0.88,
          entityType: "concept",
        }),
      ];

      const docResults = results.filter(
        (r): r is DocumentSearchResult => r.entityType === "document"
      );
      const conceptResults = results.filter(
        (r): r is ConceptSearchResult => r.entityType === "concept"
      );

      expect(docResults).toHaveLength(1);
      expect(conceptResults).toHaveLength(1);
      expect(docResults[0].docId).toBe("doc-123");
      expect(conceptResults[0].conceptId).toBe("concept-456");
    });
  });

  describe("SearchOptions with entityTypes", () => {
    test("should accept entityTypes filter", () => {
      const options = new SearchOptions({
        limit: 10,
        entityTypes: ["document", "concept"],
      });

      expect(options.entityTypes).toEqual(["document", "concept"]);
    });

    test("should accept single entity type", () => {
      const options = new SearchOptions({
        limit: 10,
        entityTypes: ["document"],
      });

      expect(options.entityTypes).toEqual(["document"]);
    });

    test("should be optional (backwards compatibility)", () => {
      const options = new SearchOptions({
        limit: 10,
      });

      expect(options.entityTypes).toBeUndefined();
    });
  });

  describe("Backward compatibility", () => {
    test("SearchResult should still work as before", () => {
      const result = new SearchResult({
        docId: "doc-123",
        title: "Test Document",
        page: 1,
        chunkIndex: 0,
        content: "Test content",
        score: 0.95,
        matchType: "vector",
      });

      expect(result.docId).toBe("doc-123");
      expect(result.title).toBe("Test Document");
      expect(result.score).toBe(0.95);
    });

    test("SearchResult should NOT have entityType", () => {
      const result = new SearchResult({
        docId: "doc-123",
        title: "Test Document",
        page: 1,
        chunkIndex: 0,
        content: "Test content",
        score: 0.95,
        matchType: "vector",
      });

      // @ts-expect-error - entityType should not exist on SearchResult
      expect(result.entityType).toBeUndefined();
    });
  });

  describe("library path resolution", () => {
    const originalEnv = process.env.PDF_LIBRARY_PATH;
    const originalHome = process.env.HOME;
    const testDir = "/tmp/pdf-brain-test";

    beforeEach(() => {
      delete process.env.PDF_LIBRARY_PATH;
      process.env.HOME = "/tmp";
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    afterEach(() => {
      if (originalEnv) {
        process.env.PDF_LIBRARY_PATH = originalEnv;
      } else {
        delete process.env.PDF_LIBRARY_PATH;
      }
      if (originalHome) {
        process.env.HOME = originalHome;
      }
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test("uses default path when PDF_LIBRARY_PATH not set", () => {
      const config = LibraryConfig.fromEnv();
      expect(config.libraryPath).toBe("/tmp/Documents/.pdf-library");
    });

    test("uses PDF_LIBRARY_PATH when it exists", () => {
      mkdirSync(testDir, { recursive: true });
      process.env.PDF_LIBRARY_PATH = testDir;
      
      const config = LibraryConfig.fromEnv();
      expect(config.libraryPath).toBe(testDir);
    });

    test("falls back to default when PDF_LIBRARY_PATH doesn't exist", () => {
      process.env.PDF_LIBRARY_PATH = "/nonexistent/path";
      
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: any[]) => {
        warnings.push(args.join(" "));
      };
      
      const config = LibraryConfig.fromEnv();
      
      expect(config.libraryPath).toBe("/tmp/Documents/.pdf-library");
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some(w => w.includes('PDF_LIBRARY_PATH "/nonexistent/path" does not exist'))).toBe(true);
      
      console.warn = originalWarn;
    });

    test("loadConfig uses shared path resolution logic", () => {
      mkdirSync(testDir, { recursive: true });
      process.env.PDF_LIBRARY_PATH = testDir;
      
      const config = loadConfig();
      expect(config).toBeDefined();
    });

    test("saveConfig uses shared path resolution logic", () => {
      mkdirSync(testDir, { recursive: true });
      process.env.PDF_LIBRARY_PATH = testDir;
      
      const config = loadConfig();
      saveConfig(config);
      
      const configPath = join(testDir, "config.json");
      expect(existsSync(configPath)).toBe(true);
    });

    test("all config functions use consistent path resolution", () => {
      mkdirSync(testDir, { recursive: true });
      process.env.PDF_LIBRARY_PATH = testDir;
      
      const config1 = LibraryConfig.fromEnv();
      const config2 = loadConfig();
      
      expect(config1.libraryPath).toBe(testDir);
      expect(config2).toBeDefined();
    });
  });
});
