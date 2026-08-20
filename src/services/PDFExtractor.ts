/**
 * PDF Extraction Service
 */

import { Effect, Context, Layer } from "effect";
import { $ } from "bun";
import {
  PDFExtractionError,
  PDFNotFoundError,
  LibraryConfig,
} from "../types.js";
import { existsSync } from "fs";
import { homedir } from "node:os";

// ============================================================================
// Service Definition
// ============================================================================

export interface ExtractedPage {
  page: number;
  text: string;
}

export interface ExtractedPDF {
  pages: ExtractedPage[];
  pageCount: number;
}

export interface ProcessedChunk {
  page: number;
  chunkIndex: number;
  content: string;
}

export class PDFExtractor extends Context.Tag("PDFExtractor")<
  PDFExtractor,
  {
    readonly extract: (
      path: string
    ) => Effect.Effect<ExtractedPDF, PDFExtractionError | PDFNotFoundError>;
    readonly process: (
      path: string
    ) => Effect.Effect<
      { pageCount: number; chunks: ProcessedChunk[] },
      PDFExtractionError | PDFNotFoundError
    >;
  }
>() {}

// ============================================================================
// Implementation
// ============================================================================

const EXTRACT_SCRIPT = `
import sys
import json
from pypdf import PdfReader

reader = PdfReader(sys.argv[1])
pages = []
for i, page in enumerate(reader.pages):
    text = page.extract_text() or ""
    pages.append({"page": i + 1, "text": text})

print(json.dumps({"pageCount": len(reader.pages), "pages": pages}))
`;

/**
 * Sanitize text by removing null bytes that crash PostgreSQL TEXT columns
 */
export function sanitizeText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping null bytes
  return text.replace(/\x00/g, "");
}

/**
 * Chunk text with intelligent splitting
 */
export function chunkText(
  text: string,
  chunkSize: number,
  chunkOverlap: number
): string[] {
  const chunks: string[] = [];

  // Clean up text - sanitize first, then normalize while preserving paragraph structure.
  //
  // IMPORTANT: Do NOT collapse `\s+` here. In PDFs, newlines often carry meaning
  // (paragraph breaks). Collapsing all whitespace nukes paragraph boundaries and
  // makes chunking far worse.
  const cleaned = (() => {
    let t = sanitizeText(text);

    // Normalize newlines from various PDF extractors/platforms.
    t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\f/g, "\n");

    // Normalize non-breaking spaces.
    t = t.replace(/\u00a0/g, " ");

    // Remove common hyphenation artifacts at line breaks: "inter-\nnational"
    t = t.replace(/([A-Za-z])-\n([A-Za-z])/g, "$1$2");

    // Trim trailing/leading whitespace per line.
    t = t
      .split("\n")
      .map((line) => line.trim())
      .join("\n");

    // Collapse long blank runs.
    t = t.replace(/\n{3,}/g, "\n\n");

    // Reconstruct paragraphs:
    // - split on blank lines
    // - within a paragraph, join wrapped lines with spaces
    const paragraphs = t
      .split(/\n\s*\n+/)
      .map((p) => p.replace(/\n+/g, " ").replace(/[ \t]+/g, " ").trim())
      .filter(Boolean);

    return paragraphs.join("\n\n").trim();
  })();

  if (cleaned.length <= chunkSize) {
    return cleaned ? [cleaned] : [];
  }

  // Try to split on paragraph boundaries first
  const paragraphs = cleaned.split(/\n\n+/);
  let currentChunk = "";

  for (const para of paragraphs) {
    if (currentChunk.length + para.length + 2 <= chunkSize) {
      currentChunk += (currentChunk ? "\n\n" : "") + para;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
      }

      // If paragraph itself is too long, split by sentences
      if (para.length > chunkSize) {
        const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
        currentChunk = "";

        for (const sentence of sentences) {
          if (currentChunk.length + sentence.length <= chunkSize) {
            currentChunk += sentence;
          } else {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            // If sentence is still too long, hard split
            if (sentence.length > chunkSize) {
              for (
                let i = 0;
                i < sentence.length;
                i += chunkSize - chunkOverlap
              ) {
                chunks.push(sentence.slice(i, i + chunkSize).trim());
              }
              currentChunk = "";
            } else {
              currentChunk = sentence;
            }
          }
        }
      } else {
        currentChunk = para;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.filter((c) => c.length > 20); // Filter tiny chunks
}

export const PDFExtractorLive = Layer.effect(
  PDFExtractor,
  Effect.gen(function* () {
    const config = LibraryConfig.fromEnv();

    return {
      extract: (path: string) =>
        Effect.gen(function* () {
          // Resolve path
          const resolvedPath = path.startsWith("~")
            ? path.replace("~", process.env.HOME || homedir())
            : path;

          if (!existsSync(resolvedPath)) {
            return yield* Effect.fail(
              new PDFNotFoundError({ path: resolvedPath })
            );
          }

          const result = yield* Effect.tryPromise({
            try: async () => {
              const output =
                await $`uv run --with pypdf python -c ${EXTRACT_SCRIPT} ${resolvedPath}`.text();
              return JSON.parse(output) as ExtractedPDF;
            },
            catch: (e) =>
              new PDFExtractionError({ path: resolvedPath, reason: String(e) }),
          });

          return result;
        }),

      process: (path: string) =>
        Effect.gen(function* () {
          const resolvedPath = path.startsWith("~")
            ? path.replace("~", process.env.HOME || homedir())
            : path;

          if (!existsSync(resolvedPath)) {
            return yield* Effect.fail(
              new PDFNotFoundError({ path: resolvedPath })
            );
          }

          const extracted = yield* Effect.tryPromise({
            try: async () => {
              const output =
                await $`uv run --with pypdf python -c ${EXTRACT_SCRIPT} ${resolvedPath}`.text();
              return JSON.parse(output) as ExtractedPDF;
            },
            catch: (e) =>
              new PDFExtractionError({ path: resolvedPath, reason: String(e) }),
          });

          const allChunks: ProcessedChunk[] = [];

          for (const { page, text } of extracted.pages) {
            const pageChunks = chunkText(
              text,
              config.chunkSize,
              config.chunkOverlap
            );
            pageChunks.forEach((content, chunkIndex) => {
              allChunks.push({ page, chunkIndex, content });
            });
          }

          return { pageCount: extracted.pageCount, chunks: allChunks };
        }),
    };
  })
);
