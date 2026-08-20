/**
 * Self-updater for pdf-brain.
 *
 * - Background: silently downloads + replaces binary when a new version drops
 * - `pdf-brain update` — force check + install now
 *
 * State file: ~/.pdf-brain/update-check.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "node:os";
import { logInfo } from "./logger.js";

const REPO = "joelhooks/pdf-brain";
const STATE_DIR = join((process.env.HOME || homedir()), ".pdf-brain");
const STATE_FILE = join(STATE_DIR, "update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

interface UpdateState {
  lastCheck: number;
  latestVersion: string | null;
  lastAutoUpdate: number;
}

function readState(): UpdateState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return { lastCheck: 0, latestVersion: null, lastAutoUpdate: 0 };
}

function writeState(state: UpdateState): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

/**
 * Fetch latest release tag from GitHub.
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { tag_name?: string };
    return data.tag_name?.replace(/^v/, "") ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * Get the download URL for the current platform.
 */
function getAssetUrl(version: string): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const ext = os === "windows" ? ".exe" : "";
  return `https://github.com/${REPO}/releases/download/v${version}/pdf-brain-${os}-${arch}${ext}`;
}

/**
 * Download binary and atomically replace the current one.
 * Returns true on success, false on failure. Never throws.
 */
async function downloadAndReplace(version: string): Promise<boolean> {
  const url = getAssetUrl(version);
  const binaryPath = process.execPath;
  const tmpPath = `${binaryPath}.update-${Date.now()}`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) return false;

    const buffer = await resp.arrayBuffer();
    await Bun.write(tmpPath, buffer);
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, binaryPath);
    return true;
  } catch {
    try { unlinkSync(tmpPath); } catch {}
    return false;
  }
}

/**
 * Background auto-update. Runs silently on every invocation (once/day).
 * If newer version exists, downloads and replaces the binary.
 * Current invocation keeps running the old code — new version takes effect next run.
 */
export function backgroundUpdateCheck(currentVersion: string): void {
  // Agent-first default: disable background updates unless explicitly enabled.
  // Background network calls + non-deterministic stderr output are a footgun for tool callers.
  if (process.env.PDF_BRAIN_BACKGROUND_UPDATE !== "1") return;

  // Don't auto-update in dev mode
  if (currentVersion.includes("compiled") || currentVersion === "0.0.0") return;

  const state = readState();
  const now = Date.now();

  // Checked recently, skip
  if (now - state.lastCheck < CHECK_INTERVAL_MS) return;

  // Fire-and-forget: check + update in background
  (async () => {
    const latest = await fetchLatestVersion();
    const newState: UpdateState = {
      lastCheck: now,
      latestVersion: latest,
      lastAutoUpdate: state.lastAutoUpdate,
    };

    if (latest && compareSemver(latest, currentVersion) > 0) {
      const ok = await downloadAndReplace(latest);
      if (ok) {
        newState.lastAutoUpdate = now;
        newState.latestVersion = latest;
        // Brief note so they know why behavior might change (stderr only).
        logInfo(`Updated pdf-brain v${currentVersion} -> v${latest}`);
      }
    }

    writeState(newState);
  })().catch(() => {});
}

/**
 * Explicit `pdf-brain update` command. Checks, downloads, replaces, verifies.
 */
export async function runUpdate(currentVersion: string): Promise<void> {
  console.log("Checking for updates...\n");

  const latest = await fetchLatestVersion();
  if (!latest) {
    console.log("Could not reach GitHub. Check your connection.");
    process.exit(1);
  }

  writeState({ lastCheck: Date.now(), latestVersion: latest, lastAutoUpdate: readState().lastAutoUpdate });

  if (compareSemver(latest, currentVersion) <= 0) {
    console.log(`Already on latest (v${currentVersion}).`);
    return;
  }

  console.log(`v${currentVersion} → v${latest}`);
  console.log(`Downloading...`);

  const ok = await downloadAndReplace(latest);
  if (!ok) {
    console.error(`Download failed.`);
    console.error(
      `\nManual install:\n  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash`
    );
    process.exit(1);
  }

  console.log(`Updated to v${latest}.`);

  // Verify
  const result = Bun.spawnSync([process.execPath, "--version"], { stdout: "pipe" });
  const output = result.stdout.toString().trim();
  if (output) console.log(output);
}
