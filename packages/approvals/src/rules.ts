import { desc, eq, schema, type Tx } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';

const { boundaryRules } = schema;

/**
 * Boundary rules (APR-01, UC-29; FEAT-054 §5.1). Each save is an immutable version (D1);
 * the newest is in force and a tenant that never saved runs on `SAFE_DEFAULTS`. Works on
 * the dashboard zone (settings, coaching) and the visitor zone (the turn reads only).
 */
export const COMMITMENT_KEYS = [
  'delivery_guarantee',
  'refund',
  'legal_advice',
  'medical_advice',
] as const;
export type CommitmentKey = (typeof COMMITMENT_KEYS)[number];
/** Always forbidden: AGT-13 declines advice in code, so these can't be switched off (D6). */
export const LOCKED_COMMITMENTS = ['legal_advice', 'medical_advice'] as const;

/** The contract's `BoundaryRules` has the same keys; a contracts unit test checks they match. */
export interface BoundaryRules {
  allowedTopics: string[];
  blockedTopics: string[];
  maxDiscountPct: number;
  quotesNeedApproval: boolean;
  forbiddenCommitments: CommitmentKey[];
  customCommitments: string[];
}

export const SAFE_DEFAULTS: Readonly<BoundaryRules> = Object.freeze({
  allowedTopics: [],
  blockedTopics: [],
  maxDiscountPct: 0,
  quotesNeedApproval: true,
  forbiddenCommitments: [...COMMITMENT_KEYS],
  customCommitments: [],
});

export interface SavedRules {
  rules: BoundaryRules;
  version: number;
  savedAt: Date;
}

/** The version the form was loaded from is no longer current (a concurrent save won). */
export class RulesStale extends Error {
  override name = 'RulesStale';
}

type Row = typeof boundaryRules.$inferSelect;
const toRules = (r: Row): BoundaryRules => ({
  allowedTopics: r.allowedTopics,
  blockedTopics: r.blockedTopics,
  maxDiscountPct: r.maxDiscountPct,
  quotesNeedApproval: r.quotesNeedApproval,
  forbiddenCommitments: r.forbiddenCommitments as CommitmentKey[],
  customCommitments: r.customCommitments,
});

/** The newest saved version, or null when the tenant never saved rules. */
export async function currentRules(tx: Tx, tenantId: string): Promise<SavedRules | null> {
  const [row] = await tx
    .select()
    .from(boundaryRules)
    .where(eq(boundaryRules.tenantId, tenantId))
    .orderBy(desc(boundaryRules.version))
    .limit(1);
  return row ? { rules: toRules(row), version: row.version, savedAt: row.createdAt } : null;
}

/** What the agent applies: the saved rules, or the safe defaults with `version: null`. */
export async function rulesInForce(
  tx: Tx,
  tenantId: string,
): Promise<{ rules: BoundaryRules; version: number | null }> {
  const saved = await currentRules(tx, tenantId);
  return saved
    ? { rules: saved.rules, version: saved.version }
    : { rules: structuredClone(SAFE_DEFAULTS) as BoundaryRules, version: null };
}

/** ONB-09's "saved boundary rules" readiness item (FEAT-035 reads it). */
export async function rulesSaved(tx: Tx, tenantId: string): Promise<boolean> {
  return (await currentRules(tx, tenantId)) !== null;
}

/** Trim, collapse inner spaces, and drop case-insensitive duplicates keeping the first spelling. */
export function normaliseList(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim().replace(/\s+/g, ' ');
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function normaliseRules(rules: BoundaryRules): BoundaryRules {
  const forbidden = new Set<CommitmentKey>([...rules.forbiddenCommitments, ...LOCKED_COMMITMENTS]);
  return {
    allowedTopics: normaliseList(rules.allowedTopics),
    blockedTopics: normaliseList(rules.blockedTopics),
    maxDiscountPct: rules.maxDiscountPct,
    quotesNeedApproval: rules.quotesNeedApproval,
    forbiddenCommitments: COMMITMENT_KEYS.filter((k) => forbidden.has(k)),
    customCommitments: normaliseList(rules.customCommitments),
  };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** The audit's field codes that differ between two versions (codes only, never topic text). */
export function changedFields(before: BoundaryRules, after: BoundaryRules): string[] {
  const out: string[] = [];
  if (!sameList(before.allowedTopics, after.allowedTopics)) out.push('allowed_topics');
  if (!sameList(before.blockedTopics, after.blockedTopics)) out.push('blocked_topics');
  if (before.maxDiscountPct !== after.maxDiscountPct) out.push('max_discount');
  if (before.quotesNeedApproval !== after.quotesNeedApproval) out.push('quotes_need_approval');
  if (!sameList(before.forbiddenCommitments, after.forbiddenCommitments))
    out.push('forbidden_commitments');
  if (!sameList(before.customCommitments, after.customCommitments)) out.push('custom_commitments');
  return out;
}

/**
 * Saves a new version from `expectedVersion` (null when never saved). A stale version, or
 * losing a race for the same next version (the primary key), throws `RulesStale`. Appends
 * one `rules.updated` entry in the same transaction. Saving identical rules still writes a
 * version: the owner confirmed them (§3).
 */
export async function saveRules(
  tx: Tx,
  tenantId: string,
  input: { expectedVersion: number | null; rules: BoundaryRules; userId: string },
): Promise<SavedRules> {
  const current = await currentRules(tx, tenantId);
  if ((current?.version ?? null) !== input.expectedVersion) throw new RulesStale('rules changed');
  const rules = normaliseRules(input.rules);
  const version = (input.expectedVersion ?? 0) + 1;
  const [row] = await tx
    .insert(boundaryRules)
    .values({ tenantId, version, ...rules, createdBy: input.userId })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new RulesStale('rules changed');
  const changed = changedFields(current?.rules ?? SAFE_DEFAULTS, rules);
  await audit.append(tx, tenantId, {
    action: 'rules.updated',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'tenant',
    subjectId: tenantId,
    payload: { version, changed: changed.map(auditCode) },
  });
  return { rules: toRules(row), version: row.version, savedAt: row.createdAt };
}

export type CommitmentDecision = 'refuse' | 'needs_approval' | 'allowed';

/**
 * FEAT-055's `request_commitment` boundary check (ADR-025 decision 2), built and tested
 * here: a discount above the maximum is refused; otherwise it needs approval when quotes
 * do, else it's allowed.
 */
export function commitmentDecision(
  rules: Pick<BoundaryRules, 'maxDiscountPct' | 'quotesNeedApproval'>,
  input: { discountPct?: number },
): CommitmentDecision {
  if (input.discountPct !== undefined && input.discountPct > rules.maxDiscountPct) return 'refuse';
  return rules.quotesNeedApproval ? 'needs_approval' : 'allowed';
}
