/**
 * Audit log event groups without Zod (FEAT-060 §3, D6): the API filters by them and the
 * dashboard labels entries with them, so both map an event code the same way.
 * `@kaki/contracts/audit`.
 */

export const AUDIT_EVENT_GROUPS = [
  { key: 'conversations', prefixes: ['conversation.', 'message.', 'handoff.', 'inbox.'] },
  { key: 'assistant', prefixes: ['agent.', 'tool.', 'coach.', 'ai.'] },
  { key: 'knowledge', prefixes: ['fact.', 'kb.', 'kb_source.', 'correction.'] },
  { key: 'approvals', prefixes: ['approval.', 'rules.'] },
  { key: 'contacts', prefixes: ['contact.', 'consent.', 'lead.', 'tracking.'] },
  { key: 'team', prefixes: ['member.', 'tenant.', 'terms.'] },
  { key: 'settings', prefixes: ['settings.', 'widget.', 'channel.', 'onboarding.', 'escalation.'] },
  { key: 'audit', prefixes: ['audit.'] },
] as const;

export type AuditGroupKey = (typeof AUDIT_EVENT_GROUPS)[number]['key'] | 'other';

export const AUDIT_GROUP_KEYS: readonly AuditGroupKey[] = [
  ...AUDIT_EVENT_GROUPS.map((g) => g.key),
  'other',
];

/** Every prefix of every named group; `other` is an event matching none of them. */
export const AUDIT_ALL_PREFIXES: readonly string[] = AUDIT_EVENT_GROUPS.flatMap((g) => g.prefixes);

/** The prefixes of one group; `other` has none (it is the complement of all of them). */
export function auditGroupPrefixes(group: AuditGroupKey): readonly string[] {
  return AUDIT_EVENT_GROUPS.find((g) => g.key === group)?.prefixes ?? [];
}

export function auditGroupOf(eventType: string): AuditGroupKey {
  for (const g of AUDIT_EVENT_GROUPS)
    if (g.prefixes.some((p) => eventType.startsWith(p))) return g.key;
  return 'other';
}

/** `audit_entries.actor_type` (governance `ActorType`). */
export const AUDIT_ACTOR_TYPES = ['agent', 'user', 'operator', 'system', 'visitor'] as const;

/** Governance `BreakReason`; the api's mapping keeps the two equal at compile time. */
export const AUDIT_BREAK_REASONS = [
  'hash_mismatch',
  'link_mismatch',
  'seq_gap',
  'anchor_mismatch',
  'truncated',
  'pii_commitment_mismatch',
] as const;

export const AUDIT_PAGE_MAX = 100;
export const AUDIT_EXPORT_MAX = 100_000;
