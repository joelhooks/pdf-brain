

import { describe, test, expect } from "bun:test";
import { spawn } from "child_process";
import { promisify } from "util";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("MCP Server Fixes (CodeRabbit PR #8)", () => {
  test("STDIN buffering handles fragmented messages", async () => {
    const mcpProcess = spawn("bun", ["run", "src/cli.ts", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let responseCount = 0;
    let lastResponse: any = null;

    mcpProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          lastResponse = JSON.parse(line);
          responseCount++;
        } catch (e) {
          // Ignore
        }
      }
    });

    // Create a message and fragment it
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const json = JSON.stringify(message) + "\n";

    // Split into 3 chunks
    const chunk1 = json.substring(0, Math.floor(json.length / 3));
    const chunk2 = json.substring(
      Math.floor(json.length / 3),
      Math.floor(json.length * 2 / 3)
    );
    const chunk3 = json.substring(Math.floor(json.length * 2 / 3));

    // Send chunks with delays
    mcpProcess.stdin.write(chunk1);
    await sleep(50);
    mcpProcess.stdin.write(chunk2);
    await sleep(50);
    mcpProcess.stdin.write(chunk3);
    await sleep(50);

    mcpProcess.stdin.end();

    await sleep(500);

    mcpProcess.kill();

    // Should receive 1 response from fragmented message
    expect(responseCount).toBe(1);
    expect(lastResponse).toBeDefined();
    expect(lastResponse.id).toBe(1);
    expect(lastResponse.result).toBeDefined();
  });

  test("unknown method with ID returns JSON-RPC error", async () => {
    const mcpProcess = spawn("bun", ["run", "src/cli.ts", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let response: any = null;

    mcpProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          response = JSON.parse(line);
        } catch (e) {
          // Ignore
        }
      }
    });

    const message = {
      jsonrpc: "2.0",
      id: 999,
      method: "unknown_method_xyz",
    };

    mcpProcess.stdin.write(JSON.stringify(message) + "\n");
    mcpProcess.stdin.end();

    await sleep(500);

    mcpProcess.kill();

    expect(response).toBeDefined();
    expect(response.id).toBe(999);
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toContain("Method not found");
  });

  test("unknown notification (no ID) returns null (no response)", async () => {
    const mcpProcess = spawn("bun", ["run", "src/cli.ts", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: any[] = [];

    mcpProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          responses.push(parsed);
        } catch (e) {
          // Ignore
        }
      }
    });

    const message = {
      jsonrpc: "2.0",
      method: "unknown_notification",
    };

    mcpProcess.stdin.write(JSON.stringify(message) + "\n");
    mcpProcess.stdin.end();

    await sleep(500);

    mcpProcess.kill();

    // Notifications don't require responses
    // If there are responses, they should not have the notification's ID (since it had none)
    const notificationResponses = responses.filter(r => r.id === undefined);
    // Should be 0 responses for notifications without ID
    expect(responses.length).toBe(0);
  });

  test("docsOnly parameter is respected in search", async () => {
    const mcpProcess = spawn("bun", ["run", "src/cli.ts", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let response: any = null;

    mcpProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          response = JSON.parse(line);
        } catch (e) {
          // Ignore
        }
      }
    });

    // Search with docsOnly flag
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

    mcpProcess.stdin.write(JSON.stringify(message) + "\n");
    mcpProcess.stdin.end();

    await sleep(1000);

    mcpProcess.kill();

    expect(response).toBeDefined();
    expect(response.id).toBe(100);
    expect(response.result).toBeDefined();
    
    const content = JSON.parse(response.result.content[0].text);
    expect(content.success).toBe(true);
    expect(content.type).toBe("documents"); // Should be documents, not concepts or unified
    expect(content.results).toBeDefined();
    expect(Array.isArray(content.results)).toBe(true);
  });

  test("conceptsOnly parameter works correctly", async () => {
    const mcpProcess = spawn("bun", ["run", "src/cli.ts", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let response: any = null;

    mcpProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          response = JSON.parse(line);
        } catch (e) {
          // Ignore
        }
      }
    });

    // Search with conceptsOnly flag
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

    mcpProcess.stdin.write(JSON.stringify(message) + "\n");
    mcpProcess.stdin.end();

    await sleep(1000);

    mcpProcess.kill();

    expect(response).toBeDefined();
    expect(response.id).toBe(101);
    expect(response.result).toBeDefined();
    
    const content = JSON.parse(response.result.content[0].text);
    expect(content.success).toBe(true);
    expect(content.type).toBe("concepts"); // Should be concepts only
    expect(content.results).toBeDefined();
    expect(Array.isArray(content.results)).toBe(true);
  });

  test("conflicting flags (both true) returns empty results (matches CLI)", async () => {
    const mcpProcess = spawn("bun", ["run", "src/cli.ts", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let response: any = null;

    mcpProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          response = JSON.parse(line);
        } catch (e) {
          // Ignore
        }
      }
    });

    // Search with both flags true (conflicting)
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

    mcpProcess.stdin.write(JSON.stringify(message) + "\n");
    mcpProcess.stdin.end();

    await sleep(1000);

    mcpProcess.kill();

    expect(response).toBeDefined();
    expect(response.id).toBe(102);
    expect(response.result).toBeDefined();
    
    const content = JSON.parse(response.result.content[0].text);
    expect(content.success).toBe(true);
    expect(content.type).toBe("empty"); // Should be empty (matches CLI behavior)
    expect(content.documents).toBeDefined();
    expect(content.concepts).toBeDefined();
    expect(Array.isArray(content.documents)).toBe(true);
    expect(Array.isArray(content.concepts)).toBe(true);
    expect(content.documents.length).toBe(0);
    expect(content.concepts.length).toBe(0);
  });

  test("search responses are written promptly (timing test)", async () => {
    const mcpProcess = spawn("bun", ["run", "src/cli.ts", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let response: any = null;
    const responseTimes: number[] = [];
    const startTime = Date.now();

    mcpProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 200) {
            response = parsed;
            responseTimes.push(Date.now() - startTime);
          }
        } catch (e) {
          // Ignore
        }
      }
    });

    // Search with docsOnly - should respond quickly
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

    mcpProcess.stdin.write(JSON.stringify(message) + "\n");
    mcpProcess.stdin.end();

    await sleep(500); // Shorter timeout to ensure prompt response

    mcpProcess.kill();

    expect(response).toBeDefined();
    expect(response.id).toBe(200);
    // Response should arrive within 500ms
    expect(responseTimes.length).toBeGreaterThan(0);
    expect(responseTimes[0]).toBeLessThan(500);
  });

  test("Effect scope stays alive for multiple tool calls", async () => {
    const mcpProcess = spawn("bun", ["run", "src/cli.ts", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: any[] = [];

    mcpProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          responses.push(JSON.parse(line));
        } catch (e) {
          // Ignore
        }
      }
    });

    // Send multiple tool calls - scope should remain alive
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

    for (const msg of messages) {
      mcpProcess.stdin.write(JSON.stringify(msg) + "\n");
      await sleep(100);
    }

    mcpProcess.stdin.end();

    await sleep(1000);

    mcpProcess.kill();

    // All messages should have responses (scope stayed alive)
    expect(responses.length).toBeGreaterThanOrEqual(4);
    
    // Verify all have proper structure (no disposed resource errors)
    for (const resp of responses) {
      expect(resp.jsonrpc).toBe("2.0");
      if (resp.error) {
        // Errors should be proper JSON-RPC errors, not "disposed resource" errors
        expect(resp.error.code).toBeDefined();
        expect(resp.error.message).toBeDefined();
        expect(resp.error.message).not.toContain("disposed");
      }
    }
  });

  test("Effect failures are caught and converted to JSON-RPC errors", async () => {
    const mcpProcess = spawn("bun", ["run", "src/cli.ts", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: any[] = [];

    mcpProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          responses.push(parsed);
        } catch (e) {
          // Ignore
        }
      }
    });

    // Call a tool that will fail (e.g., get non-existent document)
    // The handler throws Error("Document not found") which should be caught
    const message = {
      jsonrpc: "2.0",
      id: 999,
      method: "tools/call",
      params: {
        name: "pdf-brain_read",
        arguments: { id: "non-existent-doc-id-12345" },
      },
    };

    mcpProcess.stdin.write(JSON.stringify(message) + "\n");
    mcpProcess.stdin.end();

    await sleep(1000);

    mcpProcess.kill();

    // Should receive error response, not unhandled rejection
    expect(responses.length).toBeGreaterThan(0);
    const response = responses.find(r => r.id === 999);
    expect(response).toBeDefined();
    
    if (response) {
      // Either the handler returns success with error in content, or Effect failure is caught
      // Both are valid - the key is no unhandled rejection
      if (response.error) {
        expect(response.error.code).toBe(-32603); // Internal error
        expect(response.error.message).toBeDefined();
        expect(typeof response.error.message).toBe("string");
      } else if (response.result) {
        // Handler might return success with error message in content
        const content = JSON.parse(response.result.content[0].text);
        expect(content.success).toBe(false);
        expect(content.error).toBeDefined();
      }
    }
  });
});
