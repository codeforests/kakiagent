/**
 * Website widget endpoints (FEAT-032 §3; AC-1–AC-5, AC-10, AC-11) and the config route's
 * theme, install check and silent refusal on an unlisted origin (CHN-11, UC-05 5a).
 */
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asB: string;
let asAgent: string;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb);
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const staff = await owner.query<{ id: string }>(
    `insert into users (email) values ('staff@kaki-bakery.test') returning id`,
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    staff.rows[0]!.id,
  ]);
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`delete from outbox`);
  await owner.query(`update tenants set allowed_origins = '{http://localhost:5175}'`);
  await owner.query(
    `update widget_settings set position = 'right', theme_overrides = '{}', detected_theme = null,
       detect_status = 'none', detect_failure = null, detect_requested_at = null, logo = null,
       logo_type = null, install_seen_at = null, install_seen_origin = null, last_seen_at = null,
       rejected_origin = null, rejected_at = null`,
  );
});

const call = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  who: string | null,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: { ...(who ? { cookie: who } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as string } : {}),
  });

describe('access', () => {
  it('needs a session and settings.manage; tenant B sees only its own widget', async () => {
    expect((await call('GET', '/api/v1/widget', null)).statusCode).toBe(401);
    const agent = await call('GET', '/api/v1/widget', asAgent);
    expect(agent.statusCode).toBe(403);
    expect(agent.json().error).toBe('forbidden');
    expect(
      (await call('POST', '/api/v1/widget/origins', asAgent, { origin: 'x.sg' })).statusCode,
    ).toBe(403);
    await call('POST', '/api/v1/widget/origins', asA, { origin: 'bakery.sg' });
    const b = (await call('GET', '/api/v1/widget', asB)).json();
    expect(b.widgetKey).not.toBe('wk_dev_bakery');
    expect(b.allowedOrigins.map((o: { origin: string }) => o.origin)).toEqual([
      'http://localhost:5175',
    ]);
    // B can't remove A's origin: it isn't on B's list.
    expect(
      (
        await call(
          'DELETE',
          `/api/v1/widget/origins/${encodeURIComponent('https://bakery.sg')}`,
          asB,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('GET /api/v1/widget and appearance', () => {
  it('returns the snippet, preview and install state, and round-trips the appearance', async () => {
    const s = (await call('GET', '/api/v1/widget', asA)).json();
    expect(s).toMatchObject({
      widgetKey: 'wk_dev_bakery',
      snippet:
        '<script src="http://localhost:5175/w/v1/loader.js" data-key="wk_dev_bakery" data-api="http://localhost:3000" async></script>',
      previewUrl: 'http://localhost:5175/w/v1/preview.html',
      detection: { status: 'none', failure: null, requestedAt: null },
      install: { state: 'waiting' },
      theme: { position: 'right', overrides: {}, detected: null, logoUrl: null },
      siteUrl: 'http://localhost:5175',
    });
    const put = await call('PUT', '/api/v1/widget/appearance', asA, {
      position: 'left',
      overrides: { accent: '#C2410C', radius: 8, font: { kind: 'system' }, scheme: 'dark' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().theme).toMatchObject({
      position: 'left',
      overrides: { accent: '#c2410c', radius: 8, font: { kind: 'system' }, scheme: 'dark' },
    });
    for (const bad of [
      { position: 'top', overrides: {} },
      { position: 'left', overrides: { radius: 21 } },
      { position: 'left', overrides: { font: { kind: 'custom', family: 'x;}' } } },
    ]) {
      const r = await call('PUT', '/api/v1/widget/appearance', asA, bad);
      expect(r.statusCode).toBe(422);
      expect(r.json().error).toBe('invalid_body');
    }
  });
});

describe('POST /api/v1/widget/theme/detect', () => {
  it('queues one job, refuses a second while running, and checks the origin', async () => {
    const r = await call('POST', '/api/v1/widget/theme/detect', asA, {});
    expect(r.statusCode).toBe(202);
    expect(r.json().detection.status).toBe('queued');
    const again = await call('POST', '/api/v1/widget/theme/detect', asA, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('detect_running');
    await owner.query(`update widget_settings set detect_status = 'done'`);
    const other = await call('POST', '/api/v1/widget/theme/detect', asA, {
      origin: 'https://copycat.example',
    });
    expect(other.statusCode).toBe(422);
    expect(other.json().error).toBe('origin_not_allowed');
    const { rows } = await owner.query(`select payload from outbox where tenant_id = $1`, [
      TENANT_A,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ kind: 'theme_detect', url: 'http://localhost:5175/' });
    await owner.query(`update tenants set allowed_origins = '{}' where id = $1`, [TENANT_A]);
    const none = await call('POST', '/api/v1/widget/theme/detect', asA, {});
    expect(none.statusCode).toBe(422);
    expect(none.json().error).toBe('no_site');
  });
});

describe('logo', () => {
  it('stores a PNG, serves it with immutable caching, and 404s after delete', async () => {
    const put = await call('PUT', '/api/v1/widget/logo', asA, PNG, { 'content-type': 'image/png' });
    expect(put.statusCode).toBe(200);
    const logoUrl: string = put.json().theme.logoUrl;
    expect(logoUrl).toMatch(/^http:\/\/localhost:3000\/widget\/v1\/logo\/wk_dev_bakery\?v=\d+$/);
    const path = new URL(logoUrl).pathname + new URL(logoUrl).search;
    const img = await app.inject({ method: 'GET', url: path });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.rawPayload.equals(PNG)).toBe(true);
    const del = await call('DELETE', '/api/v1/widget/logo', asA);
    expect(del.json().theme.logoUrl).toBeNull();
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/widget/v1/logo/wk_nope' })).statusCode).toBe(
      404,
    );
  });

  it('refuses over 100 KB (413) and a type its bytes or header do not match (415)', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(102_400)]);
    const tooBig = await call('PUT', '/api/v1/widget/logo', asA, big, {
      'content-type': 'image/png',
    });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error).toBe('logo_too_large');
    const lie = await call('PUT', '/api/v1/widget/logo', asA, JPEG, {
      'content-type': 'image/png',
    });
    expect(lie.statusCode).toBe(415);
    expect(lie.json().error).toBe('logo_type');
    const svg = await call('PUT', '/api/v1/widget/logo', asA, '<svg/>', {
      'content-type': 'image/svg+xml',
    });
    expect(svg.statusCode).toBe(415);
    expect(svg.json().error).toBe('logo_type');
  });
});

describe('allowed origins', () => {
  it('adds (201), refuses bad (422), duplicates (409) and over 20 (422), removes', async () => {
    const add = await call('POST', '/api/v1/widget/origins', asA, {
      origin: 'https://Bakery.sg/x',
    });
    expect(add.statusCode).toBe(201);
    expect(add.json().allowedOrigins).toContainEqual({
      origin: 'https://bakery.sg',
      fromWebsite: false,
    });
    const bad = await call('POST', '/api/v1/widget/origins', asA, { origin: '*.bakery.sg' });
    expect([bad.statusCode, bad.json().error]).toEqual([422, 'invalid_origin']);
    const dup = await call('POST', '/api/v1/widget/origins', asA, { origin: 'bakery.sg' });
    expect([dup.statusCode, dup.json().error]).toEqual([409, 'origin_exists']);
    for (let i = 3; i <= 20; i++)
      await call('POST', '/api/v1/widget/origins', asA, { origin: `h${i}.bakery.sg` });
    const over = await call('POST', '/api/v1/widget/origins', asA, { origin: 'h21.bakery.sg' });
    expect([over.statusCode, over.json().error]).toEqual([422, 'too_many_origins']);
    const del = await call(
      'DELETE',
      `/api/v1/widget/origins/${encodeURIComponent('https://bakery.sg')}`,
      asA,
    );
    expect(del.statusCode).toBe(200);
    expect(del.json().allowedOrigins.map((o: { origin: string }) => o.origin)).not.toContain(
      'https://bakery.sg',
    );
    const gone = await call(
      'DELETE',
      `/api/v1/widget/origins/${encodeURIComponent('https://bakery.sg')}`,
      asA,
    );
    expect([gone.statusCode, gone.json().error]).toEqual([404, 'not_found']);
  });
});

describe('GET /widget/v1/config (FEAT-032 §3)', () => {
  const config = (origin: string) =>
    app.inject({ method: 'GET', url: '/widget/v1/config?key=wk_dev_bakery', headers: { origin } });

  it('returns the theme from an allowed origin and marks the install', async () => {
    await call('PUT', '/api/v1/widget/appearance', asA, {
      position: 'left',
      overrides: { accent: '#c2410c' },
    });
    const res = await config('http://localhost:5175');
    expect(res.statusCode).toBe(200);
    expect(res.json().theme).toEqual({
      position: 'left',
      overrides: { accent: '#c2410c' },
      detected: null,
      logoUrl: null,
    });
    const s = (await call('GET', '/api/v1/widget', asA)).json();
    expect(s.install).toMatchObject({ state: 'detected', origin: 'http://localhost:5175' });
    expect(s.install.seenAt).not.toBeNull();
  });

  it('is a silent 404 on an unlisted origin: no token, no conversation, wrong_domain', async () => {
    const before = await owner.query(`select count(*)::int as n from conversations`);
    const res = await config('https://copycat.example');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_here', message: 'Widget not available here' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(JSON.stringify(res.json())).not.toContain('token');
    const after = await owner.query(`select count(*)::int as n from conversations`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const s = (await call('GET', '/api/v1/widget', asA)).json();
    expect(s.install).toMatchObject({
      state: 'wrong_domain',
      rejectedOrigin: 'https://copycat.example',
    });
    // Tenant B's install check is untouched.
    expect((await call('GET', '/api/v1/widget', asB)).json().install.state).toBe('waiting');
  });
});
