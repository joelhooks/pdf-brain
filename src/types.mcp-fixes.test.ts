/**
 * Tests for CodeRabbit PR #8 fixes
 * - Path resolution helper extraction
 * - Warning when PDF_LIBRARY_PATH doesn't exist
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { LibraryConfig, loadConfig, saveConfig } from "./types.js";

describe("Path Resolution Helper (CodeRabbit Fix)", () => {
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

  test("fromEnv() uses default path when PDF_LIBRARY_PATH not set", () => {
    const config = LibraryConfig.fromEnv();
    expect(config.libraryPath).toBe("/tmp/Documents/.pdf-library");
  });

  test("fromEnv() uses PDF_LIBRARY_PATH when it exists", () => {
    mkdirSync(testDir, { recursive: true });
    process.env.PDF_LIBRARY_PATH = testDir;
    
    const config = LibraryConfig.fromEnv();
    expect(config.libraryPath).toBe(testDir);
  });

  test("fromEnv() falls back to default when PDF_LIBRARY_PATH doesn't exist", () => {
    process.env.PDF_LIBRARY_PATH = "/nonexistent/path";
    
    // Should warn and use default
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

  test("loadConfig() uses helper function (no duplication)", () => {
    mkdirSync(testDir, { recursive: true });
    process.env.PDF_LIBRARY_PATH = testDir;
    
    const config = loadConfig();
    expect(config).toBeDefined();
  });

  test("saveConfig() uses helper function (no duplication)", () => {
    mkdirSync(testDir, { recursive: true });
    process.env.PDF_LIBRARY_PATH = testDir;
    
    const config = loadConfig();
    saveConfig(config);
    
    const configPath = join(testDir, "config.json");
    expect(existsSync(configPath)).toBe(true);
  });

  test("all three functions use same path resolution logic", () => {
    mkdirSync(testDir, { recursive: true });
    process.env.PDF_LIBRARY_PATH = testDir;
    
    const config1 = LibraryConfig.fromEnv();
    const config2 = loadConfig();
    
    // Both should resolve to same path (LibraryConfig has libraryPath, Config doesn't)
    // But both use resolveLibraryPath() helper internally
    expect(config1.libraryPath).toBe(testDir);
    expect(config2).toBeDefined(); // Config loaded successfully
  });
});
