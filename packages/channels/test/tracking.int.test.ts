/**
 * Page tracking and web context (CHN-03, AGT-05; FEAT-029 §5.1, §5.3–§5.5; AC-1, AC-3, AC-4, AC-9).
 */
import { randomUUID } from 'node:crypto';
import type { TrackEvent, TrackingMode } from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NotConsentModeError,
  recordChoice,
  recordEvents,
  setTrackingMode,
  trackingColumns,
  webContextOf,
} from '../src/tracking/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const visitor = <T>(fn: (tx: Tx) => Promise<T>, t = TENANT_A) =>
  withTenant(tdb.zone('visitor'), t, fn);
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const H = 60 * 60_000;

async function setMode(mode: TrackingMode, t = TENANT_A) {
  const c = trackingColumns(mode);
  await owner.query(
    `update widget_settings set tracking_enabled = $2, tracking_consent_mode = $3 where tenant_id = $1`,
    [t, c.trackingEnabled, c.trackingConsentMode],
  );
}
const view = (path: string, at = ago(60_000), extra: Partial<TrackEvent> = {}): TrackEvent =>
  ({ type: 'view', id: randomUUID(), sessionId: randomUUID(), path, at, ...extra }) as TrackEvent;
const record = (visitorId: string, events: TrackEvent[], t = TENANT_A) =>
  visitor((tx) => recordEvents(tx, { tenantId: t, visitorId, events, now }), t);
const rows = (visitorId: string) =>
  owner
    .query<{
      id: string;
      path: string;
      utm: Record<string, string> | null;
      dwell_ms: number;
      scroll_pct: number;
      consented: boolean;
    }>(`select * from visitor_events where visitor_id = $1 order by viewed_at`, [visitorId])
    .then((r) => r.rows);
async function conversation(visitorId: string, createdAt = now.toISOString(), channel = 'widget') {
  const { rows: r } = await owner.query<{ id: string }>(
    `insert into conversations (tenant_id, channel, visitor_id, created_at) values ($1, $2, $3, $4) returning id`,
    [TENANT_A, channel, visitorId, createdAt],
  );
  return r[0]!.id;
}
const message = (conversationId: string, page: string | null, at = now.toISOString()) =>
  owner.query(
    `insert into messages (tenant_id, conversation_id, author, body, page_path, created_at) values ($1, $2, 'visitor', 'hi', $3, $4)`,
    [TENANT_A, conversationId, page, at],
  );
const context = (conversationId: string) =>
  visitor((tx) => webContextOf(tx, { tenantId: TENANT_A, conversationId }));

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
beforeEach(async () => {
  await owner.query(`delete from visitor_events`);
  await owner.query(`delete from visitor_tracking_choices`);
  await setMode('on');
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('recordEvents (FEAT-029 §5.3)', () => {
  it('stores nothing in off, or in consent mode without acceptance', async () => {
    const v = randomUUID();
    await setMode('off');
    expect((await record(v, [view('/a')])).stored).toBe(0);
    await setMode('consent');
    expect((await record(v, [view('/a')])).stored).toBe(0);
    expect(await rows(v)).toEqual([]);
  });

  it('on: stores a masked path and UTM; a retried view is one row', async () => {
    const v = randomUUID();
    const e = view('/u/S1234567D', ago(60_000), {
      utm: { source: 'ig', campaign: 'S1234567D' },
      referrer: 'Google.com',
    } as Partial<TrackEvent>);
    expect((await record(v, [e])).stored).toBe(1);
    expect((await record(v, [e])).stored).toBe(0);
    const [r, ...rest] = await rows(v);
    expect(rest).toEqual([]);
    expect(r!.path).not.toContain('S1234567D');
    expect(r!.path.startsWith('/u/')).toBe(true);
    expect(r!.utm!.source).toBe('ig');
    expect(r!.utm!.campaign).not.toContain('S1234567D');
    expect(r!.consented).toBe(false);
  });

  it("engage only raises values and can't touch another visitor's row", async () => {
    const v = randomUUID();
    const e = view('/a');
    await record(v, [e]);
    await record(v, [{ type: 'engage', id: e.id, dwellMs: 5000, scroll: 60 }]);
    await record(v, [{ type: 'engage', id: e.id, dwellMs: 100, scroll: 10 }]);
    const other = await record(randomUUID(), [
      { type: 'engage', id: e.id, dwellMs: 9999, scroll: 99 },
    ]);
    expect(other.stored).toBe(0);
    const tenantB = await record(
      v,
      [{ type: 'engage', id: e.id, dwellMs: 9999, scroll: 99 }],
      TENANT_B,
    );
    expect(tenantB.stored).toBe(0);
    expect((await rows(v)).map((r) => [r.dwell_ms, r.scroll_pct])).toEqual([[5000, 60]]);
  });
});

describe('recordChoice (FEAT-029 §5.4)', () => {
  it('409s outside consent mode', async () => {
    await expect(
      visitor((tx) =>
        recordChoice(tx, { tenantId: TENANT_A, visitorId: randomUUID(), choice: 'accepted' }),
      ),
    ).rejects.toBeInstanceOf(NotConsentModeError);
  });

  it('accepted → consented events; declined after accepted deletes them and stops tracking', async () => {
    await setMode('consent');
    const v = randomUUID();
    await visitor((tx) =>
      recordChoice(tx, { tenantId: TENANT_A, visitorId: v, choice: 'accepted' }),
    );
    expect((await record(v, [view('/a')])).stored).toBe(1);
    expect((await rows(v))[0]!.consented).toBe(true);
    const { rows: choice } = await owner.query(
      `select choice, wording from visitor_tracking_choices where visitor_id = $1`,
      [v],
    );
    expect(choice).toEqual([{ choice: 'accepted', wording: 'tracking-v1' }]);
    const out = await visitor((tx) =>
      recordChoice(tx, { tenantId: TENANT_A, visitorId: v, choice: 'declined' }),
    );
    expect(out.deleted).toBe(1);
    expect(await rows(v)).toEqual([]);
    expect((await record(v, [view('/b')])).stored).toBe(0);
    const { rows: audits } = await owner.query<{ p: string }>(
      `select payload::text as p from audit_entries where tenant_id = $1 and event_type = 'tracking.choice'`,
      [TENANT_A],
    );
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });
});

describe('setTrackingMode (FEAT-029 §5.1)', () => {
  it('sets the mode and audits from → to', async () => {
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      setTrackingMode({ tx, tenantId: TENANT_A, userId: randomUUID() }, 'consent'),
    );
    const { rows: r } = await owner.query(
      `select tracking_enabled, tracking_consent_mode, tracking_updated_at is not null as stamped from widget_settings where tenant_id = $1`,
      [TENANT_A],
    );
    expect(r).toEqual([{ tracking_enabled: true, tracking_consent_mode: true, stamped: true }]);
    const { rows: a } = await owner.query<{ p: string }>(
      `select payload::text as p from audit_entries where tenant_id = $1 and event_type = 'widget.tracking_changed' order by seq desc limit 1`,
      [TENANT_A],
    );
    expect(JSON.parse(a[0]!.p)).toMatchObject({ from: 'on', to: 'consent' });
  });
});

describe('webContextOf (FEAT-029 §5.5)', () => {
  it('full: viewed distinct within 24 h, source of the earliest view, returning', async () => {
    const v = randomUUID();
    await conversation(v, ago(3 * 24 * H));
    await record(v, [
      view('/cakes', ago(30 * 60_000), {
        utm: { source: 'ig' },
        referrer: 'instagram.com',
      } as Partial<TrackEvent>),
      view('/kueh', ago(20 * 60_000)),
      view('/cakes', ago(10 * 60_000)),
    ]);
    await owner.query(
      `insert into visitor_events (tenant_id, id, visitor_id, session_id, path, consented, viewed_at)
       values ($1, gen_random_uuid(), $2, gen_random_uuid(), '/old', false, now() - interval '2 days')`,
      [TENANT_A, v],
    );
    const c = await conversation(v);
    await message(c, '/kueh', ago(5 * 60_000));
    await message(c, '/cakes/premium');
    const web = await context(c);
    expect(web.scope).toBe('full');
    expect(web.currentPage).toBe('/cakes/premium');
    expect(web.viewed.map((x) => x.path)).toEqual(['/cakes', '/kueh']);
    expect(web.source).toEqual({ utm: { source: 'ig' }, referrer: 'instagram.com' });
    expect(web.returning).toBe(true);
    const fresh = randomUUID();
    const c2 = await conversation(fresh);
    await message(c2, '/a');
    expect((await context(c2)).returning).toBe(false);
  });

  it('page_only when off, unconsented, or for events collected before consent mode', async () => {
    const v = randomUUID();
    await record(v, [view('/cakes')]);
    const c = await conversation(v);
    await message(c, '/menu');
    await setMode('off');
    expect(await context(c)).toEqual({
      scope: 'page_only',
      currentPage: '/menu',
      viewed: [],
      source: null,
      returning: false,
    });
    await setMode('consent');
    expect((await context(c)).scope).toBe('page_only');
    await visitor((tx) =>
      recordChoice(tx, { tenantId: TENANT_A, visitorId: v, choice: 'accepted' }),
    );
    // The pre-consent row isn't consented, so accepted gives full scope with no views from it.
    const web = await context(c);
    expect(web.scope).toBe('full');
    expect(web.viewed).toEqual([]);
  });

  it('a non-widget conversation has no web context', async () => {
    const c = await conversation(randomUUID(), now.toISOString(), 'email');
    expect(await context(c)).toMatchObject({ scope: 'page_only', currentPage: null });
  });
});
