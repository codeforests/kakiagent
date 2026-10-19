/**
 * Public interface of the `kb` module (architecture §5.2): facts, versions and chunks
 * (FEAT-022). Other modules may import only this file (dependency-cruiser enforces it).
 */
export type { FaqValue, GstTreatment, ProductValue, VisitorFact } from './types.js';
export {
  dashboardKb,
  visitorKb,
  type DashboardKbContext,
  type VisitorKbContext,
} from './context.js';
export {
  EmbeddingUnavailableError,
  FactNotFoundError,
  InvalidStateError,
  VersionConflictError,
} from './errors.js';
export { chunkContent, prepareChunk, type PreparedChunk } from './chunk.js';
export {
  contentChanged,
  createFact,
  getFact,
  listFacts,
  mergePatch,
  updateFact,
  type FactInput,
  type FactPatch,
  type FactRecord,
  type FactStatus,
} from './facts.js';
export { DEFAULT_SEARCH, searchVisitorFacts, type SearchOptions } from './visitor.js';
