/**
 * Every tenant-scoped table and what a data-subject request does with it (GOV-05; FEAT-061
 * §5.2). `find+erase`: holds a person's data, found by `findSubject` and removed by
 * `dsr_erase()`; `erase`: removed with its parent but not listed on its own; `keep`: no personal
 * data (IDs, counts, configuration, staff accounts). A test fails when a table in
 * `TENANT_SCOPED_TABLES` is missing here, so a feature adding a table decides its handling.
 */
export type DsrAction = 'find+erase' | 'erase' | 'keep';

export interface DsrStoreEntry {
  action: DsrAction;
  why: string;
}

export const DSR_STORES: Record<string, DsrStoreEntry> = {
  contacts: { action: 'find+erase', why: 'the person, matched by exact identifier' },
  contact_identities: { action: 'find+erase', why: "the contact's identifiers" },
  contact_merges: { action: 'erase', why: 'merge history of the contact' },
  telegram_chats: { action: 'find+erase', why: "the contact's Telegram chat link" },
  handoff_links: { action: 'find+erase', why: 'channel handoff links of the contact' },
  consents: { action: 'find+erase', why: "the contact's consent records" },
  leads: { action: 'find+erase', why: "the contact's leads" },
  conversations: { action: 'find+erase', why: 'all conversations of the contact, whole (D2)' },
  messages: { action: 'find+erase', why: 'message text; mentions found by search' },
  conversation_owners: { action: 'erase', why: 'takeover row of a deleted conversation' },
  conversation_summaries: { action: 'find+erase', why: 'conversation memory (FEAT-026)' },
  escalations: { action: 'find+erase', why: 'escalations of the conversations' },
  approvals: { action: 'find+erase', why: 'drafts quoting the conversation' },
  used_link_nonces: { action: 'erase', why: 'nonces of deleted approvals' },
  suggestions: { action: 'find+erase', why: 'reply suggestions quoting the conversation' },
  email_messages: { action: 'erase', why: 'email headers of deleted messages' },
  email_threads: { action: 'erase', why: 'email thread subjects of deleted conversations' },
  message_deliveries: { action: 'erase', why: 'delivery rows of deleted messages' },
  email_attachments: { action: 'find+erase', why: 'email attachments; S3 files by outbox job' },
  corrections: { action: 'erase', why: 'corrections raised from deleted conversations (D16)' },
  coaching_sessions: { action: 'erase', why: 'replays of deleted corrections (D16)' },
  coaching_messages: { action: 'erase', why: 'messages of deleted coaching sessions' },
  visitor_events: { action: 'find+erase', why: "tracking rows of the conversations' visitor IDs" },
  visitor_tracking_choices: { action: 'find+erase', why: 'tracking choice of the visitor IDs' },
  audit_pii: { action: 'find+erase', why: 'audit personal data, erased so the chain verifies' },
  facts: { action: 'find+erase', why: 'KB facts whose text mentions the identifier (opt-in)' },
  fact_versions: { action: 'erase', why: 'versions of deleted facts' },
  kb_chunks: { action: 'erase', why: 'search chunks of deleted facts' },
  kb_staged_facts: { action: 'find+erase', why: 'staged facts mentioning the identifier (opt-in)' },
  dsr_requests: { action: 'keep', why: 'the request itself, requester masked after deletion (D3)' },
  tenants: { action: 'keep', why: 'business configuration' },
  outbox: { action: 'keep', why: 'IDs-only job rows, short-lived' },
  audit_entries: { action: 'keep', why: 'IDs-only hash chain (ADR-014)' },
  audit_heads: { action: 'keep', why: 'chain head' },
  business_profiles: { action: 'keep', why: 'business configuration' },
  holidays: { action: 'keep', why: 'business configuration' },
  assistant_settings: { action: 'keep', why: 'business configuration' },
  kb_sources: { action: 'keep', why: "the business's own sources" },
  kb_source_pages: { action: 'keep', why: "the business's own pages" },
  memberships: { action: 'keep', why: 'staff accounts, not data subjects of the business' },
  terms_acceptances: { action: 'keep', why: 'staff terms acceptance' },
  usage_events: { action: 'keep', why: 'IDs-only usage rows' },
  widget_settings: { action: 'keep', why: 'business configuration' },
  wording_versions: { action: 'keep', why: 'notice and purpose wordings' },
  privacy_settings: { action: 'keep', why: 'business configuration' },
  channel_connections: { action: 'keep', why: 'business configuration' },
  boundary_rules: { action: 'keep', why: 'business configuration' },
  onboarding_progress: { action: 'keep', why: 'business configuration' },
  invitations: { action: 'keep', why: 'staff invitations' },
  notification_prefs: { action: 'keep', why: 'staff preferences' },
  notifications: { action: 'keep', why: 'IDs-only alert rows for staff' },
  escalation_routing: { action: 'keep', why: 'business configuration' },
  lead_settings: { action: 'keep', why: 'business configuration' },
  email_settings: { action: 'keep', why: 'business configuration' },
  inbound_events: { action: 'keep', why: 'webhook dedupe IDs' },
  telegram_settings: { action: 'keep', why: 'business configuration' },
  telegram_alert_links: { action: 'keep', why: 'staff alert links' },
};

export const storesWith = (action: DsrAction) =>
  Object.entries(DSR_STORES)
    .filter(([, s]) => s.action === action)
    .map(([t]) => t);
