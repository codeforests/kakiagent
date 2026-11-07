import type { LeadCaptureConfig, LeadFieldErrors } from '@kaki/contracts';

/** 409 `wording_changed`: a posted wording ID is no longer current; carries the current config. */
export class WordingChanged extends Error {
  constructor(readonly config: LeadCaptureConfig | null) {
    super('wording changed');
  }
}
/** 409 `consent_required`: no granted enquiry consent of this conversation (AC-1). */
export class ConsentRequired extends Error {}
/**
 * 409 `consent_required` too (FEAT-051 §5.1; AC-8): the consent is older than the contact's
 * latest withdrawal, so the visitor must consent again.
 */
export class ConsentWithdrawn extends ConsentRequired {}
/** 409 `not_capturing`: the tenant has no saved purpose statement (LED-02, fail closed). */
export class NotCapturing extends Error {}
/** 422 with per-field codes (AC-5). */
export class LeadFieldsInvalid extends Error {
  constructor(readonly body: LeadFieldErrors) {
    super('invalid lead fields');
  }
}
/** 409 `stale`: lead settings changed since they were read. */
export class LeadSettingsStale extends Error {}
/** 400: the settings can't be saved as sent (`marketing_text`). */
export class LeadSettingsInvalid extends Error {
  constructor(readonly code: 'marketing_text') {
    super(code);
  }
}
/** 409 `stale` on a status change: the lead moved since it was read; carries the current row. */
export class LeadStale extends Error {
  constructor(readonly lead: import('@kaki/contracts').LeadRow) {
    super('lead changed');
  }
}
/** 409 `open_lead_exists`: reopening a won/lost lead while the contact has another open one. */
export class OpenLeadExists extends Error {}
/** 404: no such lead in this tenant. */
export class LeadNotFound extends Error {}
/** 400 `invalid_cursor`: the list cursor isn't one this API issued. */
export class InvalidLeadCursor extends Error {}
/** 413 `too_many`: the export would exceed `LEAD_EXPORT_MAX` rows (D1). */
export class TooManyLeads extends Error {
  constructor(readonly count: number) {
    super('too many leads');
  }
}
/** 422 `scope_not_offered`: "just stop offers" when the contact never agreed to offers (FEAT-051 D1). */
export class ScopeNotOffered extends Error {}
