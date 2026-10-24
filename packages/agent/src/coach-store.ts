import { and, desc, eq, inArray, lt, ne, or, schema, sql, type Tx } from '@kaki/db';

/**
 * Coaching sessions and their messages (FEAT-027 §5.3), on the dashboard zone. Nothing
 * here writes `conversations`, `messages` or the outbox, so coaching never reaches a
 * channel, the inbox, analytics or fair use (ADR-009).
 */

export type CoachingSessionRow = typeof schema.coachingSessions.$inferSelect;
export type CoachingMessageRow = typeof schema.coachingMessages.$inferSelect;
export type CoachingOrigin = (typeof schema.COACHING_ORIGINS)[number];

export class CoachingSessionNotFoundError extends Error {}

export const SESSIONS_PAGE = 20;
export const TITLE_MAX = 80;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createSession(
  tx: Tx,
  input: { tenantId: string; userId: string; origin: CoachingOrigin },
): Promise<CoachingSessionRow> {
  const [row] = await tx
    .insert(schema.coachingSessions)
    .values({ tenantId: input.tenantId, createdBy: input.userId, origin: input.origin })
    .returning();
  return row!;
}

/** The session, or null when it doesn't exist, is another tenant's or the ID is malformed. */
export async function getSession(
  tx: Tx,
  tenantId: string,
  id: string,
  lock = false,
): Promise<CoachingSessionRow | null> {
  if (!UUID.test(id)) return null;
  const q = tx
    .select()
    .from(schema.coachingSessions)
    .where(and(eq(schema.coachingSessions.tenantId, tenantId), eq(schema.coachingSessions.id, id)));
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
}

function encodeCursor(row: CoachingSessionRow): string {
  return Buffer.from(`${row.updatedAt.toISOString()}|${row.id}`).toString('base64url');
}

export class InvalidSessionCursorError extends Error {}

function decodeCursor(cursor: string): { ts: Date; id: string } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const date = new Date(ts ?? '');
  if (!id || !UUID.test(id) || Number.isNaN(date.getTime()))
    throw new InvalidSessionCursorError('bad cursor');
  return { ts: date, id };
}

/** The tenant's sessions, newest first, everyone's (D8). Replays are listed by the replay screen (FEAT-028). */
export async function listSessions(
  tx: Tx,
  tenantId: string,
  cursor?: string,
): Promise<{ sessions: CoachingSessionRow[]; nextCursor: string | null }> {
  const s = schema.coachingSessions;
  const after = cursor ? decodeCursor(cursor) : null;
  const rows = await tx
    .select()
    .from(s)
    .where(
      and(
        eq(s.tenantId, tenantId),
        // Replays and correction replays have their own screens (FEAT-028, FEAT-018 §3).
        sql`${s.origin} not in ('replay', 'correction')`,
        after
          ? or(lt(s.updatedAt, after.ts), and(eq(s.updatedAt, after.ts), lt(s.id, after.id)))
          : undefined,
      ),
    )
    .orderBy(desc(s.updatedAt), desc(s.id))
    .limit(SESSIONS_PAGE + 1);
  const page = rows.slice(0, SESSIONS_PAGE);
  return {
    sessions: page,
    nextCursor: rows.length > SESSIONS_PAGE ? encodeCursor(page.at(-1)!) : null,
  };
}

/** A session's messages in order; with `limit`, the last ones. */
export async function sessionMessages(
  tx: Tx,
  tenantId: string,
  sessionId: string,
  limit?: number,
): Promise<CoachingMessageRow[]> {
  const m = schema.coachingMessages;
  const where = and(eq(m.tenantId, tenantId), eq(m.sessionId, sessionId));
  if (limit === undefined) return tx.select().from(m).where(where).orderBy(m.seq);
  const rows = await tx.select().from(m).where(where).orderBy(desc(m.seq)).limit(limit);
  return rows.reverse();
}

export type NewCoachingMessage = Omit<
  typeof schema.coachingMessages.$inferInsert,
  'tenantId' | 'sessionId' | 'seq' | 'id' | 'createdAt'
>;

/**
 * Appends messages to a session in order, under a lock on the session row; sets the
 * title from the first question and bumps `updated_at`.
 */
export async function appendMessages(
  tx: Tx,
  input: { tenantId: string; sessionId: string; messages: NewCoachingMessage[] },
): Promise<CoachingMessageRow[]> {
  const session = await getSession(tx, input.tenantId, input.sessionId, true);
  if (!session) throw new CoachingSessionNotFoundError('session not found');
  const [{ max }] = (
    await tx.execute<{ max: number | null }>(
      sql`select max(seq) as max from coaching_messages
          where tenant_id = ${input.tenantId} and session_id = ${input.sessionId}`,
    )
  ).rows as [{ max: number | null }];
  let seq = Number(max ?? 0);
  const rows = await tx
    .insert(schema.coachingMessages)
    .values(
      input.messages.map((m) => ({
        ...m,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        seq: ++seq,
      })),
    )
    .returning();
  const question = input.messages.find((m) => m.kind === 'question');
  await tx
    .update(schema.coachingSessions)
    .set({
      updatedAt: sql`now()`,
      ...(session.title === null && question
        ? { title: question.body.trim().slice(0, TITLE_MAX) }
        : {}),
    })
    .where(
      and(
        eq(schema.coachingSessions.tenantId, input.tenantId),
        eq(schema.coachingSessions.id, input.sessionId),
      ),
    );
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function getMessage(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<CoachingMessageRow | null> {
  if (!UUID.test(id)) return null;
  const [row] = await tx
    .select()
    .from(schema.coachingMessages)
    .where(and(eq(schema.coachingMessages.tenantId, tenantId), eq(schema.coachingMessages.id, id)));
  return row ?? null;
}

// ---- Replay (FEAT-028 §5.2): a session of origin `replay`, its answers of kind `replay`.

/** A replay session. No title: visitor text is never copied into coaching (D7). */
export async function createReplaySession(
  tx: Tx,
  input: { tenantId: string; userId: string; conversationId: string; includeUnreviewed: boolean },
): Promise<CoachingSessionRow> {
  const [row] = await tx
    .insert(schema.coachingSessions)
    .values({
      tenantId: input.tenantId,
      createdBy: input.userId,
      origin: 'replay',
      replayConversationId: input.conversationId,
      includeUnreviewed: input.includeUnreviewed,
    })
    .returning();
  return row!;
}

/**
 * A correction's replay session (FEAT-018 §5.4): the visitor questions chosen at
 * acceptance, newest first. One per correction; a concurrent start gets the stored one.
 */
export async function createCorrectionReplaySession(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    correctionId: string;
    questionIds: string[];
    matched: number;
  },
): Promise<{ session: CoachingSessionRow; created: boolean }> {
  const s = schema.coachingSessions;
  const [row] = await tx
    .insert(s)
    .values({
      tenantId: input.tenantId,
      createdBy: input.userId,
      origin: 'correction',
      correctionId: input.correctionId,
      replayQuestionIds: input.questionIds,
      replayMatched: input.matched,
    })
    .onConflictDoNothing({ target: [s.tenantId, s.correctionId] })
    .returning();
  if (row) return { session: row, created: true };
  return {
    session: (await correctionReplaySession(tx, input.tenantId, input.correctionId))!,
    created: false,
  };
}

export async function correctionReplaySession(
  tx: Tx,
  tenantId: string,
  correctionId: string,
): Promise<CoachingSessionRow | null> {
  const s = schema.coachingSessions;
  const [row] = await tx
    .select()
    .from(s)
    .where(and(eq(s.tenantId, tenantId), eq(s.correctionId, correctionId)));
  return row ?? null;
}

/** A replay's stored answers. */
export async function replayMessages(
  tx: Tx,
  tenantId: string,
  sessionId: string,
): Promise<CoachingMessageRow[]> {
  const m = schema.coachingMessages;
  return tx
    .select()
    .from(m)
    .where(and(eq(m.tenantId, tenantId), eq(m.sessionId, sessionId), eq(m.kind, 'replay')))
    .orderBy(m.seq);
}

export type NewReplayMessage = Pick<
  typeof schema.coachingMessages.$inferInsert,
  'body' | 'includeUnreviewed' | 'outcome' | 'factIds' | 'explainer'
> & { replayOf: string; replayConversationId: string };

/**
 * Stores a replayed answer under a lock on the session; a second answer for the same
 * question is dropped and the stored one returned (FEAT-028 §3: concurrent `next`).
 */
export async function insertReplayMessage(
  tx: Tx,
  input: { tenantId: string; sessionId: string; message: NewReplayMessage },
): Promise<CoachingMessageRow> {
  const session = await getSession(tx, input.tenantId, input.sessionId, true);
  if (!session) throw new CoachingSessionNotFoundError('session not found');
  const m = schema.coachingMessages;
  const [inserted] = await tx
    .insert(m)
    .values({
      ...input.message,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      author: 'agent',
      kind: 'replay',
      seq: sql`(select coalesce(max(seq), 0) + 1 from coaching_messages
                where tenant_id = ${input.tenantId} and session_id = ${input.sessionId})`,
    })
    .onConflictDoNothing({ target: [m.tenantId, m.sessionId, m.replayOf] })
    .returning();
  if (inserted) return inserted;
  const [stored] = await tx
    .select()
    .from(m)
    .where(
      and(
        eq(m.tenantId, input.tenantId),
        eq(m.sessionId, input.sessionId),
        eq(m.replayOf, input.message.replayOf),
      ),
    );
  return stored!;
}

/** The newest replay of each conversation, for the picker. */
export async function lastReplays(
  tx: Tx,
  tenantId: string,
  conversationIds: string[],
): Promise<Map<string, string>> {
  if (!conversationIds.length) return new Map();
  const s = schema.coachingSessions;
  const rows = await tx
    .selectDistinctOn([s.replayConversationId], {
      conversationId: s.replayConversationId,
      id: s.id,
    })
    .from(s)
    .where(and(eq(s.tenantId, tenantId), inArray(s.replayConversationId, conversationIds)))
    .orderBy(s.replayConversationId, desc(s.createdAt));
  return new Map(rows.map((r) => [r.conversationId!, r.id]));
}
