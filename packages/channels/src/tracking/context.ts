/**
 * The web context one conversation may use (AGT-05, INB-04; FEAT-029 §5.5, D7): the current
 * page always; viewed pages, source and the returning flag only in `full` scope (mode `on`, or
 * `consent` with an accepted choice; in consent mode only consented rows). Read-only; works
 * under the visitor and dashboard zones.
 */
import type { Utm, WebContext } from '@kaki/contracts';
import { and, desc, eq, gte, lt, lte, ne, schema, sql, type Tx } from '@kaki/db';
import { visitorChoice } from './choice.js';
import { visitorTrackingMode } from './settings.js';

const ev = schema.visitorEvents;
const msgs = schema.messages;
const convs = schema.conversations;

export const WEB_WINDOW_MS = 24 * 60 * 60_000;
export const WEB_VIEWED_MAX = 10;

export const PAGE_ONLY = (currentPage: string | null): WebContext => ({
  scope: 'page_only',
  currentPage,
  viewed: [],
  source: null,
  returning: false,
});

/** Newest first, distinct by path (summed dwell, newest time), at most 10. */
export function distinctViews(
  rows: { path: string; dwellMs: number; viewedAt: Date }[],
): WebContext['viewed'] {
  const byPath = new Map<string, { path: string; dwellMs: number; at: string }>();
  for (const r of rows) {
    const seen = byPath.get(r.path);
    if (seen) seen.dwellMs += r.dwellMs;
    else if (byPath.size < WEB_VIEWED_MAX)
      byPath.set(r.path, { path: r.path, dwellMs: r.dwellMs, at: r.viewedAt.toISOString() });
  }
  return [...byPath.values()];
}

export async function webContextOf(
  tx: Tx,
  input: { tenantId: string; conversationId: string; upToSeq?: number },
): Promise<WebContext> {
  const [conv] = await tx
    .select({ visitorId: convs.visitorId, createdAt: convs.createdAt, channel: convs.channel })
    .from(convs)
    .where(and(eq(convs.tenantId, input.tenantId), eq(convs.id, input.conversationId)));
  if (!conv || conv.channel !== 'widget') return PAGE_ONLY(null);
  const [last] = await tx
    .select({ page: msgs.pagePath, at: msgs.createdAt })
    .from(msgs)
    .where(
      and(
        eq(msgs.tenantId, input.tenantId),
        eq(msgs.conversationId, input.conversationId),
        eq(msgs.author, 'visitor'),
        ...(input.upToSeq !== undefined ? [lte(msgs.seq, input.upToSeq)] : []),
      ),
    )
    .orderBy(desc(msgs.seq))
    .limit(1);
  const currentPage = last?.page ?? null;
  const visitorId = conv.visitorId;
  const mode = await visitorTrackingMode(tx, input.tenantId);
  if (mode === 'off') return PAGE_ONLY(currentPage);
  const consent = mode === 'consent';
  if (consent && (await visitorChoice(tx, input.tenantId, visitorId)) !== 'accepted')
    return PAGE_ONLY(currentPage);

  const anchor = last?.at ?? conv.createdAt;
  const from = new Date(anchor.getTime() - WEB_WINDOW_MS);
  const scoped = and(
    eq(ev.tenantId, input.tenantId),
    eq(ev.visitorId, visitorId),
    ...(consent ? [eq(ev.consented, true)] : []),
  );
  const rows = await tx
    .select({
      path: ev.path,
      dwellMs: ev.dwellMs,
      viewedAt: ev.viewedAt,
      referrer: ev.referrer,
      utm: ev.utm,
    })
    .from(ev)
    .where(and(scoped, gte(ev.viewedAt, from), lte(ev.viewedAt, anchor)))
    .orderBy(desc(ev.viewedAt))
    .limit(200);
  const earliest = rows.at(-1);
  const before = new Date(conv.createdAt.getTime() - WEB_WINDOW_MS);
  const [olderView] = await tx
    .select({ one: sql<number>`1` })
    .from(ev)
    .where(and(scoped, lt(ev.viewedAt, before)))
    .limit(1);
  const [olderConv] = olderView
    ? [olderView]
    : await tx
        .select({ one: sql<number>`1` })
        .from(convs)
        .where(
          and(
            eq(convs.tenantId, input.tenantId),
            eq(convs.visitorId, visitorId),
            ne(convs.id, input.conversationId),
            lt(convs.createdAt, before),
          ),
        )
        .limit(1);
  return {
    scope: 'full',
    currentPage,
    viewed: distinctViews(rows),
    source: earliest
      ? { utm: (earliest.utm as Utm | null) ?? null, referrer: earliest.referrer }
      : null,
    returning: Boolean(olderConv),
  };
}
