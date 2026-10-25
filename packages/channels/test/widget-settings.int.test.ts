import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { createWebsiteSource, dashboardKb, parseWebsite } from '@kaki/kb';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addOrigin,
  DetectRunningError,
  getWidgetSettings,
  InvalidOriginError,
  NoSiteError,
  OriginExistsError,
  OriginNotAllowedError,
  OriginNotFoundError,
  recordInstallSeen,
  recordRejectedOrigin,
  removeOrigin,
  requestDetection,
  runThemeDetect,
  setAppearance,
  TooManyOriginsError,
  visitorWidgetTheme,
  type ThemeProbe,
  type WidgetContext,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = 'user-owner-1';
const URLS = {
  loaderUrl: 'https://cdn.kaki.test/w/v1/loader.js',
  previewUrl: 'https://cdn.kaki.test/w/v1/preview.html',
  apiUrl: 'https://api.kaki.test',
};

const dash = <T>(tenantId: string, fn: (ctx: WidgetContext) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), tenantId, (tx) => fn({ tx, tenantId, userId: USER }));
const visitor = <T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>,
) => withTenant(tdb.zone('visitor'), tenantId, fn);
const settings = (t = TENANT_A) => dash(t, (ctx) => getWidgetSettings(ctx, URLS));

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
afterEach(async () => {
  await owner.query(`delete from outbox`);
  await owner.query(`delete from kb_sources`);
  await owner.query(`update tenants set allowed_origins = '{http://localhost:5175}'`);
  await owner.query(
    `update widget_settings set position = 'right', theme_overrides = '{}', detected_theme = null,
       detect_status = 'none', detect_failure = null, detect_requested_at = null,
       install_seen_at = null, install_seen_origin = null, last_seen_at = null,
       rejected_origin = null, rejected_at = null`,
  );
});

describe('allowed origins (CHN-11, D3)', () => {
  it('adds normalised, sorted origins; refuses duplicates and bad input; removes', async () => {
    expect(await dash(TENANT_A, (ctx) => addOrigin(ctx, 'WWW.Bakery.sg/menu'))).toBe(
      'https://www.bakery.sg',
    );
    await dash(TENANT_A, (ctx) => addOrigin(ctx, 'bakery.sg'));
    await expect(dash(TENANT_A, (ctx) => addOrigin(ctx, 'https://bakery.sg/'))).rejects.toThrow(
      OriginExistsError,
    );
    await expect(dash(TENANT_A, (ctx) => addOrigin(ctx, '*.bakery.sg'))).rejects.toThrow(
      InvalidOriginError,
    );
    let s = await settings();
    expect(s.allowedOrigins.map((o) => o.origin)).toEqual([
      'http://localhost:5175',
      'https://bakery.sg',
      'https://www.bakery.sg',
    ]);
    await dash(TENANT_A, (ctx) => removeOrigin(ctx, 'https://bakery.sg'));
    await expect(dash(TENANT_A, (ctx) => removeOrigin(ctx, 'https://bakery.sg'))).rejects.toThrow(
      OriginNotFoundError,
    );
    s = await settings();
    expect(s.allowedOrigins.map((o) => o.origin)).toEqual([
      'http://localhost:5175',
      'https://www.bakery.sg',
    ]);
    // Tenant B never sees tenant A's origins.
    expect((await settings(TENANT_B)).allowedOrigins.map((o) => o.origin)).toEqual([
      'http://localhost:5175',
    ]);
  });

  it('allows 20 by hand besides the website sources, and marks those fromWebsite', async () => {
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      createWebsiteSource(
        dashboardKb(tx, TENANT_A, USER),
        parseWebsite('https://kakibakery.test/'),
        {
          pageLimit: 10,
        },
      ),
    );
    let s = await settings();
    expect(s.allowedOrigins).toContainEqual({
      origin: 'https://kakibakery.test',
      fromWebsite: true,
    });
    expect(s.allowedOrigins).toContainEqual({
      origin: 'http://localhost:5175',
      fromWebsite: false,
    });
    expect(s.siteUrl).toBe('https://kakibakery.test/');
    for (let i = 1; i < 20; i++) await dash(TENANT_A, (ctx) => addOrigin(ctx, `h${i}.bakery.sg`));
    await expect(dash(TENANT_A, (ctx) => addOrigin(ctx, 'h20.bakery.sg'))).rejects.toThrow(
      TooManyOriginsError,
    );
    s = await settings();
    expect(s.allowedOrigins.filter((o) => !o.fromWebsite)).toHaveLength(20);
  });
});

describe('install check (ONB-07, D8)', () => {
  it('records the install once, then last seen at most hourly', async () => {
    const t0 = new Date('2026-10-25T01:00:00.000Z');
    const allowed = ['http://localhost:5175'];
    const rec = (at: Date) =>
      visitor(TENANT_A, (tx) =>
        recordInstallSeen(tx, TENANT_A, 'http://localhost:5175', allowed, at),
      );
    expect(await rec(t0)).toBe('first');
    expect(await rec(new Date(t0.getTime() + 10 * 60_000))).toBe('throttled');
    expect(await rec(new Date(t0.getTime() + 61 * 60_000))).toBe('seen');
    const s = await settings();
    expect(s.install).toMatchObject({
      state: 'detected',
      origin: 'http://localhost:5175',
      seenAt: t0.toISOString(),
      lastSeenAt: new Date(t0.getTime() + 61 * 60_000).toISOString(),
    });
    // Removing the origin makes the install wait again.
    await dash(TENANT_A, (ctx) => removeOrigin(ctx, 'http://localhost:5175'));
    expect((await settings()).install.state).toBe('waiting');
  });

  it('records a rejected origin at most once a minute and shows wrong_domain', async () => {
    const t0 = new Date();
    const rej = (origin: string, at: Date) =>
      visitor(TENANT_A, (tx) => recordRejectedOrigin(tx, TENANT_A, origin, at));
    expect(await rej('https://copycat.example', t0)).toBe(true);
    expect(await rej('https://other.example', new Date(t0.getTime() + 30_000))).toBe(false);
    let s = await settings();
    expect(s.install).toMatchObject({
      state: 'wrong_domain',
      rejectedOrigin: 'https://copycat.example',
    });
    expect(await rej('https://other.example/x', new Date(t0.getTime() + 61_000))).toBe(true);
    s = await settings();
    expect(s.install.rejectedOrigin).toBe('https://other.example');
    expect(await rej('not a url', new Date(t0.getTime() + 200_000))).toBe(false);
    expect((await settings(TENANT_B)).install.state).toBe('waiting');
  });
});

describe('appearance and the visitor theme', () => {
  it('stores the look and serves it to the visitor zone', async () => {
    await dash(TENANT_A, (ctx) =>
      setAppearance(ctx, { position: 'left', overrides: { accent: '#c2410c', radius: 8 } }),
    );
    const theme = await visitor(TENANT_A, (tx) =>
      visitorWidgetTheme(tx, TENANT_A, 'wk_dev_bakery', URLS.apiUrl),
    );
    expect(theme).toEqual({
      position: 'left',
      overrides: { accent: '#c2410c', radius: 8 },
      detected: null,
      logoUrl: null,
    });
    expect((await settings(TENANT_B)).theme.position).toBe('right');
  });
});

describe('theme detection (§5.4, D4)', () => {
  const probeOk: ThemeProbe = async () => ({
    ok: true,
    theme: { accent: '#1d4ed8', font: 'Lora', radius: 6, scheme: 'light' },
  });

  it('needs a site, an allowed origin, and one at a time', async () => {
    await owner.query(`update tenants set allowed_origins = '{}' where id = $1`, [TENANT_A]);
    await expect(dash(TENANT_A, (ctx) => requestDetection(ctx, {}))).rejects.toThrow(NoSiteError);
    await owner.query(`update tenants set allowed_origins = '{https://bakery.sg}' where id = $1`, [
      TENANT_A,
    ]);
    await expect(
      dash(TENANT_A, (ctx) => requestDetection(ctx, { origin: 'https://copycat.example' })),
    ).rejects.toThrow(OriginNotAllowedError);
    const t0 = new Date();
    const req = await dash(TENANT_A, (ctx) => requestDetection(ctx, {}, t0));
    expect(req.url).toBe('https://bakery.sg/');
    await expect(
      dash(TENANT_A, (ctx) => requestDetection(ctx, {}, new Date(t0.getTime() + 60_000))),
    ).rejects.toThrow(DetectRunningError);
    // Older than two minutes: a stuck job no longer blocks.
    await dash(TENANT_A, (ctx) => requestDetection(ctx, {}, new Date(t0.getTime() + 121_000)));
    const { rows } = await owner.query(
      `select topic, group_key, payload from outbox where tenant_id = $1 order by created_at`,
      [TENANT_A],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      topic: 'ingest',
      group_key: `theme:${TENANT_A}`,
      payload: { kind: 'theme_detect', tenantId: TENANT_A, url: 'https://bakery.sg/' },
    });
    expect((await settings()).detection.status).toBe('queued');
  });

  it('stores done or failed, and ignores a stale or repeated delivery', async () => {
    const t0 = new Date('2026-10-25T02:00:00.000Z');
    await dash(TENANT_A, (ctx) => requestDetection(ctx, { origin: 'http://localhost:5175' }, t0));
    const job = {
      kind: 'theme_detect' as const,
      tenantId: TENANT_A,
      url: 'http://localhost:5175/',
      requestedAt: t0.toISOString(),
    };
    const ingest = tdb.zone('ingest');
    expect(await runThemeDetect(ingest, job, probeOk)).toBe('done');
    expect(await runThemeDetect(ingest, job, probeOk)).toBe('stale');
    let s = await settings();
    expect(s.detection).toMatchObject({ status: 'done', failure: null });
    expect(s.theme.detected).toMatchObject({
      accent: '#1d4ed8',
      font: 'Lora',
      radius: 6,
      scheme: 'light',
      url: 'http://localhost:5175/',
    });

    const t1 = new Date('2026-10-25T02:10:00.000Z');
    await dash(TENANT_A, (ctx) => requestDetection(ctx, {}, t1));
    // The old job comes back after a newer request: stale.
    expect(await runThemeDetect(ingest, job, probeOk)).toBe('stale');
    const fail: ThemeProbe = async () => ({ ok: false, failure: 'timeout' });
    expect(await runThemeDetect(ingest, { ...job, requestedAt: t1.toISOString() }, fail)).toBe(
      'failed',
    );
    s = await settings();
    expect(s.detection).toMatchObject({ status: 'failed', failure: 'timeout' });
    // A failed run keeps the last good detection.
    expect(s.theme.detected?.accent).toBe('#1d4ed8');
  });
});

describe('audit (ADR-014)', () => {
  it('records widget changes with codes and hashes, never the origin text', async () => {
    await dash(TENANT_A, (ctx) => addOrigin(ctx, 'secret-shop.example'));
    await dash(TENANT_A, (ctx) =>
      setAppearance(ctx, { position: 'left', overrides: { radius: 4 } }),
    );
    await dash(TENANT_A, (ctx) => removeOrigin(ctx, 'https://secret-shop.example'));
    const { rows } = await owner.query(
      `select event_type as action, payload::text as payload from audit_entries
       where tenant_id = $1 and event_type like 'widget.%' order by seq`,
      [TENANT_A],
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'widget.origin_added',
        'widget.appearance_changed',
        'widget.origin_removed',
      ]),
    );
    for (const r of rows) expect(r.payload).not.toContain('secret-shop');
  });
});
