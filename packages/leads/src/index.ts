/**
 * Public interface of the `leads` module (architecture §5.2; FEAT-049): lead settings, consent
 * records, contacts and lead capture. Other modules may import only this file
 * (dependency-cruiser enforces it); the inbox gets contacts and leads through an api-filled port.
 */
export * from './errors.js';
export {
  DEFAULT_FIELDS,
  getLeadSettings,
  leadCaptureConfig,
  saveLeadSettings,
  type FieldSetting,
} from './settings.js';
export {
  consentState,
  recordConsent,
  type ConsentInput,
  type ConsentState,
  type RecordedConsent,
} from './consent.js';
export {
  captureLead,
  leadCapturedNotice,
  submitContactForm,
  type CaptureInput,
  type Captured,
} from './capture.js';
export { contactOf, leadSummaryOf, type ContactView } from './views.js';
export {
  bandOf,
  foldKeyword,
  matchKeyword,
  parseBudget,
  scoreLead,
  type ScoreInput,
  type Scored,
} from './score.js';
export {
  defaultQualification,
  normaliseQualification,
  qualificationInForce,
  rescoreOnCapture,
  rescoreOpenLeads,
  RESCORE_CAP,
  type Rescored,
} from './rescore.js';
export { leadDetail, leadRowOf, listLeads, type LeadDbRow } from './list.js';
export { setLeadStatus } from './status.js';
export {
  CSV_HEADER,
  CSV_REMINDER,
  auditExport,
  exportable,
  exportFileName,
  exportLeads,
  leadsCsv,
  reasonText,
} from './export.js';
