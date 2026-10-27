/**
 * The data-intermediary registry (GOV-07, GOV-11; FEAT-058 §5.1, D5): the sub-processors and
 * the cross-border transfers, from ADR-019 and ADR-006. It is the one source for the Privacy
 * and data page, the hosted notice and both PDFs, so they can't drift. It changes only by PR
 * (the ADR-007 / ADR-019 gate); FEAT-073 adds published versions and the 30-day notice.
 * English only, and kept to WinAnsi characters so the PDFs can use the standard fonts.
 */

/** The date of the current registry, YYYY-MM-DD. Change it with the lists. */
export const DOCUMENTS_UPDATED_ON = '2026-10-27';

export const SINGAPORE = 'Singapore (AWS ap-southeast-1)';

export interface SubProcessor {
  name: string;
  service: string;
  purpose: string;
  location: string;
  /** Whether tenant data is stored there. */
  dataAtRest: boolean;
}

export interface Transfer {
  data: string;
  from: string;
  to: string;
  purpose: string;
  safeguard: string;
  retention: string;
}

const AUSTRALIA = 'Sydney / Melbourne, Australia (Amazon Bedrock au. profile)';
const GOOGLE = 'Google (global)';

export const SUB_PROCESSORS: readonly SubProcessor[] = [
  {
    name: 'Amazon Web Services Singapore',
    service: 'Hosting, database, file storage, queues and logs',
    purpose: 'Runs KakiAgent and stores all tenant data',
    location: SINGAPORE,
    dataAtRest: true,
  },
  {
    name: 'Amazon Web Services (Amazon Bedrock, Anthropic Claude)',
    service: 'AI replies',
    purpose:
      "Writes the assistant's replies from your approved facts; the model provider has no access",
    location: AUSTRALIA,
    dataAtRest: false,
  },
  {
    name: 'Amazon Web Services (Amazon Bedrock, Cohere Embed)',
    service: 'Search index',
    purpose: 'Turns your knowledge base into a search index; Cohere has no access',
    location: SINGAPORE,
    dataAtRest: false,
  },
  {
    name: 'Amazon Simple Email Service',
    service: 'Email',
    purpose: 'Sends and receives email for your email channel and sign-in links',
    location: SINGAPORE,
    dataAtRest: false,
  },
  {
    name: 'Amazon GuardDuty Malware Protection',
    service: 'File scanning',
    purpose: 'Checks uploaded files for malware before they are read',
    location: SINGAPORE,
    dataAtRest: false,
  },
  {
    name: 'Google',
    service: 'Staff sign-in',
    purpose: 'Signs in your team with Google; no visitor data',
    location: GOOGLE,
    dataAtRest: false,
  },
];

export const TRANSFERS: readonly Transfer[] = [
  {
    data: 'Conversation text and the facts used to answer it',
    from: SINGAPORE,
    to: AUSTRALIA,
    purpose: "Writing the assistant's reply",
    safeguard:
      'AWS data processing terms; Bedrock invocation logging off, retention none; no model-provider access',
    retention: 'Not stored',
  },
  {
    data: 'Staff sign-in identity (name, email)',
    from: SINGAPORE,
    to: GOOGLE,
    purpose: 'Signing in your team',
    safeguard: 'Google OAuth terms',
    retention: "Google's account terms",
  },
];

export const NO_DATA_AT_REST_ABROAD = 'No tenant data is stored at rest outside Singapore.';
