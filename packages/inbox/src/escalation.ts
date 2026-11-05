import type { OpenEscalation } from '@kaki/contracts';
import { and, eq, inArray, schema, sql, type Tx, type ZoneDb } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import { notify } from '@kaki/platform/notifications';
import {
  addBusinessMinutes,
  openStatus,
  type HolidayExceptions,
  type WeeklyHours,
} from '@kaki/tenancy';
import {
  ConversationClosedError,
  ConversationNotFoundError,
  resolveEscalation,
  transition,
  type LifecycleActor,
} from './lifecycle.js';
import type { ConversationRow, MessageRow } from './mappers.js';
import { conversationLanguage } from './ownership.js';

/**
 * Escalation to a person (INB-05, UC-23 1–2; FEAT-044 §5.1, §5.2). One open escalation per
 * conversation (the partial unique index); routing picks the assignee from the tenant's active
 * members through `escalation_candidates()` (D3); alerts go through `notify` in the same
 * transaction. Every move out of `escalated` resolves it inside `transition`.
 */

export type EscalationSource = (typeof schema.ESCALATION_SOURCES)[number];
export type EscalationRow = typeof schema.escalations.$inferSelect;
export type RoutingRow = typeof schema.escalationRouting.$inferSelect;

/** The tenant's opening hours, from `visitorTenantState` (null: always open). */
export interface TenantHours {
  hours: WeeklyHours | null;
  openOnPublicHolidays: boolean;
  holidays: HolidayExceptions;
}

/** The visitor's notice text; `@kaki/agent` `escalationNotice` (inbox can't import agent). */
export type EscalationNoticeText = (n: {
  language: 'en' | 'zh';
  afterHours: boolean;
  nextOpen: Date | null;
  now: Date;
}) => string;

interface Log {
  warn(obj: object, msg: string): void;
}

export const DEFAULT_REMINDER_MINUTES = 10;
/** From this reminder on, owners and admins are reminded too (D7). */
export const WIDEN_AT_REMINDER = 3;

const e = schema.escalations;
const r = schema.escalationRouting;
const c = schema.conversations;
const o = schema.conversationOwners;
const m = schema.messages;

export interface Candidate {
  userId: string;
  role: string;
}

/** The current tenant's active members, ordered by user ID (D3): IDs and roles only. */
export async function escalationCandidates(tx: Tx): Promise<Candidate[]> {
  const res = await tx.execute<{ user_id: string; role: string }>(
    sql`select user_id, role from escalation_candidates()`,
  );
  return res.rows.map((x) => ({ userId: x.user_id, role: x.role }));
}

/** The tenant's routing, or the defaults (round-robin, 10 minutes) without a row. */
export async function routingOf(tx: Tx, tenantId: string): Promise<RoutingRow | null> {
  const [row] = await tx.select().from(r).where(eq(r.tenantId, tenantId));
  return row ?? null;
}

const minutesOf = (row: RoutingRow | null) => row?.reminderMinutes ?? DEFAULT_REMINDER_MINUTES;

/**
 * Picks the assignee (§5.2, D4). The routing row is locked, so concurrent escalations
 * serialise and round-robin hands each the next member. A named person who is no longer an
 * active member falls back to round-robin.
 */
export async function route(
  tx: Tx,
  tenantId: string,
  log?: Log,
): Promise<{ userId: string | null; reminderMinutes: number }> {
  await tx.insert(r).values({ tenantId }).onConflictDoNothing();
  const [routing] = await tx.select().from(r).where(eq(r.tenantId, tenantId)).for('update');
  const candidates = await escalationCandidates(tx);
  const reminderMinutes = minutesOf(routing ?? null);
  if (routing?.mode === 'person') {
    if (candidates.some((x) => x.userId === routing.personUserId))
      return { userId: routing.personUserId, reminderMinutes };
    log?.warn({ tenantId }, 'escalation person is no longer a member; round-robin');
  }
  if (candidates.length === 0) return { userId: null, reminderMinutes };
  const last = routing?.lastAssignedUserId ?? null;
  const next = (last && candidates.find((x) => x.userId > last)) || candidates[0]!;
  await tx.update(r).set({ lastAssignedUserId: next.userId }).where(eq(r.tenantId, tenantId));
  return { userId: next.userId, reminderMinutes };
}

function hoursAt(hours: TenantHours | null, now: Date) {
  if (!hours?.hours) return { open: true, nextOpen: null };
  const s = openStatus(hours.hours, hours.openOnPublicHolidays, now, hours.holidays);
  return { open: s.open, nextOpen: s.nextOpen };
}

const nextReminder = (hours: TenantHours | null, now: Date, minutes: number) =>
  addBusinessMinutes(
    hours?.hours ?? null,
    hours?.openOnPublicHolidays ?? false,
    now,
    minutes,
    hours?.holidays,
  );

export interface RequestEscalationInput {
  tenantId: string;
  conversationId: string;
  source: EscalationSource;
  now?: Date;
  hours: TenantHours | null;
  /**
   * The visitor's notice; omitted for `unverified`, whose reply already says so, and when the
   * agent's turn stores the notice as its reply (an escalate-only turn).
   */
  noticeText?: EscalationNoticeText;
  /** The notice's language; by default the conversation's (that of its latest reply). */
  language?: 'en' | 'zh';
  log?: Log;
}

export interface RequestEscalationResult {
  status: 'escalated' | 'already_escalated' | 'with_person';
  escalation: EscalationRow | null;
  notice: MessageRow | null;
  conversation: ConversationRow;
}

/**
 * Opens an escalation (UC-23 1, §5.1): routes it, moves the conversation to `escalated`,
 * audits and alerts the assignee, and stores the visitor's notice. A repeat changes nothing
 * but may make a non-urgent escalation urgent once; a conversation a person owns is left alone.
 */
export async function requestEscalation(
  tx: Tx,
  input: RequestEscalationInput,
): Promise<RequestEscalationResult> {
  const { tenantId, conversationId, source } = input;
  const now = input.now ?? new Date();
  const [conv] = await tx
    .select()
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.id, conversationId)))
    .for('update');
  if (!conv) throw new ConversationNotFoundError('conversation not found');
  if (conv.status === 'closed') throw new ConversationClosedError('conversation closed');
  const [owned] = await tx
    .select({ userId: o.userId })
    .from(o)
    .where(and(eq(o.tenantId, tenantId), eq(o.conversationId, conversationId)));
  if (owned || conv.status === 'human')
    return { status: 'with_person', escalation: null, notice: null, conversation: conv };

  const { open, nextOpen } = hoursAt(input.hours, now);
  const visitorAsked = source === 'visitor_button' || source === 'visitor_asked';
  const [current] = await tx
    .select()
    .from(e)
    .where(
      and(
        eq(e.tenantId, tenantId),
        eq(e.conversationId, conversationId),
        sql`${e.resolvedAt} is null`,
      ),
    )
    .for('update');
  if (current) {
    let escalation = current;
    // A visitor asking in business hours makes a quiet escalation urgent, once (AC-4).
    if (!current.urgent && visitorAsked && open) {
      escalation = { ...current, urgent: true };
      await tx.update(e).set({ urgent: true }).where(eq(e.id, current.id));
      if (current.assigneeUserId)
        await notify(tx, {
          tenantId,
          kind: 'escalation',
          recipients: [current.assigneeUserId],
          urgent: true,
          subject: { type: 'conversation', id: conversationId },
          dedupeKey: `escalation:${current.id}:urgent`,
        });
    }
    return {
      status: 'already_escalated',
      escalation: escalation!,
      notice: null,
      conversation: conv,
    };
  }

  const afterHours = !open;
  // An approval past its SLA (FEAT-055 §5.1) is as urgent as a visitor asking.
  const urgent = (visitorAsked || source === 'approval_sla') && !afterHours;
  const assignee = await route(tx, tenantId, input.log);
  const [escalation] = await tx
    .insert(e)
    .values({
      tenantId,
      conversationId,
      source,
      urgent,
      afterHours,
      assigneeUserId: assignee.userId,
      nextReminderAt: nextReminder(input.hours, now, assignee.reminderMinutes),
    })
    .returning();
  const actor: LifecycleActor = visitorAsked
    ? { type: 'visitor', id: conv.visitorId }
    : source === 'approval_sla'
      ? { type: 'system' }
      : { type: 'agent' };
  const conversation = await transition(tx, { tenantId, conversationId, to: 'escalated', actor });
  await audit.append(tx, tenantId, {
    action: 'escalation.assigned',
    actorType: actor.type,
    ...('id' in actor ? { actorId: actor.id } : {}),
    subjectType: 'conversation',
    subjectId: conversationId,
    related: assignee.userId ? [{ type: 'user', id: assignee.userId }] : [],
    payload: {
      escalationId: auditId(escalation!.id),
      source: auditCode(source),
      urgent,
      afterHours,
    },
  });
  if (assignee.userId)
    await notify(tx, {
      tenantId,
      kind: 'escalation',
      recipients: [assignee.userId],
      urgent,
      subject: { type: 'conversation', id: conversationId },
      dedupeKey: `escalation:${escalation!.id}`,
    });

  let notice: MessageRow | null = null;
  if (input.noticeText) {
    const language = input.language ?? (await conversationLanguage(tx, tenantId, conversationId));
    const text = input.noticeText({ language, afterHours, nextOpen, now });
    const [stored] = await tx
      .insert(m)
      .values({
        tenantId,
        conversationId,
        author: 'system',
        body: '',
        notice: text,
        noticeKind: 'escalated',
        language,
      })
      .returning();
    notice = stored!;
    await tx
      .update(c)
      .set({ lastMessageAt: sql`now()` })
      .where(and(eq(c.tenantId, tenantId), eq(c.id, conversationId)));
  }
  return { status: 'escalated', escalation: escalation!, notice: notice ?? null, conversation };
}

export type RemindOutcome = 'reminded' | 'resolved' | 'skipped';

/**
 * One reminder (§5.1; AC-5), run by the agent-worker when the timer fires. A resolved
 * escalation is skipped; one whose conversation was claimed or left `escalated` by a path that
 * missed it is resolved here. Otherwise a deactivated assignee is re-routed, the assignee (and
 * from the third reminder owners and admins, D7) is reminded, and the next time is set.
 * Nothing is posted to the visitor.
 */
export async function remindEscalation(
  tx: Tx,
  input: {
    tenantId: string;
    escalationId: string;
    now?: Date;
    hours: TenantHours | null;
    log?: Log;
  },
): Promise<RemindOutcome> {
  const { tenantId, escalationId } = input;
  const now = input.now ?? new Date();
  const [esc] = await tx
    .select()
    .from(e)
    .where(and(eq(e.tenantId, tenantId), eq(e.id, escalationId)))
    .for('update');
  if (!esc || esc.resolvedAt) return 'skipped';
  const [conv] = await tx
    .select({ status: c.status })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.id, esc.conversationId)));
  const [owned] = await tx
    .select({ userId: o.userId })
    .from(o)
    .where(and(eq(o.tenantId, tenantId), eq(o.conversationId, esc.conversationId)));
  if (owned || conv?.status !== 'escalated') {
    await resolveEscalation(tx, {
      tenantId,
      conversationId: esc.conversationId,
      resolution: owned || conv?.status === 'human' ? 'claimed' : 'closed',
      by: owned?.userId ?? null,
    });
    return 'resolved';
  }
  const candidates = await escalationCandidates(tx);
  let assignee = esc.assigneeUserId;
  let reminderMinutes = minutesOf(await routingOf(tx, tenantId));
  if (!assignee || !candidates.some((x) => x.userId === assignee)) {
    const routed = await route(tx, tenantId, input.log);
    assignee = routed.userId;
    reminderMinutes = routed.reminderMinutes;
  }
  const n = esc.reminders + 1;
  const recipients = [
    ...(assignee ? [assignee] : []),
    ...(n >= WIDEN_AT_REMINDER
      ? candidates.filter((x) => x.role === 'owner' || x.role === 'admin').map((x) => x.userId)
      : []),
  ];
  const unique = [...new Set(recipients)];
  await notify(tx, {
    tenantId,
    kind: 'escalation_reminder',
    recipients: unique,
    urgent: esc.urgent,
    subject: { type: 'conversation', id: esc.conversationId },
    dedupeKey: `escalation:${esc.id}:r${n}`,
  });
  await tx
    .update(e)
    .set({
      assigneeUserId: assignee,
      reminders: n,
      nextReminderAt: nextReminder(input.hours, now, reminderMinutes),
    })
    .where(eq(e.id, esc.id));
  await audit.append(tx, tenantId, {
    action: 'escalation.reminded',
    actorType: 'system',
    subjectType: 'conversation',
    subjectId: esc.conversationId,
    related: unique.map((id) => ({ type: 'user', id })),
    payload: { escalationId: auditId(esc.id), n },
  });
  return 'reminded';
}

/** The open escalation of each conversation on a page, by conversation ID. */
export async function escalationsOf(
  tx: Tx,
  tenantId: string,
  conversationIds: readonly string[],
): Promise<Map<string, EscalationRow>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(e)
    .where(
      and(
        eq(e.tenantId, tenantId),
        inArray(e.conversationId, [...conversationIds]),
        sql`${e.resolvedAt} is null`,
      ),
    );
  return new Map(rows.map((x) => [x.conversationId, x]));
}

/** The contract shape of an open escalation, with the assignee's staff-facing name. */
export function toOpenEscalation(row: EscalationRow, assigneeName: string | null): OpenEscalation {
  return {
    id: row.id,
    assignee: row.assigneeUserId
      ? { userId: row.assigneeUserId, name: assigneeName ?? 'A team member' }
      : null,
    since: row.createdAt.toISOString(),
    source: row.source,
    urgent: row.urgent,
    afterHours: row.afterHours,
    reminders: row.reminders,
  };
}

export interface RemindersQueued {
  tenantId: string;
  queued: number;
}

/** The scheduler's half (§5.5): runs `inbox_queue_escalation_reminders()` on the outbox zone. */
export async function queueEscalationReminders(zdb: ZoneDb): Promise<RemindersQueued[]> {
  const res = await zdb.db.execute<{ tenant_id: string; queued: number }>(
    sql`select tenant_id, queued from inbox_queue_escalation_reminders()`,
  );
  return res.rows.map((x) => ({ tenantId: x.tenant_id, queued: Number(x.queued) }));
}
