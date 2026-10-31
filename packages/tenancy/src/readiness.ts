import { rulesSaved } from '@kaki/approvals';
import { setChannelState } from '@kaki/channels';
import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { audit, auditId, privacyReadiness } from '@kaki/governance';
import { termsAccepted } from '@kaki/identity';
import { dashboardKb, reviewSummary } from '@kaki/kb';
import { getAssistantSettings } from './assistant.js';
import { getBusinessProfile, type BusinessProfile } from './profile.js';

const { onboardingProgress: op, tenants } = schema;

/** The required items of the go-live check, in the order shown (ONB-09; FEAT-035 §3). */
export const READINESS_KEYS = [
  'profile',
  'approved_fact',
  'disclosure',
  'purpose',
  'notice',
  'terms',
  'rules',
] as const;
export type ReadinessKey = (typeof READINESS_KEYS)[number];

export interface Readiness {
  items: { key: ReadinessKey; ok: boolean }[];
  warnings: { conflicts: number; needsReview: number };
  ready: boolean;
  /** Purpose statement and notice in place, so a pre-live contact form is allowed (UX-R4). */
  preLiveForm: boolean;
  firstLiveAt: Date | null;
}

/** A required item fails before the first go-live (→ 409 `not_ready`); nothing changed. */
export class NotReadyError extends Error {
  constructor(readonly missing: ReadinessKey[]) {
    super(`not ready: ${missing.join(', ')}`);
  }
}

/** Warnings exist and the go-live check's acknowledgement wasn't given (D5). */
export class WarningsUnacknowledgedError extends Error {}

/** Name, industry, weekly hours, an email or phone, a language; UEN optional (D2). */
export function profileComplete(p: BusinessProfile): boolean {
  return (
    p.name.trim() !== '' &&
    p.industry !== null &&
    p.hours !== null &&
    Boolean(p.contactEmail || p.contactPhone) &&
    p.languages.length > 0
  );
}

/** Each item from its own source (AC-3). Dashboard zone. */
export async function goLiveReadiness(
  tx: Tx,
  tenantId: string,
  userId: string,
  today: string,
): Promise<Readiness> {
  const profile = await getBusinessProfile(tx, tenantId, today);
  const kb = await reviewSummary(dashboardKb(tx, tenantId, userId));
  const assistant = await getAssistantSettings(tx, tenantId);
  const privacy = await privacyReadiness(tx, tenantId);
  const ok: Record<ReadinessKey, boolean> = {
    profile: profileComplete(profile),
    approved_fact: kb.approvedInUse >= 1,
    disclosure: assistant.version > 0,
    purpose: privacy.purposeStatement,
    notice: privacy.privacyNotice,
    terms: await termsAccepted(tx, tenantId),
    rules: await rulesSaved(tx, tenantId),
  };
  const [row] = await tx
    .select({ firstLiveAt: op.firstLiveAt })
    .from(op)
    .where(eq(op.tenantId, tenantId));
  return {
    items: READINESS_KEYS.map((key) => ({ key, ok: ok[key] })),
    warnings: { conflicts: kb.conflicts, needsReview: kb.needsReview },
    ready: READINESS_KEYS.every((k) => ok[k]),
    preLiveForm: ok.purpose && ok.notice,
    firstLiveAt: row?.firstLiveAt ?? null,
  };
}

interface GoLiveInput {
  tenantId: string;
  userId: string;
  channels: { id: string; version: number }[];
  acknowledgeWarnings: boolean;
  today: string;
}

/**
 * The go-live check's Go live (ONB-09, UC-03 10–11; FEAT-035 §5.2). Until the first go-live
 * every required item must pass and warnings need the acknowledgement; then each channel goes
 * live through channels' `setChannelState` (its errors pass through, and the caller's
 * transaction rolls back every channel). The first go-live is timestamped and audited once.
 */
export async function goLive(tx: Tx, input: GoLiveInput) {
  const { tenantId, userId } = input;
  await tx.insert(op).values({ tenantId }).onConflictDoNothing();
  const [row] = await tx
    .select({ firstLiveAt: op.firstLiveAt })
    .from(op)
    .where(eq(op.tenantId, tenantId))
    .for('update');
  const firstTime = !row?.firstLiveAt;
  if (firstTime) {
    const r = await goLiveReadiness(tx, tenantId, userId, input.today);
    const missing = r.items.filter((i) => !i.ok).map((i) => i.key);
    if (missing.length > 0) throw new NotReadyError(missing);
    const warned = r.warnings.conflicts + r.warnings.needsReview > 0;
    if (warned && !input.acknowledgeWarnings) throw new WarningsUnacknowledgedError();
  }
  const items = [];
  for (const c of input.channels)
    items.push(await setChannelState(tx, { tenantId, userId, ...c, state: 'live' }));
  if (firstTime) await recordFirstLive(tx, tenantId, userId, input.channels);
  return items;
}

/**
 * The Channels page's Go live for one channel: the same gate, but warnings never block there
 * (D5), and the same first-live bookkeeping.
 */
export async function goLiveOne(
  tx: Tx,
  input: { tenantId: string; userId: string; id: string; version: number; today: string },
) {
  const { id, version, ...rest } = input;
  const [item] = await goLive(tx, {
    ...rest,
    channels: [{ id, version }],
    acknowledgeWarnings: true,
  });
  return item!;
}

async function recordFirstLive(
  tx: Tx,
  tenantId: string,
  userId: string,
  channels: { id: string }[],
) {
  const [t] = await tx
    .update(op)
    .set({
      firstLiveAt: sql`now()`,
      firstLiveBy: userId,
      currentStep: 'go_live',
      updatedAt: sql`now()`,
    })
    .from(tenants)
    .where(and(eq(op.tenantId, tenantId), eq(tenants.id, op.tenantId)))
    .returning({
      minutes: sql<number>`floor(extract(epoch from now() - ${tenants.createdAt}) / 60)::int`,
    });
  await audit.append(tx, tenantId, {
    action: 'onboarding.first_live',
    actorType: 'user',
    actorId: userId,
    subjectType: 'tenant',
    subjectId: tenantId,
    payload: {
      minutesToLive: Math.max(0, Number(t?.minutes ?? 0)),
      channels: channels.map((c) => auditId(c.id)),
    },
  });
}
