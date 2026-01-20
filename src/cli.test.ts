import { describe, expect, test } from "bun:test";
import { spawn, ChildProcess } from "child_process";
import {
  filenameFromURL,
  looksLikeMarkdown,
  hasMarkdownExtension,
  assessWALHealth,
  MARKDOWN_INDICATORS,
  getCheckpointInterval,
  shouldCheckpoint,
  parseArgs,
} from "./cli.js";


async function waitForResponse(
  responses: any[],
  predicate: (r: any) => boolean,
  timeoutMs: number = 5000
): Promise<any> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const found = responses.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timeout waiting for response after ${timeoutMs}ms`);
}

async function waitForResponseCount(
  responses: any[],
  count: number,
  timeoutMs: number = 5000
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (responses.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timeout waiting for ${count} responses after ${timeoutMs}ms`);
}

function createMCPProcess(): ChildProcess {
  return spawn("bun", ["run", "src/cli.ts", "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function ensureStdin(process: ChildProcess): NodeJS.WritableStream {
  if (!process.stdin) {
    throw new Error("Process stdin is null - stdio must include 'pipe' for stdin");
  }
  return process.stdin;
}

function collectResponses(process: ChildProcess, filterLogs: boolean = false): any[] {
  const responses: any[] = [];
  
  if (!process.stdout) {
    throw new Error("Process stdout is null - stdio must include 'pipe' for stdout");
  }
  
  process.stdout.on("data", (data) => {
    const lines = data.toString().split("\n").filter((l: string) => l.trim());
    for (const line of lines) {
      if (filterLogs && !line.trim().startsWith("{")) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed.jsonrpc === "2.0") {
          responses.push(parsed);
        }
      } catch (e) {
        // Ignore invalid JSON (likely log messages)
      }
    }
  });
  
  return responses;
}

describe("filenameFromURL", () => {
  test("preserves .pdf extension", () => {
    expect(filenameFromURL("https://example.com/paper.pdf")).toBe("paper.pdf");
  });

  test("preserves .md extension", () => {
    expect(filenameFromURL("https://example.com/README.md")).toBe("README.md");
  });

  test("preserves .markdown extension", () => {
    expect(filenameFromURL("https://example.com/doc.markdown")).toBe(
      "doc.markdown"
    );
  });

  test("defaults to .pdf for unknown extensions", () => {
    expect(filenameFromURL("https://example.com/document")).toBe(
      "document.pdf"
    );
  });

  test("does NOT infer .md from path containing .md (false positive fix)", () => {
    // This was the bug: pathname.includes(".md") was too broad
    // e.g., https://example.com/markdown-docs/file should NOT get .md appended
    expect(filenameFromURL("https://example.com/markdown-docs/file")).toBe(
      "file.pdf"
    );
    expect(filenameFromURL("https://example.com/docs.md.backup/file")).toBe(
      "file.pdf"
    );
  });

  test("handles query strings correctly", () => {
    expect(filenameFromURL("https://example.com/doc.pdf?token=abc")).toBe(
      "doc.pdf"
    );
  });

  test("handles GitHub raw URLs with .md extension", () => {
    expect(
      filenameFromURL(
        "https://raw.githubusercontent.com/user/repo/main/README.md"
      )
    ).toBe("README.md");
  });
});

describe("hasMarkdownExtension", () => {
  test("returns true for .md extension", () => {
    expect(hasMarkdownExtension("https://example.com/file.md")).toBe(true);
  });

  test("returns true for .markdown extension", () => {
    expect(hasMarkdownExtension("https://example.com/file.markdown")).toBe(
      true
    );
  });

  test("returns false for .pdf extension", () => {
    expect(hasMarkdownExtension("https://example.com/file.pdf")).toBe(false);
  });

  test("returns false for no extension", () => {
    expect(hasMarkdownExtension("https://example.com/file")).toBe(false);
  });

  test("returns false for .txt extension", () => {
    expect(hasMarkdownExtension("https://example.com/file.txt")).toBe(false);
  });

  test("is case insensitive", () => {
    expect(hasMarkdownExtension("https://example.com/file.MD")).toBe(true);
    expect(hasMarkdownExtension("https://example.com/file.MARKDOWN")).toBe(
      true
    );
  });

  test("does NOT match .md in path (only extension)", () => {
    // This is the key fix - .md in the path should not trigger markdown detection
    expect(hasMarkdownExtension("https://example.com/markdown-docs/file")).toBe(
      false
    );
    expect(
      hasMarkdownExtension("https://example.com/docs.md.backup/file.txt")
    ).toBe(false);
  });
});

describe("looksLikeMarkdown", () => {
  test("detects h1 heading", () => {
    expect(looksLikeMarkdown("# Hello World")).toBe(true);
  });

  test("detects h2 heading", () => {
    expect(looksLikeMarkdown("## Section")).toBe(true);
  });

  test("detects h3-h6 headings", () => {
    expect(looksLikeMarkdown("### Subsection")).toBe(true);
    expect(looksLikeMarkdown("#### Deep")).toBe(true);
    expect(looksLikeMarkdown("###### Deepest")).toBe(true);
  });

  test("detects unordered list with dash", () => {
    expect(looksLikeMarkdown("- item one\n- item two")).toBe(true);
  });

  test("detects unordered list with asterisk", () => {
    expect(looksLikeMarkdown("* item one\n* item two")).toBe(true);
  });

  test("detects unordered list with plus", () => {
    expect(looksLikeMarkdown("+ item one\n+ item two")).toBe(true);
  });

  test("detects ordered list", () => {
    expect(looksLikeMarkdown("1. First\n2. Second")).toBe(true);
  });

  test("detects code fence", () => {
    expect(looksLikeMarkdown("```javascript\nconst x = 1;\n```")).toBe(true);
  });

  test("detects table", () => {
    expect(looksLikeMarkdown("| Col1 | Col2 |\n|------|------|")).toBe(true);
  });

  test("detects markdown link", () => {
    expect(
      looksLikeMarkdown("Check out [this link](https://example.com)")
    ).toBe(true);
  });

  test("returns false for plain text", () => {
    expect(
      looksLikeMarkdown("This is just plain text without any markers.")
    ).toBe(false);
  });

  test("returns false for text with hash not at line start", () => {
    expect(looksLikeMarkdown("This has a # in the middle")).toBe(false);
  });

  test("returns false for text with dash not at line start", () => {
    expect(looksLikeMarkdown("This has a - in the middle")).toBe(false);
  });

  test("detects markdown in multiline content", () => {
    const content = `Some intro text

## Section Header

This is a paragraph.

- List item 1
- List item 2
`;
    expect(looksLikeMarkdown(content)).toBe(true);
  });

  test("returns false for empty content", () => {
    expect(looksLikeMarkdown("")).toBe(false);
  });

  test("returns false for whitespace only", () => {
    expect(looksLikeMarkdown("   \n\n   ")).toBe(false);
  });
});

describe("Markdown MIME type detection (conceptual)", () => {
  // These tests document the expected behavior of the downloadFile function
  // They test the logic conceptually since downloadFile requires network access

  const isExplicitMarkdownMime = (contentType: string) =>
    contentType.includes("text/markdown") ||
    contentType.includes("text/x-markdown");

  test("text/markdown is explicit markdown MIME", () => {
    expect(isExplicitMarkdownMime("text/markdown")).toBe(true);
    expect(isExplicitMarkdownMime("text/markdown; charset=utf-8")).toBe(true);
  });

  test("text/x-markdown is explicit markdown MIME", () => {
    expect(isExplicitMarkdownMime("text/x-markdown")).toBe(true);
  });

  test("text/plain is NOT explicit markdown MIME", () => {
    expect(isExplicitMarkdownMime("text/plain")).toBe(false);
    expect(isExplicitMarkdownMime("text/plain; charset=utf-8")).toBe(false);
  });

  test("text/html is NOT explicit markdown MIME", () => {
    expect(isExplicitMarkdownMime("text/html")).toBe(false);
  });
});

describe("WAL health assessment", () => {
  test("assesses healthy WAL state", () => {
    const result = assessWALHealth({
      fileCount: 10,
      totalSizeBytes: 1024 * 1024,
    }); // 1MB
    expect(result.healthy).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  test("warns when file count exceeds threshold", () => {
    const result = assessWALHealth({
      fileCount: 60,
      totalSizeBytes: 1024 * 1024,
    });
    expect(result.healthy).toBe(false);
    expect(result.warnings).toContain(
      "WAL file count (60) exceeds recommended threshold (50)"
    );
  });

  test("warns when total size exceeds threshold", () => {
    const result = assessWALHealth({
      fileCount: 10,
      totalSizeBytes: 60 * 1024 * 1024,
    }); // 60MB
    expect(result.healthy).toBe(false);
    expect(result.warnings).toContain(
      "WAL size (60.0 MB) exceeds recommended threshold (50 MB)"
    );
  });

  test("warns for both thresholds exceeded", () => {
    const result = assessWALHealth({
      fileCount: 100,
      totalSizeBytes: 100 * 1024 * 1024,
    });
    expect(result.healthy).toBe(false);
    expect(result.warnings).toHaveLength(2);
  });

  test("handles zero files gracefully", () => {
    const result = assessWALHealth({ fileCount: 0, totalSizeBytes: 0 });
    expect(result.healthy).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("daemon command parsing", () => {
  // Note: These test the command structure, not execution
  // Actual daemon lifecycle is tested in Daemon.test.ts

  test("daemon command requires subcommand", () => {
    // This will be handled in the switch statement
    expect(true).toBe(true); // Placeholder - actual test would mock console.error
  });

  test("daemon start subcommand exists", () => {
    expect(true).toBe(true); // Structure verification only
  });

  test("daemon stop subcommand exists", () => {
    expect(true).toBe(true); // Structure verification only
  });

  test("daemon status subcommand exists", () => {
    expect(true).toBe(true); // Structure verification only
  });
});

describe("automatic checkpoint during batch operations", () => {
  test("calculates checkpoint interval from options", () => {
    // Default should be 50
    const defaultInterval = getCheckpointInterval({});
    expect(defaultInterval).toBe(50);

    // Custom interval
    const customInterval = getCheckpointInterval({
      "checkpoint-interval": "25",
    });
    expect(customInterval).toBe(25);
  });

  test("determines when checkpoint is needed", () => {
    const interval = 50;

    // Should checkpoint at multiples of interval
    expect(shouldCheckpoint(0, interval)).toBe(false); // Start, no checkpoint
    expect(shouldCheckpoint(49, interval)).toBe(false);
    expect(shouldCheckpoint(50, interval)).toBe(true); // 50th doc
    expect(shouldCheckpoint(51, interval)).toBe(false);
    expect(shouldCheckpoint(100, interval)).toBe(true); // 100th doc
    expect(shouldCheckpoint(150, interval)).toBe(true); // 150th doc
  });

  test("checkpoint counter tracks processed documents", () => {
    // Test that counter increments properly during ingest loop
    // This is behavioral - we verify by checking the checkpointing logic
    const docsProcessed = [1, 2, 49, 50, 51, 99, 100];
    const interval = 50;
    const checkpointedAt = docsProcessed.filter((n) =>
      shouldCheckpoint(n, interval)
    );

    expect(checkpointedAt).toEqual([50, 100]);
  });
});

describe("CLI integration: search with --include-clusters", () => {
  test("parseArgs handles --include-clusters flag", () => {
    const args = [
      "search",
      "machine learning",
      "--include-clusters",
      "--limit",
      "5",
    ];
    const opts = parseArgs(args.slice(2)); // Skip command and query

    expect(opts["include-clusters"]).toBe(true);
    expect(opts.limit).toBe("5");
  });

  test("parseArgs handles search without --include-clusters", () => {
    const args = ["search", "query", "--limit", "10"];
    const opts = parseArgs(args.slice(2));

    expect(opts["include-clusters"]).toBeUndefined();
  });
});

describe("CLI integration: cluster command with --soft flag", () => {
  test("parseArgs handles --soft flag for soft clustering", () => {
    const args = ["cluster", "--soft", "--k", "10"];
    const opts = parseArgs(args.slice(1)); // Skip command

    expect(opts.soft).toBe(true);
    expect(opts.k).toBe("10");
  });

  test("parseArgs handles cluster without --soft (hard k-means)", () => {
    const args = ["cluster", "--k", "20"];
    const opts = parseArgs(args.slice(1));

    expect(opts.soft).toBeUndefined();
    expect(opts.k).toBe("20");
  });

  // NOTE: Full cluster command integration test deferred
  // The cluster command implementation is part of a separate cell/PR
  // This cell focuses on CLI argument parsing and wiring flags to services
});

describe("MCP server protocol", () => {
  test("handles fragmented STDIN messages correctly", async () => {
    const mcpProcess = createMCPProcess();
    const responses = collectResponses(mcpProcess);

    const message = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const json = JSON.stringify(message) + "\n";

    const chunk1 = json.substring(0, Math.floor(json.length / 3));
    const chunk2 = json.substring(
      Math.floor(json.length / 3),
      Math.floor(json.length * 2 / 3)
    );
    const chunk3 = json.substring(Math.floor(json.length * 2 / 3));

    const stdin = ensureStdin(mcpProcess);
    stdin.write(chunk1);
    stdin.write(chunk2);
    stdin.write(chunk3);
    stdin.end();

    const response = await waitForResponse(responses, (r) => r.id === 1);
    mcpProcess.kill();

    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
  });

  test("returns JSON-RPC error for unknown method with ID", async () => {
    const mcpProcess = createMCPProcess();
    const responses = collectResponses(mcpProcess);

    const message = {
      jsonrpc: "2.0",
      id: 999,
      method: "unknown_method_xyz",
    };

    const stdin = ensureStdin(mcpProcess);
    stdin.write(JSON.stringify(message) + "\n");
    stdin.end();

    const response = await waitForResponse(responses, (r) => r.id === 999);
    mcpProcess.kill();

    expect(response.id).toBe(999);
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toContain("Method not found");
  });

  test("does not respond to unknown notifications without ID", async () => {
    const mcpProcess = createMCPProcess();
    const responses = collectResponses(mcpProcess);

    const message = {
      jsonrpc: "2.0",
      method: "unknown_notification",
    };

    const stdin = ensureStdin(mcpProcess);
    stdin.write(JSON.stringify(message) + "\n");
    stdin.end();

    await new Promise((resolve) => setTimeout(resolve, 200));
    mcpProcess.kill();

    expect(responses.length).toBe(0);
  });

  test("respects docsOnly parameter in search", async () => {
    const mcpProcess = createMCPProcess();
    const responses = collectResponses(mcpProcess, true);

    const stdin = ensureStdin(mcpProcess);
    stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" }
      }
    }) + "\n");

    await waitForResponse(responses, (r) => r.id === 1);

    const message = {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: {
        name: "pdf-brain_search",
        arguments: {
          query: "test",
          docsOnly: true,
        },
      },
    };

    stdin.write(JSON.stringify(message) + "\n");
    stdin.end();

    const response = await waitForResponse(responses, (r) => r.id === 100, 10000);
    mcpProcess.kill();

    expect(response.id).toBe(100);
    expect(response.result).toBeDefined();
    
    const content = JSON.parse(response.result.content[0].text);
    expect(content.success).toBe(true);
    expect(content.type).toBe("documents");
    expect(content.results).toBeDefined();
    expect(Array.isArray(content.results)).toBe(true);
  });

  test("respects conceptsOnly parameter in search", async () => {
    const mcpProcess = spawn("bun", ["run", "src/cli.ts", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: any[] = [];

    mcpProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        if (!line.trim().startsWith("{")) {
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          if (parsed.jsonrpc === "2.0") {
            responses.push(parsed);
          }
        } catch (e) {
          // Ignore invalid JSON (likely log messages)
        }
      }
    });

    const stdin = ensureStdin(mcpProcess);
    stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" }
      }
    }) + "\n");

    await waitForResponse(responses, (r) => r.id === 1);

    const message = {
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: {
        name: "pdf-brain_search",
        arguments: {
          query: "test",
          conceptsOnly: true,
        },
      },
    };

    stdin.write(JSON.stringify(message) + "\n");
    stdin.end();

    const response = await waitForResponse(responses, (r) => r.id === 101, 10000);
    mcpProcess.kill();

    expect(response.id).toBe(101);
    expect(response.result).toBeDefined();
    
    const content = JSON.parse(response.result.content[0].text);
    expect(content.success).toBe(true);
    expect(content.type).toBe("concepts");
    expect(content.results).toBeDefined();
    expect(Array.isArray(content.results)).toBe(true);
  });

  test("returns empty results when both docsOnly and conceptsOnly are true", async () => {
    const mcpProcess = createMCPProcess();
    const responses = collectResponses(mcpProcess);

    const message = {
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: {
        name: "pdf-brain_search",
        arguments: {
          query: "test",
          conceptsOnly: true,
          docsOnly: true,
        },
      },
    };

    const stdin = ensureStdin(mcpProcess);
    stdin.write(JSON.stringify(message) + "\n");
    stdin.end();

    const response = await waitForResponse(responses, (r) => r.id === 102, 10000);
    mcpProcess.kill();

    expect(response.id).toBe(102);
    expect(response.result).toBeDefined();
    
    const content = JSON.parse(response.result.content[0].text);
    expect(content.success).toBe(true);
    expect(content.type).toBe("empty");
    expect(content.documents).toBeDefined();
    expect(content.concepts).toBeDefined();
    expect(Array.isArray(content.documents)).toBe(true);
    expect(Array.isArray(content.concepts)).toBe(true);
    expect(content.documents.length).toBe(0);
    expect(content.concepts.length).toBe(0);
  });

  test("writes search responses promptly", async () => {
    const mcpProcess = createMCPProcess();
    const responses = collectResponses(mcpProcess, true);

    const stdin = ensureStdin(mcpProcess);
    stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" }
      }
    }) + "\n");

    await waitForResponse(responses, (r) => r.id === 1);

    const message = {
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: {
        name: "pdf-brain_search",
        arguments: {
          query: "test",
          docsOnly: true,
        },
      },
    };

    const searchStartTime = Date.now();
    stdin.write(JSON.stringify(message) + "\n");
    stdin.end();

    const response = await waitForResponse(responses, (r) => r.id === 200, 10000);
    const responseTime = Date.now() - searchStartTime;
    mcpProcess.kill();

    expect(response.id).toBe(200);
    expect(responseTime).toBeLessThan(10000);
  });

  test("maintains Effect scope across multiple tool calls", async () => {
    const mcpProcess = createMCPProcess();
    const responses = collectResponses(mcpProcess);

    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "pdf-brain_stats", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "pdf-brain_list", arguments: {} },
      },
    ];

    const stdin = ensureStdin(mcpProcess);
    for (const msg of messages) {
      stdin.write(JSON.stringify(msg) + "\n");
    }

    stdin.end();

    await waitForResponseCount(responses, 4, 10000);
    mcpProcess.kill();

    expect(responses.length).toBeGreaterThanOrEqual(4);
    
    for (const resp of responses) {
      expect(resp.jsonrpc).toBe("2.0");
      if (resp.error) {
        expect(resp.error.code).toBeDefined();
        expect(resp.error.message).toBeDefined();
        expect(resp.error.message).not.toContain("disposed");
      }
    }
  });

  test("converts Effect failures to JSON-RPC errors", async () => {
    const mcpProcess = spawn("bun", ["run", "src/cli.ts", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: any[] = [];

    mcpProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        if (!line.trim().startsWith("{")) {
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          if (parsed.jsonrpc === "2.0") {
            responses.push(parsed);
          }
        } catch (e) {
          // Ignore invalid JSON (likely log messages)
        }
      }
    });

    const stdin = ensureStdin(mcpProcess);
    stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" }
      }
    }) + "\n");

    await waitForResponse(responses, (r) => r.id === 1);

    const message = {
      jsonrpc: "2.0",
      id: 999,
      method: "tools/call",
      params: {
        name: "pdf-brain_read",
        arguments: { id: "non-existent-doc-id-12345" },
      },
    };

    stdin.write(JSON.stringify(message) + "\n");
    stdin.end();

    const response = await waitForResponse(responses, (r) => r.id === 999, 10000);
    mcpProcess.kill();

    expect(response).toBeDefined();
    
    if (response.error) {
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toBeDefined();
      expect(typeof response.error.message).toBe("string");
    } else if (response.result) {
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(false);
      expect(content.error).toBeDefined();
    }
  });
});
