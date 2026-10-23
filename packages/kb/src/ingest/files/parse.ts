import { unzipSync } from 'fflate';
import { fileLocator, type FileUnit } from '../../facts.js';
import { MAX_PAGE_TEXT, MIN_PAGE_TEXT } from '../crawl.js';
import { openPdf, pageText } from './pdf.js';
import {
  DEFAULT_FILE_LIMITS,
  type FileLimits,
  type FileType,
  type OcrEngine,
  type PdfRasterizer,
} from './ports.js';

/** One page, slide or part of a file, as `kb_source_pages` keeps it (FEAT-015 §5.4). */
export type ParsedPage =
  | { url: string; status: 'included'; reason: null; text: string; ocrConfidence: number | null }
  | { url: string; status: 'excluded'; reason: 'no_text'; text: null; ocrConfidence: number | null }
  | {
      url: string;
      status: 'skipped';
      reason: 'page_limit' | 'ocr_limit';
      text: null;
      ocrConfidence: null;
    };

export type ParseOutcome = { ok: true; pages: ParsedPage[] } | { ok: false; failure: 'unreadable' };

export interface ParseDeps {
  ocr: OcrEngine;
  rasterizer: PdfRasterizer;
  limits?: Partial<FileLimits>;
}

/** DOCX and PPTX parts are decompressed up to this much in total (the zip-bomb guard). */
export const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
/** Skipped pages listed per file, like the crawl's skipped rows. */
export const MAX_SKIPPED_PAGES = 2000;

/** Whitespace inside a line collapsed, tabs kept (table cells), blank-line runs folded. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) =>
      l
        .replace(/[^\S\t\n]+/g, ' ')
        .replace(/ *\t */g, '\t')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const hasText = (t: string) => t.replace(/\s+/g, '').length >= MIN_PAGE_TEXT;

/** Splits text into parts of at most `MAX_PAGE_TEXT` characters at line boundaries. */
export function splitParts(text: string, max = MAX_PAGE_TEXT): string[] {
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    // A single line longer than a part is cut where it has to be.
    for (let rest = line; ;) {
      const room = max - current.length - (current ? 1 : 0);
      if (rest.length <= room) {
        current = current ? `${current}\n${rest}` : rest;
        break;
      }
      if (current) {
        parts.push(current);
        current = '';
        continue;
      }
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
  }
  if (current) parts.push(current);
  return parts;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#')
      return String.fromCodePoint(
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    return ENTITIES[e] ?? m;
  });

/**
 * Text of WordprocessingML or DrawingML: `w:t`/`a:t` runs, a line per paragraph, `w:tab` a
 * tab, `w:br`/`w:cr` a line break; in Word tables, cells are joined by tabs and rows by
 * line breaks.
 */
export function xmlText(xml: string): string {
  const token = /<(\/?)([a-z]+:[a-zA-Z]+)\b[^>]*?(\/?)>|([^<]+)/g;
  let out = '';
  let inText = false;
  let tableDepth = 0;
  for (const m of xml.matchAll(token)) {
    const [, close, tag, selfClose, chars] = m;
    if (chars !== undefined) {
      if (inText) out += decodeXml(chars);
      continue;
    }
    if (tag === 'w:t' || tag === 'a:t') inText = !close && !selfClose;
    else if (tag === 'w:tab' && !close) out += '\t';
    else if ((tag === 'w:br' || tag === 'w:cr' || tag === 'a:br') && !close) out += '\n';
    else if (tag === 'w:tbl') tableDepth += close ? -1 : selfClose ? 0 : 1;
    else if (tag === 'w:p' || tag === 'a:p') {
      if (close || selfClose) out += tableDepth > 0 ? ' ' : '\n';
    } else if (tag === 'w:tc' && close) out += '\t';
    else if (tag === 'w:tr' && close) out += '\n';
  }
  return out;
}

/** The ZIP's entries the filter keeps, refusing more than `MAX_UNZIPPED_BYTES` in total. */
export function unzipSome(
  bytes: Uint8Array,
  keep: (name: string) => boolean,
): Map<string, string> | null {
  let total = 0;
  try {
    const files = unzipSync(bytes, {
      filter: (f) => {
        if (!keep(f.name)) return false;
        total += f.originalSize;
        if (total > MAX_UNZIPPED_BYTES) throw new Error('too large unzipped');
        return true;
      },
    });
    const decoder = new TextDecoder();
    return new Map(Object.entries(files).map(([k, v]) => [k, decoder.decode(v)]));
  } catch {
    return null;
  }
}

const textPages = (unit: FileUnit, texts: string[]): ParsedPage[] =>
  texts.map((text, i) => {
    const url = fileLocator(unit, i + 1);
    const t = tidy(text).slice(0, MAX_PAGE_TEXT);
    return hasText(t)
      ? { url, status: 'included', reason: null, text: t, ocrConfidence: null }
      : { url, status: 'excluded', reason: 'no_text', text: null, ocrConfidence: null };
  });

/** Runs `fn` over `items` with at most `n` at once, keeping their order. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function ocrPage(url: string, image: Uint8Array, ocr: OcrEngine): Promise<ParsedPage> {
  const { text, confidence } = await ocr.recognize(image);
  const t = tidy(text).slice(0, MAX_PAGE_TEXT);
  const c = Math.min(1, Math.max(0, confidence));
  return hasText(t)
    ? { url, status: 'included', reason: null, text: t, ocrConfidence: c }
    : { url, status: 'excluded', reason: 'no_text', text: null, ocrConfidence: c };
}

/**
 * A clean file's pages (KB-02; FEAT-015 §5.4): the PDF text layer page by page, with OCR
 * for pages that have none; DOCX and TXT in parts; PPTX a page per slide; an image as one
 * OCR'd page. Pages over the limits are listed as skipped, not read (D8). OCR errors are
 * thrown (the stage is retried); a file that can't be read is `unreadable`.
 */
export async function parseFile(
  bytes: Uint8Array,
  type: FileType,
  deps: ParseDeps,
): Promise<ParseOutcome> {
  const limits = { ...DEFAULT_FILE_LIMITS, ...deps.limits };
  switch (type) {
    // Spreadsheets and chat exports have their own parse (FEAT-016 §5.3, FEAT-017 §5.3); a
    // file is never one (the scan).
    case 'xlsx':
    case 'csv':
    case 'json':
    case 'zip':
      return { ok: false, failure: 'unreadable' };
    case 'txt': {
      // TextDecoder drops a byte-order mark.
      const text = new TextDecoder().decode(bytes);
      return { ok: true, pages: textPages('part', splitParts(tidy(text))) };
    }
    case 'docx': {
      const files = unzipSome(bytes, (n) => n === 'word/document.xml');
      const xml = files?.get('word/document.xml');
      if (xml === undefined) return { ok: false, failure: 'unreadable' };
      return { ok: true, pages: textPages('part', splitParts(tidy(xmlText(xml)))) };
    }
    case 'pptx': {
      const slide = /^ppt\/slides\/slide(\d+)\.xml$/;
      const files = unzipSome(bytes, (n) => slide.test(n));
      if (!files) return { ok: false, failure: 'unreadable' };
      const slides = [...files]
        .map(([name, xml]) => ({ n: Number(slide.exec(name)![1]), xml }))
        .sort((a, b) => a.n - b.n);
      const pages = textPages(
        'slide',
        slides.map((s) => xmlText(s.xml)),
      ).slice(0, limits.pages);
      return { ok: true, pages: [...pages, ...skipped('slide', limits.pages, slides.length)] };
    }
    case 'png':
    case 'jpeg':
      return { ok: true, pages: [await ocrPage(fileLocator('image', 1), bytes, deps.ocr)] };
    case 'pdf': {
      const opened = await openPdf(bytes);
      if (!opened.ok) return { ok: false, failure: 'unreadable' };
      const { doc } = opened;
      try {
        const read = Math.min(doc.numPages, limits.pages);
        const pages: (ParsedPage | null)[] = [];
        const needOcr: number[] = [];
        for (let n = 1; n <= read; n++) {
          const text = tidy(await pageText(doc, n)).slice(0, MAX_PAGE_TEXT);
          if (hasText(text))
            pages.push({
              url: fileLocator('page', n),
              status: 'included',
              reason: null,
              text,
              ocrConfidence: null,
            });
          else {
            pages.push(null);
            needOcr.push(n);
          }
        }
        const ocrNow = needOcr.slice(0, limits.ocrPages);
        const ocred = await pool(ocrNow, limits.ocrConcurrency, async (n) =>
          ocrPage(fileLocator('page', n), await deps.rasterizer.render(bytes, n), deps.ocr),
        );
        ocrNow.forEach((n, i) => (pages[n - 1] = ocred[i]!));
        for (const n of needOcr.slice(limits.ocrPages))
          pages[n - 1] = {
            url: fileLocator('page', n),
            status: 'skipped',
            reason: 'ocr_limit',
            text: null,
            ocrConfidence: null,
          };
        return {
          ok: true,
          pages: [...(pages as ParsedPage[]), ...skipped('page', read, doc.numPages)],
        };
      } catch (err) {
        // A page pdf.js can't read makes the file unreadable; OCR failures are retried.
        if (err instanceof Error && err.name.endsWith('Exception'))
          return { ok: false, failure: 'unreadable' };
        throw err;
      } finally {
        await opened.close();
      }
    }
  }
}

/** Pages `from + 1 … total`, listed as skipped by the page limit. */
function skipped(unit: FileUnit, from: number, total: number): ParsedPage[] {
  const out: ParsedPage[] = [];
  for (let n = from + 1; n <= Math.min(total, from + MAX_SKIPPED_PAGES); n++)
    out.push({
      url: fileLocator(unit, n),
      status: 'skipped',
      reason: 'page_limit',
      text: null,
      ocrConfidence: null,
    });
  return out;
}
