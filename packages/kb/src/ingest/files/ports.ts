import type { schema } from '@kaki/db';

/** What a file's bytes are (FEAT-015 §5.3). */
export type FileType = (typeof schema.FILE_TYPES)[number];

export type Bucket = 'quarantine' | 'sources';

/** The two buckets (ADR-018 d2): uploads wait in quarantine; only clean files reach sources. */
export interface FileStore {
  head(bucket: Bucket, key: string): Promise<{ size: number } | null>;
  get(bucket: Bucket, key: string): Promise<Uint8Array>;
  copyToSources(fromKey: string, toKey: string): Promise<void>;
  /** A missing key is not an error, so purging twice is fine. */
  delete(bucket: Bucket, key: string): Promise<void>;
}

/** The scanner couldn't answer (down, timed out, no verdict yet); the stage is retried. */
export class ScannerUnavailableError extends Error {}

/** ClamAV locally and as ADR-019's fallback, GuardDuty Malware Protection at MD. */
export interface MalwareScanner {
  scan(file: {
    key: string;
    bytes: Uint8Array;
  }): Promise<{ infected: false } | { infected: true; signature: string }>;
}

/** OCR couldn't run (the binary failed); the stage is retried. */
export class OcrUnavailableError extends Error {}

/** Tesseract 5 with `eng+chi_sim` (ADR-019). `confidence` is 0..1. */
export interface OcrEngine {
  recognize(png: Uint8Array): Promise<{ text: string; confidence: number }>;
}

/** Renders one PDF page (1-based) to a PNG for OCR. */
export interface PdfRasterizer {
  render(pdf: Uint8Array, page: number): Promise<Uint8Array>;
}

export interface FileLimits {
  /** Pages read per file; later ones are `skipped: page_limit` (D8). */
  pages: number;
  /** Pages OCR'd per file; later ones needing OCR are `skipped: ocr_limit` (D8). */
  ocrPages: number;
  /** OCR'd pages at once. */
  ocrConcurrency: number;
  /** A spreadsheet's data rows read; later ones are only counted (FEAT-016 D10). */
  sheetRows: number;
  /** A chat export's messages read, the latest kept (FEAT-017 D9). */
  chatMessages: number;
  /** A chat export's conversation parts stored (FEAT-017 §5.3 step 6). */
  chatParts: number;
}

export const DEFAULT_FILE_LIMITS: FileLimits = {
  pages: 200,
  ocrPages: 50,
  ocrConcurrency: 2,
  sheetRows: 2000,
  chatMessages: 20_000,
  chatParts: 200,
};

export interface FileDeps {
  store: FileStore;
  scanner: MalwareScanner;
  ocr: OcrEngine;
  rasterizer: PdfRasterizer;
  limits?: Partial<FileLimits>;
}

/** KB-02: up to 25 MB each (the API checks the declared size; the scan the real one). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
