/**
 * Tests for Daemon service
 *
 * Tests the PGlite socket server daemon lifecycle:
 * - Starting daemon creates socket and PID file
 * - Stopping daemon removes socket and PID file
 * - Status check returns correct daemon state
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  startDaemon,
  stopDaemon,
  isDaemonRunning,
  DaemonConfig,
} from "./Daemon.js";

describe("Daemon Service", () => {
  let testDir: string;
  let config: DaemonConfig;

  beforeEach(() => {
    // Create isolated test directory
    testDir = join(tmpdir(), `pdf-library-daemon-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    config = {
      socketPath: testDir, // Directory where .s.PGSQL.5432 will be created
      pidPath: join(testDir, "daemon.pid"),
      dbPath: join(testDir, "library.db"),
    };
  });

  afterEach(async () => {
    // Clean up: stop daemon if running
    if (await isDaemonRunning(config)) {
      await stopDaemon(config);
    }

    // Remove test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("startDaemon", () => {
    test("creates socket file", async () => {
      await startDaemon(config);
      const socketFile = join(config.socketPath, ".s.PGSQL.5432");
      expect(existsSync(socketFile)).toBe(true);
    });

    test("creates PID file", async () => {
      await startDaemon(config);

      expect(existsSync(config.pidPath)).toBe(true);
    });

    test("writes valid PID to PID file", async () => {
      await startDaemon(config);

      const pidContent = await Bun.file(config.pidPath).text();
      const pid = parseInt(pidContent.trim(), 10);

      expect(pid).toBeGreaterThan(0);
    });

    test("daemon is running after start", async () => {
      await startDaemon(config);

      expect(await isDaemonRunning(config)).toBe(true);
    });

    test("throws if daemon already running", async () => {
      await startDaemon(config);

      await expect(startDaemon(config)).rejects.toThrow(
        "Daemon already running"
      );
    });
  });

  describe("stopDaemon", () => {
    test("removes socket file", async () => {
      await startDaemon(config);
      await stopDaemon(config);
      const socketFile = join(config.socketPath, ".s.PGSQL.5432");
      expect(existsSync(socketFile)).toBe(false);
    });

    test("removes PID file", async () => {
      await startDaemon(config);
      await stopDaemon(config);

      expect(existsSync(config.pidPath)).toBe(false);
    });

    test("daemon is not running after stop", async () => {
      await startDaemon(config);
      await stopDaemon(config);

      expect(await isDaemonRunning(config)).toBe(false);
    });

    test("does nothing if daemon not running", async () => {
      // Should not throw
      await stopDaemon(config);

      expect(await isDaemonRunning(config)).toBe(false);
    });
  });

  describe("isDaemonRunning", () => {
    test("returns false when daemon never started", async () => {
      expect(await isDaemonRunning(config)).toBe(false);
    });

    test("returns true when daemon is running", async () => {
      await startDaemon(config);

      expect(await isDaemonRunning(config)).toBe(true);
    });

    test("returns false when daemon was stopped", async () => {
      await startDaemon(config);
      await stopDaemon(config);

      expect(await isDaemonRunning(config)).toBe(false);
    });

    test("returns false if PID file exists but process is dead", async () => {
      // Manually create PID file with fake PID
      await Bun.write(config.pidPath, "99999");

      expect(await isDaemonRunning(config)).toBe(false);
    });
  });

  describe("graceful shutdown", () => {
    test("runs CHECKPOINT before closing", async () => {
      // This is hard to test directly without introspecting PGlite internals
      // We verify checkpoint behavior by ensuring daemon can restart cleanly
      // after being stopped (checkpoint ensures WAL is flushed)

      await startDaemon(config);
      await stopDaemon(config);

      // Should be able to start again without corruption
      await startDaemon(config);
      expect(await isDaemonRunning(config)).toBe(true);

      await stopDaemon(config);
    });
  });
});
