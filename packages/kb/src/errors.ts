export class FactNotFoundError extends Error {}
/** The fact changed since the client loaded it (optimistic concurrency). */
export class VersionConflictError extends Error {}
/** The fact's status doesn't allow this change here (ADR-010 state machine). */
export class InvalidStateError extends Error {}
/** The embedder failed; nothing was saved (FEAT-022 D4). */
export class EmbeddingUnavailableError extends Error {}
