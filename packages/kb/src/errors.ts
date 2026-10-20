export class FactNotFoundError extends Error {}
/** The fact changed since the client loaded it (optimistic concurrency). */
export class VersionConflictError extends Error {}
/** The fact's status doesn't allow this change here (ADR-010 state machine). */
export class InvalidStateError extends Error {}
/** The embedder failed; nothing was saved (FEAT-022 D4). */
export class EmbeddingUnavailableError extends Error {}
/** The fact breaks a cross-field rule of its type (FEAT-011 §3.2); nothing was saved. */
export class InvalidFactError extends Error {}
/** A list cursor that doesn't decode (FEAT-011 D5). */
export class InvalidCursorError extends Error {}
