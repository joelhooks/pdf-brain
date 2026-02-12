/**
 * Queue-based ingest worker: processes one PDF/Markdown file at a time via BullMQ.
 */
import { Worker, Job } from "bullmq";
import { Effect, Layer } from "effect";
import { extname } from "path";
import {
  PDFLibrary,
  makePDFLibraryLive,
  AddOptions,
} from "../index.js";
import {
  AutoTagger,
  AutoTaggerLive,
} from "../services/AutoTagger.js";
import { PDFExtractor, PDFExtractorLive } from "../services/PDFExtractor.js";
import {
  EmbeddingProvider,
  EmbeddingProviderFullLive,
} from "../services/EmbeddingProvider.js";
import {
  TaxonomyServiceImpl,
  TaxonomyService,
} from "../services/TaxonomyService.js";
import { MigrationLive } from "../services/Migration.js";
import { LibraryConfig } from "../types.js";
import { QUEUE_NAME, type IngestJob } from "./ingest-producer.js";

const REDIS_CONNECTION = { host: "localhost", port: 6379 };

/**
 * Process a single ingest job: extract → chunk → embed → store.
 */
async function processIngestJob(
  job: Job<IngestJob>,
  appLayer: Layer.Layer<any, any, never>,
): Promise<{ title: string; id: string; pageCount: number }> {
  const { filePath, options } = job.data;

  const program = Effect.gen(function* () {
    const library = yield* PDFLibrary;

    // Check if already ingested (race condition guard)
    const existingDocs = yield* library.list();
    const alreadyExists = existingDocs.some((d) => d.path === filePath);
    if (alreadyExists) {
      return { title: "(already exists)", id: "skipped", pageCount: 0 };
    }

    let fileTags = options.tags ? [...options.tags] : [];
    let title: string | undefined;

    if (options.enrich || options.autoTag) {
      const tagger = yield* AutoTagger;
      const pdfExtractor = yield* PDFExtractor;
      const ext = extname(filePath).toLowerCase();
      let content: string | undefined;

      if (ext === ".pdf" && options.enrich) {
        const extractResult = yield* Effect.either(
          pdfExtractor.extract(filePath),
        );
        if (extractResult._tag === "Right") {
          const pages = extractResult.right.pages.slice(0, 10);
          content = pages.map((p) => p.text).join("\n\n");
          if (content.length > 8000) content = content.slice(0, 8000);
        }
      } else if (ext === ".md" || ext === ".markdown") {
        const readResult = yield* Effect.either(
          Effect.promise(() => Bun.file(filePath).text()),
        );
        if (readResult._tag === "Right") content = readResult.right;
      }

      if (options.enrich && content) {
        const enrichResult = yield* tagger.enrich(filePath, content, {});
        title = enrichResult.title;
        fileTags = [...fileTags, ...enrichResult.tags];
      } else if (options.autoTag) {
        const tagResult = yield* tagger.generateTags(filePath, content, {
          heuristicsOnly: !content,
        });
        fileTags = [...fileTags, ...tagResult.allTags];
      }
    }

    yield* Effect.promise(() => job.updateProgress(10));

    const doc = yield* library.add(
      filePath,
      new AddOptions({
        title,
        tags: fileTags.length > 0 ? fileTags : undefined,
      }),
    );

    yield* Effect.promise(() => job.updateProgress(100));

    // Checkpoint after each file for crash safety
    yield* Effect.either(library.checkpoint());

    return { title: doc.title, id: doc.id, pageCount: doc.pageCount };
  });

  return Effect.runPromise(
    program.pipe(Effect.provide(appLayer), Effect.scoped),
  );
}

/**
 * Start the ingest worker. Blocks until SIGINT/SIGTERM.
 */
export async function startWorker(): Promise<void> {
  const config = LibraryConfig.fromEnv();
  const TaxonomyServiceLive = TaxonomyServiceImpl.make({
    url: `file:${config.dbPath}`,
  });

  const pdfLibraryLive = makePDFLibraryLive();
  const AppLayer = Layer.merge(
    Layer.merge(
      Layer.merge(pdfLibraryLive, AutoTaggerLive),
      PDFExtractorLive,
    ),
    Layer.merge(
      Layer.merge(TaxonomyServiceLive, EmbeddingProviderFullLive),
      MigrationLive,
    ),
  );

  const worker = new Worker<IngestJob>(
    QUEUE_NAME,
    async (job) => {
      console.log(
        `[worker] Processing job ${job.id}: ${job.data.filePath}`,
      );
      try {
        const result = await processIngestJob(job, AppLayer);
        console.log(
          `[worker] ✓ ${result.title} (${result.pageCount} pages)`,
        );
        return result;
      } catch (err) {
        console.error(
          `[worker] ✗ ${job.data.filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    },
    {
      connection: REDIS_CONNECTION,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, err) => {
    const attempt = job?.attemptsMade ?? "?";
    console.error(
      `[worker] Job ${job?.id} failed (attempt ${attempt}/3): ${err.message}`,
    );
  });

  worker.on("completed", (job) => {
    console.log(`[worker] Job ${job.id} completed`);
  });

  console.log(`[worker] Listening on queue "${QUEUE_NAME}" (concurrency: 1)`);
  console.log(`[worker] Press Ctrl+C to stop`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[worker] Shutting down...");
    await worker.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  await new Promise(() => {});
}
