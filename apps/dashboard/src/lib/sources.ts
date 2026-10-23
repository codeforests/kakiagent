import {
  SHEET_EXTENSIONS,
  type FileType,
  type SheetField,
  type Source,
  type SourceFailure,
  type SourcePage,
} from '@kaki/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { updatedLabel } from './facts.ts';

/** Source display rules shared by SCR-APP-023, SCR-APP-024 and the shell (FEAT-012 ui-design). */

export const SOURCE_STATE: Record<
  Source['status'],
  { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' }
> = {
  queued: { label: 'Queued', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'info' },
  ready: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const STAGE_LABEL: Record<NonNullable<Source['stage']>, string> = {
  scan: 'Checking the file',
  parse: 'Reading the file',
  // Spreadsheets (FEAT-016 ui-design).
  map: 'Waiting for you: map the columns',
  import: 'Importing rows',
  crawl: 'Reading pages',
  extract: 'Finding facts',
  promote: 'Saving facts',
};

/** A chat export's own stage names (FEAT-017 ui-design). */
const CHAT_STAGE_LABEL: Partial<Record<NonNullable<Source['stage']>, string>> = {
  parse: 'Reading and removing personal data',
  extract: 'Finding questions and answers',
  promote: 'Saving suggestions',
};

/** The stage in words, for the source's kind. */
export const stageLabel = (s: Pick<Source, 'kind'>, stage: NonNullable<Source['stage']>) =>
  (s.kind === 'chat' ? CHAT_STAGE_LABEL[stage] : undefined) ?? STAGE_LABEL[stage];

export const FAILURE_TEXT: Record<SourceFailure, string> = {
  no_pages: 'No page could be read. robots.txt or the domain limits excluded every page.',
  site_unreachable: "We couldn't reach the site. Check the address and that the site is online.",
  extraction_unavailable:
    'Finding facts failed after several tries. Your pages are saved; try again in a few minutes.',
  internal: 'Something went wrong on our side. Try again; if it fails again, contact support.',
  // Files (FEAT-015 ui-design).
  upload_missing: "The upload didn't finish, so there's nothing to read. Upload the file again.",
  too_large: 'This file is over 25 MB. Upload a smaller file, or split it.',
  unsupported_type:
    "This isn't a file type we can read. Upload a PDF, Word, PowerPoint, text, JPG or PNG file.",
  encrypted:
    'This file is password-protected or encrypted. Save a copy without a password and upload that.',
  malware:
    'This file contains malware, so we deleted it without reading it. Check your computer with antivirus software.',
  scan_unavailable: "We couldn't check this file for malware just now. Try again in a few minutes.",
  unreadable:
    "This file seems damaged and couldn't be read. Open and save it again, then upload the copy.",
  no_text:
    "We couldn't find any text in this file, even in its images. Upload a clearer scan or a text version.",
  // Spreadsheets (FEAT-016 ui-design).
  no_rows:
    "We couldn't find a table with a header row and at least one row below it. Check the first sheet, then upload it again.",
  no_valid_rows:
    'None of the rows could be imported with that mapping. Retry to map the columns again.',
  // Chat exports (FEAT-017 ui-design).
  chat_format:
    "This doesn't look like a chat export we can read. Export the chat from WhatsApp (More › Export chat › Without media) or Telegram Desktop (Export chat history › JSON), then upload that file.",
  business_not_found:
    "We couldn't find any messages from the name you gave. Check how your business's name appears in the chat, then upload the export again. The file has been deleted.",
};

/** A spreadsheet's own words for the safety failures that name a file type (FEAT-016). */
const SHEET_FAILURE_TEXT: Partial<Record<SourceFailure, string>> = {
  unsupported_type:
    'This isn\'t a spreadsheet we can read. Upload an .xlsx file, or a CSV saved as "CSV UTF-8".',
  encrypted: 'This workbook is password-protected. Save a copy without a password and upload that.',
  unreadable:
    "This spreadsheet seems damaged and couldn't be read. Open it, save it again as .xlsx, and upload the copy.",
};

/** A chat export's own words for the safety failures that name a file type (FEAT-017). */
const CHAT_FAILURE_TEXT: Partial<Record<SourceFailure, string>> = {
  unsupported_type:
    'Upload the .txt or .zip file WhatsApp exports, or the result.json file Telegram exports.',
  encrypted:
    'This zip file is password-protected. Export the chat again and upload the file without a password.',
};

/** The failure in words, for the source's kind. */
export const failureText = (s: Pick<Source, 'kind' | 'failure'>) => {
  const failure = s.failure ?? 'internal';
  const own =
    s.kind === 'spreadsheet'
      ? SHEET_FAILURE_TEXT
      : s.kind === 'chat'
        ? CHAT_FAILURE_TEXT
        : undefined;
  return own?.[failure] ?? FAILURE_TEXT[failure];
};

export const PAGE_STATE: Record<
  SourcePage['status'],
  { label: string; tone: 'success' | 'neutral' | 'danger' | 'warning' }
> = {
  included: { label: 'Read', tone: 'success' },
  excluded: { label: 'Excluded', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'warning' },
};

/** The page's result in words (ui-design cross-screen "Page reasons"). */
export function pageResult(p: SourcePage): string {
  switch (p.reason) {
    case null:
      return p.ocrConfidence === null
        ? 'Read'
        : `Read with OCR · ${Math.round(p.ocrConfidence * 100)}% confidence`;
    case 'robots':
      return 'Excluded: blocked by robots.txt';
    case 'off_domain_redirect':
      return 'Excluded: redirects to another site';
    case 'not_html':
      return 'Excluded: not a web page';
    case 'duplicate':
      return 'Excluded: same content as another page';
    case 'timeout':
      return 'Failed: took too long to load';
    case 'http_error':
      return `Failed: the site returned ${p.httpStatus ?? 'an error'}`;
    case 'blocked_address':
      return 'Failed: address not allowed';
    case 'load_error':
      return "Failed: couldn't load";
    case 'plan_limit':
      return 'Skipped: plan limit';
    case 'no_text':
      return 'Excluded: no text found';
    case 'page_limit':
      return 'Skipped: over the 200-page limit';
    case 'ocr_limit':
      return 'Skipped: over the limit of 50 scanned pages';
    default:
      return ROW_REASON_TEXT[p.reason];
  }
}

/** Why a spreadsheet row wasn't imported (FEAT-016 ui-design, cross-screen). */
export const ROW_REASON_TEXT: Record<SheetRowReason, string> = {
  empty_row: 'Empty row',
  no_name: 'No product or service name',
  no_price: 'No price',
  bad_price: "The price isn't an amount in dollars, like 12.50",
  not_sgd: "The price isn't in Singapore dollars",
  bad_stock: "Stock isn't a whole number",
  too_long: 'A name, unit or SKU is too long',
  duplicate: 'Same as an earlier row',
};
export type SheetRowReason =
  | 'empty_row'
  | 'no_name'
  | 'no_price'
  | 'bad_price'
  | 'not_sgd'
  | 'bad_stock'
  | 'too_long'
  | 'duplicate';

/** Files (FEAT-015 ui-design, cross-screen). */
export const FILE_TYPE_LABEL: Record<FileType, string> = {
  pdf: 'PDF',
  docx: 'Word document',
  pptx: 'PowerPoint',
  txt: 'Text file',
  jpeg: 'JPG image',
  png: 'PNG image',
  xlsx: 'Excel workbook',
  csv: 'CSV file',
  // Chat exports (FEAT-017 ui-design): after the parse, `chat.format` names them instead.
  json: 'Telegram export (.json)',
  zip: 'WhatsApp export (.zip)',
};
const EXTENSION_TYPE: Record<string, FileType> = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  txt: 'txt',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  xlsx: 'xlsx',
  csv: 'csv',
  json: 'json',
  zip: 'zip',
};

/** The type the scan named, or, before it has, the one the extension suggests. */
export function fileTypeOf(name: string, type: FileType | null = null): FileType | null {
  return type ?? EXTENSION_TYPE[/\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''] ?? null;
}

export const isImage = (type: FileType | null) => type === 'jpeg' || type === 'png';

/** "2.4 MB", "820 KB" (1 MB = 1,048,576 bytes, as the 25 MB limit). */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${bytes === 0 ? 0 : Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A file page's label from its locator: "Page 3", "Slide 2", "Part 1", "Image", "Row 12". */
export function pageLabel(url: string): string | null {
  const m = /^(page|slide|part|image|row|chat)\/(\d+)$/.exec(url);
  if (!m) return null;
  if (m[1] === 'image') return 'Image';
  if (m[1] === 'chat') return `Part ${m[2]}`;
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}`;
}

/** "Uploaded 23 Oct 2026, 2:30 pm · PDF · 2.4 MB" for a file; "Added …" for a website. */
export function sourceMeta(s: Source): string {
  if (!s.file) return `Added ${updatedLabel(s.createdAt)}`;
  const type = fileTypeOf(s.name, s.file.type);
  const label = s.kind === 'chat' ? chatTypeLabel(s) : type ? FILE_TYPE_LABEL[type] : null;
  return [
    `Uploaded ${updatedLabel(s.createdAt)}`,
    ...(label ? [label] : []),
    sizeLabel(s.file.sizeBytes),
  ].join(' · ');
}

/**
 * What a chat export is (FEAT-017 ui-design): its format once read, else what the upload
 * looks like. Its name is never the file name, so the scan's type decides.
 */
export function chatTypeLabel(s: Pick<Source, 'chat' | 'file'>): string | null {
  if (s.chat) return s.chat.format === 'whatsapp' ? 'WhatsApp chat' : 'Telegram chat';
  const type = s.file?.type;
  if (type === 'txt') return 'WhatsApp export (.txt)';
  return type ? FILE_TYPE_LABEL[type] : null;
}

/** The redaction notice on SCR-APP-007 and SCR-APP-026 (FEAT-017 ui-design). */
export const CHAT_REDACTION_NOTICE =
  "Before anything is saved, we remove customers' names, phone numbers, e-mail addresses, NRIC and card numbers, and addresses. The export file is deleted as soon as it has been read. Nothing is used in answers until you approve it.";

/** "page 3 of menu.pdf", or "your reply in WhatsApp chat, …" for a chat export (FEAT-017). */
export function provenanceWords(location: { unit: string; number: number }, name: string) {
  return location.unit === 'chat'
    ? `your reply in ${name}`
    : `${locationWords(location)} of ${name}`;
}

/** "page 3", "slide 2", "part 1", "the image", "row 12": where in a file a fact was found. */
export function locationWords(location: { unit: string; number: number }): string {
  return location.unit === 'image' ? 'the image' : `${location.unit} ${location.number}`;
}

/** A fact from a spreadsheet row was imported, not found: it has no confidence (FEAT-016). */
export const isImported = (location: { unit: string } | null | undefined) =>
  location?.unit === 'row';

/** Spreadsheets (FEAT-016 ui-design, cross-screen). */
export const SHEET_FIELD_LABEL: Record<SheetField, string> = {
  product: 'Product name',
  service: 'Service name',
  price: 'Price',
  unit: 'Unit or size',
  sku: 'SKU or item code',
  stock: 'Stock',
};

/** A name the files part uploads as a spreadsheet source. */
export const isSheetName = (name: string) =>
  SHEET_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

/** A spreadsheet waiting for the owner's mapping: queued at `map`, with no job (D3). */
export const waitingToMap = (s: Pick<Source, 'kind' | 'status' | 'stage'>) =>
  s.kind === 'spreadsheet' && s.status === 'queued' && s.stage === 'map';

/** What a file's pages are called: slides for PowerPoint, parts for Word and text. */
export function unitWords(s: Source): { one: string; many: string } | null {
  const type = s.file ? fileTypeOf(s.name, s.file.type) : null;
  if (!s.file) return { one: 'page', many: 'pages' };
  if (s.kind === 'spreadsheet') return { one: 'row', many: 'rows' };
  if (s.kind === 'chat') return { one: 'part', many: 'parts' };
  if (isImage(type)) return null;
  if (type === 'pptx') return { one: 'slide', many: 'slides' };
  if (type === 'docx' || type === 'txt') return { one: 'part', many: 'parts' };
  return { one: 'page', many: 'pages' };
}

/** Being worked on: polled, with progress. A spreadsheet waiting at `map` is not. */
export const busy = (s: Source) =>
  (s.status === 'queued' || s.status === 'processing') && !waitingToMap(s);

/**
 * How far the current stage is, 0–100, or null when it can't be told (promote, or a crawl
 * that hasn't found its first page yet).
 */
export function stageProgress(s: Source): { done: number; of: number; percent: number } | null {
  const c = s.counts;
  if (s.stage === 'crawl') {
    const done = c.pagesIncluded + c.pagesExcluded + c.pagesFailed;
    const of = Math.max(c.pagesFound, done, 1);
    return c.pagesFound ? { done, of, percent: Math.round((done / of) * 100) } : null;
  }
  if (s.stage === 'extract' && c.pagesIncluded > 0) {
    const percent = Math.round((c.pagesExtracted / c.pagesIncluded) * 100);
    return { done: c.pagesExtracted, of: c.pagesIncluded, percent };
  }
  return null;
}

/**
 * "38 facts · 38 need review · 31 pages read" (ready; files add " · 3 by OCR", say slides
 * or parts, and say nothing about pages for an image), or the busy stage text.
 */
export function sourceSummary(s: Source): string {
  const c = s.counts;
  if (s.kind === 'spreadsheet' && s.status === 'ready')
    return [
      `${c.facts} ${c.facts === 1 ? 'fact' : 'facts'} imported`,
      ...(c.pagesFailed
        ? [`${c.pagesFailed} ${c.pagesFailed === 1 ? 'row' : 'rows'} not imported`]
        : []),
    ].join(' · ');
  if (waitingToMap(s)) return STAGE_LABEL.map;
  // A chat export's findings are suggested FAQs (FEAT-017 ui-design).
  if (s.kind === 'chat' && s.status === 'ready')
    return c.facts === 0
      ? 'No questions found'
      : `${c.facts} suggested ${c.facts === 1 ? 'FAQ' : 'FAQs'}`;
  const unit = unitWords(s);
  const ocr = s.file && s.file.ocrPages > 0 ? ` · ${s.file.ocrPages} by OCR` : '';
  const pages = unit
    ? ` · ${c.pagesIncluded} ${c.pagesIncluded === 1 ? unit.one : unit.many} read${ocr}`
    : '';
  if (s.status === 'ready')
    return c.facts === 0
      ? `No facts found${pages}`
      : `${c.facts} ${c.facts === 1 ? 'fact' : 'facts'} · ${c.factsNeedingReview} need review${pages}`;
  if (s.status === 'failed') return failureText(s);
  const stage = s.stage ? stageLabel(s, s.stage) : 'Waiting';
  // A queued source that started a stage is waiting for a retry (UC-03 5c).
  if (s.status === 'queued' && s.stage && s.stage !== 'crawl') return `${stage} · waiting to retry`;
  const p = stageProgress(s);
  return p ? `${stage} · ${p.done} of ${p.of}` : stage;
}

/** True while the page is visible (polling stops when the tab is hidden, D6). */
export function useVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

export const POLL_MS = 2000;

/**
 * The tenant's sources, refetched every 2 s while one is queued or processing and the tab
 * is visible (technical design D6). `enabled` is false for roles without `kb.manage`.
 */
export function useSources(enabled = true) {
  const visible = useVisible();
  return useQuery({
    queryKey: ['sources'],
    queryFn: api.sources,
    enabled,
    refetchInterval: (q) => (visible && q.state.data?.sources.some(busy) ? POLL_MS : false),
  });
}

/** A source with its pages, polled like the list while it is busy. */
export function useSource(id: string) {
  const visible = useVisible();
  return useQuery({
    queryKey: ['source', id],
    queryFn: () => api.source(id),
    refetchInterval: (q) =>
      visible && q.state.data && busy(q.state.data.source) ? POLL_MS : false,
  });
}

const stateOf = (s: Source) => (waitingToMap(s) ? 'map' : s.status);

/**
 * The polite announcement of a source's status change (ui-design: "kakibakery.sg is
 * ready. 38 facts need review."), never every count change.
 */
export function useStatusAnnouncements(sources: Source[] | undefined) {
  const [message, setMessage] = useState('');
  const [seen, setSeen] = useState<ReadonlyMap<string, string>>(new Map());
  // A spreadsheet reaching `map` is a change too ("ready to map").
  const key = sources?.map((s) => `${s.id}:${stateOf(s)}`).join() ?? '';
  const [seenKey, setSeenKey] = useState(key);
  // Adjusted while rendering (React's pattern for state derived from a changed prop).
  if (sources && key !== seenKey) {
    const said: string[] = [];
    for (const s of sources) {
      const before = seen.get(s.id);
      if (!before || before === stateOf(s)) continue;
      if (waitingToMap(s)) said.push(`${s.name} is ready to map.`);
      else if (s.status === 'ready' && s.kind === 'spreadsheet')
        said.push(`${s.counts.facts} ${s.counts.facts === 1 ? 'row' : 'rows'} imported.`);
      else if (s.status === 'ready')
        said.push(
          `${s.name} is ready. ${s.counts.factsNeedingReview} ${s.counts.factsNeedingReview === 1 ? 'fact needs' : 'facts need'} review.`,
        );
      else if (s.status === 'failed') said.push(`${s.name} failed. ${sourceSummary(s)}`);
      else if (s.status === 'processing') said.push(`Reading ${s.name}.`);
    }
    setSeenKey(key);
    setSeen(new Map(sources.map((s) => [s.id, stateOf(s)])));
    if (said.length) setMessage(said.join(' '));
  }
  return [message, setMessage] as const;
}

/** Retry on a failed source (KB-12), refreshing what shows it. */
export function useRetry(onRetried: (s: Source) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (s: Source) => api.retrySource(s.id, s.version),
    onSuccess: async ({ source }) => {
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
      await queryClient.invalidateQueries({ queryKey: ['source', source.id] });
      onRetried(source);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });
}

export const failedCount = (sources: Source[] | undefined) =>
  sources?.filter((s) => s.status === 'failed').length ?? 0;
