/**
 * Public interface of the `kb` module (architecture §5.2): facts, versions and chunks
 * (FEAT-022, FEAT-011). Other modules may import only this file (dependency-cruiser enforces it).
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
  visitorKb,
  type DashboardKbContext,
  type VisitorKbContext,
} from './context.js';
export {
  EmbeddingUnavailableError,
  FactNotFoundError,
  InvalidCursorError,
  InvalidFactError,
  InvalidStateError,
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
} from './facts.js';
export { DEFAULT_SEARCH, searchVisitorFacts, type SearchOptions } from './visitor.js';
