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
/** No such source for this tenant (FEAT-012). */
export class SourceNotFoundError extends Error {}
/** A website source for this domain, or a source for this upload, already exists. */
export class SourceExistsError extends Error {
  constructor(readonly sourceId: string) {
    super('source exists');
  }
}
/** A price whose GST treatment is unknown can't be approved until the owner chooses (KB-15). */
export class GstRequiredError extends Error {}
/** A file failed for a reason only a new upload fixes (FEAT-015 D7). */
export class NotRetryableError extends Error {}
/** The tenant has as many file sources as its plan holds (D2; FEAT-015 §3.2). */
export class FileLimitError extends Error {}
