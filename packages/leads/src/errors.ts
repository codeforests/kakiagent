import type { LeadCaptureConfig, LeadFieldErrors } from '@kaki/contracts';

/** 409 `wording_changed`: a posted wording ID is no longer current; carries the current config. */
export class WordingChanged extends Error {
  constructor(readonly config: LeadCaptureConfig | null) {
    super('wording changed');
  }
}
/** 409 `consent_required`: no granted enquiry consent of this conversation (AC-1). */
export class ConsentRequired extends Error {}
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
