/**
 * Public interface of the `kb` module (architecture §5.2): facts, versions and chunks
 * (FEAT-022, FEAT-011), sources and the ingest pipeline (FEAT-012). Other modules may import only this file (dependency-cruiser enforces it).
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
  type Provenance,
} from './facts.js';
export {
  createWebsiteSource,
  deleteSource,
  getSource,
  listSources,
  retrySource,
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
