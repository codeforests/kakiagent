/**
 * The visitor's answer to the consent-mode tracking prompt (CHN-03, UC-20 1a; FEAT-029 §5.4).
 * Visitor zone. A decline (the menu's "Stop sharing pages") also deletes the visitor's events.
 */
import { TRACKING_PROMPT_VERSION } from '@kaki/contracts';
import { and, eq, schema, type Tx } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';
import { visitorTrackingMode } from './settings.js';

const choices = schema.visitorTrackingChoices;
const ev = schema.visitorEvents;

export class NotConsentModeError extends Error {
  constructor() {
    super('not_consent_mode');
  }
}

export type TrackingChoice = 'accepted' | 'declined';

export async function visitorChoice(
  tx: Tx,
  tenantId: string,
  visitorId: string,
): Promise<TrackingChoice | null> {
  const [row] = await tx
    .select({ choice: choices.choice })
    .from(choices)
    .where(and(eq(choices.tenantId, tenantId), eq(choices.visitorId, visitorId)));
  return row?.choice ?? null;
}

export async function recordChoice(
  tx: Tx,
  input: { tenantId: string; visitorId: string; choice: TrackingChoice; now?: Date },
): Promise<{ deleted: number }> {
  if ((await visitorTrackingMode(tx, input.tenantId)) !== 'consent')
    throw new NotConsentModeError();
  const decidedAt = input.now ?? new Date();
  await tx
    .insert(choices)
    .values({
      tenantId: input.tenantId,
      visitorId: input.visitorId,
      choice: input.choice,
      wording: TRACKING_PROMPT_VERSION,
      decidedAt,
    })
    .onConflictDoUpdate({
      target: [choices.tenantId, choices.visitorId],
      set: { choice: input.choice, wording: TRACKING_PROMPT_VERSION, decidedAt },
    });
  let deleted = 0;
  if (input.choice === 'declined')
    deleted = (
      await tx
        .delete(ev)
        .where(and(eq(ev.tenantId, input.tenantId), eq(ev.visitorId, input.visitorId)))
        .returning({ id: ev.id })
    ).length;
  await audit.append(tx, input.tenantId, {
    action: 'tracking.choice',
    actorType: 'visitor',
    subjectType: 'visitor',
    subjectId: input.visitorId,
    payload: { choice: auditCode(input.choice), wording: auditCode(TRACKING_PROMPT_VERSION) },
  });
  return { deleted };
}
