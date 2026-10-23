/**
 * Public interface of the `kb` module (architecture §5.2): facts, versions and chunks
 * (FEAT-022, FEAT-011), sources and the ingest pipeline (FEAT-012), review (FEAT-013), conflicts (FEAT-014). Other modules may import only this file (dependency-cruiser enforces it).
 */
export {
  NO_VALIDITY,
  POLICY_KINDS,
  type FaqValue,
  type GstTreatment,
  type PolicyKind,
  type PolicyValue,
  type ProductValue,
  type PromotionValue,
  type Validity,
  type VisitorFact,
} from './types.js';
export { isSgDate, sgDateOf, sgDayAfter, sgDayLabel, sgDayStart, sgLastDayOf } from './dates.js';
export {
  dashboardKb,
  ingestKb,
  visitorKb,
  type DashboardKbContext,
  type IngestKbContext,
  type VisitorKbContext,
} from './context.js';
export {
  EmbeddingUnavailableError,
  FactNotFoundError,
  FileLimitError,
  NotRetryableError,
  BadMappingError,
  GstRequiredError,
  InvalidCursorError,
  InvalidFactError,
  InvalidStateError,
  SourceExistsError,
  SourceNotFoundError,
  VersionConflictError,
} from './errors.js';
export { chunkContent, prepareChunk, type PreparedChunk } from './chunk.js';
export {
  checkFact,
  contentChanged,
  createFact,
  DEFAULT_PAGE_SIZE,
  deleteFact,
  fileLocator,
  getFact,
  listFacts,
  mergePatch,
  updateFact,
  type FactFilter,
  type FactInput,
  type FactPage,
  type FactPatch,
  type FactRecord,
  type FactStatus,
  type FactType,
  type FileUnit,
  locationOf,
  type Provenance,
} from './facts.js';
export {
  approveAll,
  approveFact,
  approveSelected,
  listReviewFacts,
  passageOf,
  previewApproveAll,
  PreviewStaleError,
  rejectFact,
  rejectSelected,
  REVIEW_ORDER,
  REVIEW_PAGE_SIZE,
  reviewSummary,
  undoReview,
  UNDO_WINDOW_MINUTES,
  type ApprovePreview,
  type FactRef,
  type Passage,
  type ReviewPage,
  type ReviewRecord,
  type ReviewScope,
  type ReviewSummary,
  type SkipReason,
  type Skipped,
  type TypeCounts,
} from './review.js';
export {
  countFileSources,
  createFileSource,
  createWebsiteSource,
  extensionOf,
  quarantineKey,
  sourcesKey,
  deleteSource,
  getSource,
  listSources,
  NOT_RETRYABLE,
  isUpload,
  retryable,
  retrySource,
  sourceFactCounts,
  type PageReason,
  type PageRecord,
  type PageStatus,
  type SourceFailure,
  type SourceRecord,
  type SourceStage,
  type SourceStatus,
} from './sources.js';
export {
  assertPublicHost,
  isPublicAddress,
  dnsResolver,
  NonPublicHostError,
  type Resolver,
} from './ingest/address.js';
export {
  inScope,
  InvalidWebsiteError,
  normaliseUrl,
  parseWebsite,
  type WebsiteScope,
} from './ingest/scope.js';
export { DEFAULT_SEARCH, searchVisitorFacts, type SearchOptions } from './visitor.js';
export {
  crawlSource,
  hostsOf,
  MAX_PAGE_TEXT,
  StaleRunError,
  type CrawlOptions,
  type CrawlOutcome,
  type FetchedPage,
  type PageFetcher,
  type PageFetcherFactory,
} from './ingest/crawl.js';
export { BOT_USER_AGENT, parseRobots, robotsPolicy, type RobotsPolicy } from './ingest/robots.js';
export {
  EXTRACTION_SCHEMA,
  EXTRACTION_SYSTEM,
  ExtractionUnavailableError,
  FILE_EXTRACTION_SYSTEM,
  extractPage,
  extractSource,
  locateQuote,
  parseExtraction,
  priceCents,
  type DropReason,
  type ExtractOptions,
  type StagedFact,
} from './ingest/extract.js';
export { fakeExtractScript } from './ingest/fake-extract.js';
export { fakeMineScript } from './ingest/chats/fake-mine.js';
export { MINING_SYSTEM, parseMining, minePart } from './ingest/chats/mine.js';
export { promoteSource } from './ingest/promote.js';
export { conflictId, entityKey, sameValue } from './conflicts.js';
export {
  ConflictChangedError,
  listConflicts,
  resolveConflict,
  type ConflictFactRecord,
  type ConflictRecord,
  type Resolution,
} from './resolve.js';
export {
  DEFAULT_MAX_ATTEMPTS,
  runIngestJob,
  type IngestDeps,
  type IngestJobBody,
  type PurgeJobBody,
  type StageJobBody,
  type IngestOutcome,
} from './ingest/job.js';
export {
  DEFAULT_FILE_LIMITS,
  MAX_FILE_BYTES,
  OcrUnavailableError,
  ScannerUnavailableError,
  type Bucket,
  type FileDeps,
  type FileLimits,
  type FileStore,
  type FileType,
  type MalwareScanner,
  type OcrEngine,
  type PdfRasterizer,
} from './ingest/files/ports.js';
export { sniffType, type Sniffed } from './ingest/files/sniff.js';
export { parseFile, type ParsedPage, type ParseOutcome } from './ingest/files/parse.js';
export { scanFile, type ScanOutcome } from './ingest/files/scan-stage.js';
// Spreadsheets (FEAT-016).
export { readCsv } from './ingest/sheets/csv.js';
export { readXlsx, type XlsxOutcome } from './ingest/sheets/xlsx.js';
export {
  tableOf,
  type SheetColumn,
  type SheetRow,
  type SheetTable,
} from './ingest/sheets/table.js';
export {
  SHEET_FIELDS,
  suggestMapping,
  type ColumnMapping,
  type SheetField,
  type Suggestion,
} from './ingest/sheets/suggest.js';
export { checkMapping, mapRows, type RowOutcome } from './ingest/sheets/rows.js';
export { parsePrice, parseStock, centsText } from './ingest/sheets/money.js';
export {
  importSheetRows,
  parseSheetSource,
  type MappingRecord,
  type SheetRecord,
} from './ingest/sheets/stages.js';
export type { ChatRecord, ChatSummaryRecord } from './ingest/chats/record.js';
export {
  confirmImport,
  previewImport,
  PREVIEW_REJECTS,
  PREVIEW_SAMPLE,
  type ImportChoice,
  type ImportPreviewRecord,
  type PreviewRowRecord,
} from './sheets.js';
