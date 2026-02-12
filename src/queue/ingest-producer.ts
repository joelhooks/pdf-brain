/**
 * Queue-based ingest producer: discovers files and submits one BullMQ job per file.
 */
import { Queue } from "bullmq";
import { readdirSync, statSync, existsSync } from "fs";
import { join, extname, basename } from "path";
import { Effect } from "effect";

export const QUEUE_NAME = "pdf-ingest";

export interface IngestJob {
  filePath: string;
  options: {
    enrich: boolean;
    autoTag: boolean;
    tags?: string[];
  };
}

const REDIS_CONNECTION = { host: "localhost", port: 6379 };

/**
 * Discover PDF/Markdown files recursively in a directory.
 */
function discoverFiles(dir: string, recursive = true): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory() && recursive) {
          files.push(...discoverFiles(fullPath, recursive));
        } else if (stat.isFile()) {
          const ext = extname(entry).toLowerCase();
          if (ext === ".pdf" || ext === ".md" || ext === ".markdown") {
            files.push(fullPath);
          }
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Skip unreadable directories
  }
  return files;
}

/**
 * Submit ingest jobs for all new files in a directory.
 * Skips files already in the library (dedup by path).
 */
export async function submitIngestJobs(
  directory: string,
  opts: { enrich: boolean; autoTag: boolean; tags?: string[] },
  library: { list: (tag?: string) => Effect.Effect<Array<{ path: string }>, any, never> },
): Promise<{ submitted: number; skipped: number; total: number }> {
  const targetDir = directory.startsWith("/")
    ? directory
    : join(process.cwd(), directory);

  if (!existsSync(targetDir)) {
    throw new Error(`Directory not found: ${targetDir}`);
  }

  const files = discoverFiles(targetDir);
  if (files.length === 0) {
    return { submitted: 0, skipped: 0, total: 0 };
  }

  // Get existing documents to skip duplicates
  const existingDocs = await Effect.runPromise(library.list());
  const existingPaths = new Set(existingDocs.map((d) => d.path));

  const newFiles = files.filter((f) => !existingPaths.has(f));
  const skipped = files.length - newFiles.length;

  if (newFiles.length === 0) {
    return { submitted: 0, skipped, total: files.length };
  }

  const queue = new Queue<IngestJob>(QUEUE_NAME, { connection: REDIS_CONNECTION });

  try {
    for (const filePath of newFiles) {
      await queue.add(
        `ingest-${basename(filePath)}`,
        {
          filePath,
          options: {
            enrich: opts.enrich,
            autoTag: opts.autoTag,
            tags: opts.tags,
          },
        },
        {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 60_000, // 1 min base → 2 min → 4 min
          },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      );
    }
  } finally {
    await queue.close();
  }

  return { submitted: newFiles.length, skipped, total: files.length };
}

/**
 * Get queue status (waiting/active/completed/failed counts).
 */
export async function getQueueStatus(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = new Queue(QUEUE_NAME, { connection: REDIS_CONNECTION });
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
  } finally {
    await queue.close();
  }
}
