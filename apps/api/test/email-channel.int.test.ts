/**
 * The email channel's dashboard routes (CHN-04, CHN-10; FEAT-036 §3, §5.5; AC-1, AC-5–AC-8,
 * AC-10): setup, reply cap, the custom sending domain (fixture provider), a delivery retry,
 * attachment downloads, and the inbox thread's deliveries and attachments.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { appendAgentReply, appendVisitorMessage, createConversation } from '@kaki/inbox';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { fixtureIdentities, fixtureTxtResolver } from '@kaki/channels';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asB: string;
let asAgent: string;
const signed: { key: string; filename: string; ttl: number }[] = [];
const published: { channel: string; event: { type: string } }[] = [];

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, {
    email: {
      identities: fixtureIdentities,
      resolver: fixtureTxtResolver,
      downloads: {
        sign: async (key, filename, ttl) => {
          signed.push({ key, filename, ttl });
          return `https://attachments.test/${key}?ttl=${ttl}`;
        },
      },
    },
    publisher: {
      publish: async (channel, event) => void published.push({ channel, event }),
      close: async () => {},
    },
  });
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

const call = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  who: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: { cookie: who },
    ...(payload !== undefined ? { payload: payload as string } : {}),
  });
const view = async (who = asA) => (await call('GET', '/api/v1/channels/email', who)).json();

describe('setup (AC-1)', () => {
  it('is not connected before setup', async () => {
    const res = await call('GET', '/api/v1/channels/email', asA);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: false, connection: null, settingsVersion: 0 });
  });

  it('an Agent may not set it up', async () => {
    expect((await call('POST', '/api/v1/channels/email', asAgent)).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/channels/email', asAgent)).statusCode).toBe(403);
  });

  it('the Owner sets it up offline and hidden, with a forwarding address; again is 409', async () => {
    const res = await call('POST', '/api/v1/channels/email', asA);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      connected: true,
      connection: { state: 'offline' },
      forwardingAddress: 'kaki-bakery@in.kaki.test',
      replyFrom: 'kaki-bakery@in.kaki.test',
      domain: null,
      replyCap: 10,
      ignored: [],
      settingsVersion: 1,
    });
    const conn = await owner.query(
      `select state, offline_mode, ai_reply_cap from channel_connections where id = $1`,
      [body.connection.id],
    );
    expect(conn.rows[0]).toEqual({ state: 'offline', offline_mode: 'hidden', ai_reply_cap: 10 });
    const again = await call('POST', '/api/v1/channels/email', asA);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_connected');
  });

  it('another tenant sees none of it, and its own address is unique', async () => {
    expect(await view(asB)).toMatchObject({ connected: false });
    // Tenant A holds tenant B's slug: B gets the next free address.
    const slugB = (await owner.query(`select slug from tenants where id = $1`, [TENANT_B])).rows[0]
      .slug as string;
    await owner.query(`update email_settings set forwarding_local = $2 where tenant_id = $1`, [
      TENANT_A,
      slugB,
    ]);
    try {
      const res = await call('POST', '/api/v1/channels/email', asB);
      expect(res.statusCode).toBe(201);
      expect(res.json().forwardingAddress).toBe(`${slugB}-2@in.kaki.test`);
    } finally {
      await owner.query(
        `update email_settings set forwarding_local = 'kaki-bakery' where tenant_id = $1`,
        [TENANT_A],
      );
    }
  });

  it('lists ignored mail of the last 7 days by reason', async () => {
    const { connection } = await view();
    for (const [reason, days] of [
      ['auto_reply', 1],
      ['auto_reply', 2],
      ['bounce', 1],
      ['list', 9],
    ] as const)
      await owner.query(
        `insert into inbound_events (tenant_id, connection_id, provider_event_id, outcome, ignore_reason, received_at)
         values ($1, $2, $3, 'ignored', $4, now() - make_interval(days => $5))`,
        [TENANT_A, connection.id, randomUUID(), reason, days],
      );
    expect((await view()).ignored).toEqual([
      { reason: 'auto_reply', count: 2 },
      { reason: 'bounce', count: 1 },
    ]);
  });
});

describe('reply cap (CHN-10; AC-5)', () => {
  it('saves 3; 0 is 422; a stale version is 409', async () => {
    const v = (await view()).settingsVersion;
    const ok = await call('PUT', '/api/v1/channels/email/reply-cap', asA, {
      replyCap: 3,
      settingsVersion: v,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ replyCap: 3, settingsVersion: v + 1 });
    const zero = await call('PUT', '/api/v1/channels/email/reply-cap', asA, {
      replyCap: 0,
      settingsVersion: v + 1,
    });
    expect(zero.statusCode).toBe(422);
    expect(zero.json()).toMatchObject({ error: 'invalid_body', fields: { replyCap: 'invalid' } });
    const stale = await call('PUT', '/api/v1/channels/email/reply-cap', asA, {
      replyCap: 5,
      settingsVersion: v,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('stale');
  });
});

describe('custom sending domain (AC-6)', () => {
  it('free mail and platform addresses are 422', async () => {
    const v = (await view()).settingsVersion;
    for (const address of ['kakibakery@gmail.com', 'hello@in.kaki.test', 'hello@kaki.test']) {
      const res = await call('POST', '/api/v1/channels/email/domain', asA, {
        address,
        settingsVersion: v,
      });
      expect(res.statusCode, address).toBe(422);
      expect(res.json().error).toBe('platform_domain');
    }
  });

  it('adds a domain with six pending records; replies still use the forwarding address', async () => {
    const v = (await view()).settingsVersion;
    const res = await call('POST', '/api/v1/channels/email/domain', asA, {
      address: 'Hello@KakiBakery.test',
      settingsVersion: v,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.domain).toMatchObject({
      address: 'hello@kakibakery.test',
      domain: 'kakibakery.test',
      state: 'pending',
    });
    expect(body.domain.records).toHaveLength(6);
    expect(body.domain.records.every((r: { status: string }) => r.status === 'pending')).toBe(true);
    expect(body.replyFrom).toBe('kaki-bakery@in.kaki.test');
  });

  it('a check verifies the fixture domain; a second within 30 s is 429', async () => {
    const res = await call('POST', '/api/v1/channels/email/domain/check', asA);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      replyFrom: 'hello@kakibakery.test',
      domain: { state: 'verified' },
    });
    expect(res.json().domain.records).toHaveLength(5);
    const again = await call('POST', '/api/v1/channels/email/domain/check', asA);
    expect(again.statusCode).toBe(429);
    expect(again.json().error).toBe('too_soon');
  });

  it('remove sends replies from the forwarding address again', async () => {
    const v = (await view()).settingsVersion;
    const res = await call('DELETE', '/api/v1/channels/email/domain', asA, { settingsVersion: v });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ domain: null, replyFrom: 'kaki-bakery@in.kaki.test' });
  });

  it('tenant B cannot check tenant A’s domain', async () => {
    const res = await call('POST', '/api/v1/channels/email/domain/check', asB);
    expect(res.statusCode).toBe(404);
  });
});

describe('deliveries and attachments in the thread (AC-7, AC-8, AC-10)', () => {
  let conversationId: string;
  let visitorMessageId: string;
  let failedId: string;
  let sentId: string;
  let cleanId: string;
  let rejectedId: string;

  beforeAll(async () => {
    const zdb = tdb.zone('visitor');
    const visitorId = randomUUID();
    await withTenant(zdb, TENANT_A, async (tx) => {
      const conv = await createConversation(tx, TENANT_A, visitorId, 'email');
      conversationId = conv.id;
      const { message } = await appendVisitorMessage(tx, {
        tenantId: TENANT_A,
        conversationId,
        visitorId,
        text: 'Do you deliver to Tampines?',
        clientMessageId: randomUUID(),
        scheduleTurn: false,
      });
      visitorMessageId = message.id;
      failedId = (await appendAgentReply(tx, {
        tenantId: TENANT_A,
        conversationId,
        inReplyTo: message.id,
        text: 'Yes, we do.',
      }))!.message.id;
      const second = await appendVisitorMessage(tx, {
        tenantId: TENANT_A,
        conversationId,
        visitorId,
        text: 'And on Sunday?',
        clientMessageId: randomUUID(),
        scheduleTurn: false,
      });
      sentId = (await appendAgentReply(tx, {
        tenantId: TENANT_A,
        conversationId,
        inReplyTo: second.message.id,
        text: 'Sunday too.',
      }))!.message.id;
    });
    await owner.query(
      `insert into email_threads (tenant_id, conversation_id, subject) values ($1, $2, 'Delivery to Tampines')`,
      [TENANT_A, conversationId],
    );
    await owner.query(
      `update message_deliveries set status = 'failed', failed_reason = 'timed_out' where message_id = $1`,
      [failedId],
    );
    await owner.query(
      `update message_deliveries set status = 'sent', sent_at = now() where message_id = $1`,
      [sentId],
    );
    const att = async (status: string, key: string | null, reason: string | null) =>
      (
        await owner.query<{ id: string }>(
          `insert into email_attachments (tenant_id, conversation_id, message_id, name, content_type, size, status, object_key, reject_reason)
           values ($1, $2, $3, $4, 'image/png', 1200, $5, $6, $7) returning id`,
          [TENANT_A, conversationId, visitorMessageId, `${status}.png`, status, key, reason],
        )
      ).rows[0]!.id;
    cleanId = await att('clean', `${TENANT_A}/clean.png`, null);
    rejectedId = await att('rejected', null, 'malware');
  });

  it('the thread shows each delivery and the attachments; the list has the subject', async () => {
    const res = await call('GET', `/api/v1/conversations/${conversationId}`, asA);
    expect(res.statusCode).toBe(200);
    const messages = res.json().messages as {
      id: string;
      delivery: unknown;
      attachments: unknown[];
    }[];
    const byId = new Map(messages.map((m) => [m.id, m]));
    expect(byId.get(visitorMessageId)).toMatchObject({ delivery: null });
    expect(byId.get(visitorMessageId)!.attachments).toEqual([
      expect.objectContaining({ id: cleanId, name: 'clean.png', status: 'clean', size: 1200 }),
      expect.objectContaining({ id: rejectedId, status: 'rejected', rejectReason: 'malware' }),
    ]);
    expect(byId.get(failedId)).toMatchObject({
      delivery: { status: 'failed', failedReason: 'timed_out', sentAt: null },
      attachments: [],
    });
    expect(byId.get(sentId)).toMatchObject({ delivery: { status: 'sent' } });
    const list = await call('GET', '/api/v1/conversations?view=open&channel=email', asA);
    expect(list.statusCode).toBe(200);
    expect(list.json().conversations).toEqual([
      expect.objectContaining({
        id: conversationId,
        channel: 'email',
        subject: 'Delivery to Tampines',
      }),
    ]);
    const widgetOnly = await call('GET', '/api/v1/conversations?view=open&channel=widget', asA);
    expect(
      widgetOnly.json().conversations.some((c: { id: string }) => c.id === conversationId),
    ).toBe(false);
  });

  it('retry: a failed delivery is 202 and sending again; a sent one is 409; tenant B 404', async () => {
    published.length = 0;
    const res = await call('POST', `/api/v1/messages/${failedId}/delivery/retry`, asAgent);
    expect(res.statusCode).toBe(202);
    const row = await owner.query(
      `select status, failed_reason, attempts from message_deliveries where message_id = $1`,
      [failedId],
    );
    expect(row.rows[0]).toEqual({ status: 'pending', failed_reason: null, attempts: 0 });
    const jobs = await owner.query(
      `select payload from outbox where topic = 'channel-send' and payload->>'messageId' = $1`,
      [failedId],
    );
    expect(jobs.rows.length).toBeGreaterThanOrEqual(2);
    expect(published).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'message',
          message: expect.objectContaining({
            id: failedId,
            delivery: expect.objectContaining({ status: 'sending' }),
          }),
        }),
      }),
    ]);
    const sent = await call('POST', `/api/v1/messages/${sentId}/delivery/retry`, asA);
    expect(sent.statusCode).toBe(409);
    expect(sent.json().error).toBe('not_failed');
    expect((await call('POST', `/api/v1/messages/${sentId}/delivery/retry`, asB)).statusCode).toBe(
      404,
    );
  });

  it('a clean attachment redirects to a 5-minute download; a rejected one and tenant B 404', async () => {
    const res = await call('GET', `/api/v1/attachments/${cleanId}`, asAgent);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://attachments.test/${TENANT_A}/clean.png?ttl=300`);
    expect(signed.at(-1)).toEqual({
      key: `${TENANT_A}/clean.png`,
      filename: 'clean.png',
      ttl: 300,
    });
    expect((await call('GET', `/api/v1/attachments/${rejectedId}`, asA)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/attachments/${cleanId}`, asB)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/attachments/not-a-uuid`, asA)).statusCode).toBe(404);
  });
});
