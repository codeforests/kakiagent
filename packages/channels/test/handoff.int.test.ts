/**
 * Handoff requests (CHN-07, UC-26 steps 1–2, 1a; FEAT-038 §5.2, D5, D6; AC-1, AC-2, AC-6).
 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Email, Mailer } from '@kaki/platform';
import {
  handoffOptions,
  HANDOFF_LIMITS,
  openHandoff,
  purgeHandoffLinks,
  requestHandoff,
  sendHandoffEmail,
  type HandoffRequestBody,
} from '../src/handoff/index.js';

const SECRET = 'h'.repeat(32);
let tdb: TestDatabase;
let owner: pg.Client;
const visitor = <T>(fn: (tx: Tx) => Promise<T>, t = TENANT_A) =>
  withTenant(tdb.zone('visitor'), t, fn);

async function conversation(t = TENANT_A, extra: { contactId?: string; visitorId?: string } = {}) {
  const visitorId = extra.visitorId ?? randomUUID();
  const { rows } = await owner.query<{ id: string }>(
    `insert into conversations (tenant_id, channel, visitor_id, contact_id) values ($1, 'widget', $2, $3) returning id`,
    [t, visitorId, extra.contactId ?? null],
  );
  return { id: rows[0]!.id, visitorId };
}
const ask = (
  c: { id: string; visitorId: string },
  body: HandoffRequestBody,
  t = TENANT_A,
  now?: Date,
) =>
  visitor(
    (tx) =>
      requestHandoff(tx, {
        tenantId: t,
        conversationId: c.id,
        visitorId: c.visitorId,
        body,
        secret: SECRET,
        ...(now ? { now } : {}),
      }),
    t,
  );
const setLive = async (kind: 'telegram' | 'email', state: 'live' | 'offline') =>
  owner.query(`update channel_connections set state = $2 where tenant_id = $1 and kind = $3`, [
    TENANT_A,
    state,
    kind,
  ]);

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  for (const kind of ['telegram', 'email'])
    await owner.query(
      `insert into channel_connections (tenant_id, kind, state, offline_mode, health)
       values ($1, $2, 'live', 'hidden', 'ok')`,
      [TENANT_A, kind],
    );
  await owner.query(
    `insert into email_settings (tenant_id, connection_id, forwarding_local)
     select $1, id, 'kaki-bakery' from channel_connections where tenant_id = $1 and kind = 'email'`,
    [TENANT_A],
  );
  await owner.query(
    `insert into telegram_settings (tenant_id, connection_id, bot_id, bot_username, bot_name, webhook_secret_hash)
     select $1, id, 4242, 'kaki_bakery_bot', 'Kaki Bakery', '\\x${'00'.repeat(32)}'
     from channel_connections where tenant_id = $1 and kind = 'telegram'`,
    [TENANT_A],
  );
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

beforeEach(async () => {
  await setLive('telegram', 'live');
  await setLive('email', 'live');
});

describe('requestHandoff (FEAT-038 §5.2)', () => {
  it('offers only live channels; Telegram also needs the bot (AC-1)', async () => {
    expect(await visitor((tx) => handoffOptions(tx, TENANT_A))).toEqual({
      telegram: true,
      email: true,
    });
    await setLive('telegram', 'offline');
    expect(await visitor((tx) => handoffOptions(tx, TENANT_A))).toEqual({
      telegram: false,
      email: true,
    });
    const c = await conversation();
    expect(await ask(c, { channel: 'telegram' })).toEqual({
      ok: false,
      code: 'channel_unavailable',
    });
    expect(await visitor((tx) => handoffOptions(tx, TENANT_B), TENANT_B)).toEqual({
      telegram: false,
      email: false,
    });
  });

  it('Telegram: a signed deep link for 30 minutes, a contact, an audit entry without PII (AC-2)', async () => {
    const c = await conversation();
    const now = new Date();
    const r = await ask(c, { channel: 'telegram' }, TENANT_A, now);
    if (!r.ok || r.channel !== 'telegram') throw new Error(JSON.stringify(r));
    const code = new URL(r.url).searchParams.get('start')!;
    expect(r.url.startsWith('https://t.me/kaki_bakery_bot?start=c-')).toBe(true);
    expect(openHandoff(SECRET, TENANT_A, code)).toEqual({ linkId: r.linkId, channel: 'telegram' });
    expect(r.expiresAt.getTime() - now.getTime()).toBe(30 * 60_000);
    const { rows } = await owner.query(
      `select l.contact_id, c.contact_id as conv_contact, l.email from handoff_links l
       join conversations c on c.tenant_id = l.tenant_id and c.id = l.conversation_id where l.id = $1`,
      [r.linkId],
    );
    expect(rows[0].contact_id).toBe(rows[0].conv_contact);
    expect(rows[0].email).toBeNull();
    const audit = await owner.query(
      `select payload::text as p from audit_entries where tenant_id = $1 and event_type = 'handoff.requested'
       and subject_refs @> array[$2]::text[]`,
      [TENANT_A, `conversation:${c.id}`],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].p).toContain('telegram');
    const outbox = await owner.query(
      `select 1 from outbox where tenant_id = $1 and payload->>'linkId' = $2`,
      [TENANT_A, r.linkId],
    );
    expect(outbox.rowCount).toBe(0);
  });

  it("email: the masked address, 24 hours, one outbox job with the link ID only; the typed email isn't an identity", async () => {
    const c = await conversation();
    const now = new Date();
    const r = await ask(c, { channel: 'email', email: ' Siti@Example.COM ' }, TENANT_A, now);
    if (!r.ok || r.channel !== 'email') throw new Error(JSON.stringify(r));
    expect(r.sentTo).toBe('s***@example.com');
    expect(r.expiresAt.getTime() - now.getTime()).toBe(24 * 3_600_000);
    const job = await owner.query(
      `select topic, payload from outbox where tenant_id = $1 and payload->>'linkId' = $2`,
      [TENANT_A, r.linkId],
    );
    expect(job.rows).toEqual([
      {
        topic: 'conversation-turns',
        payload: { kind: 'handoff_email', tenantId: TENANT_A, linkId: r.linkId },
      },
    ]);
    const link = await owner.query(`select email, contact_id from handoff_links where id = $1`, [
      r.linkId,
    ]);
    expect(link.rows[0].email).toBe('siti@example.com');
    const ids = await owner.query(`select 1 from contact_identities where contact_id = $1`, [
      link.rows[0].contact_id,
    ]);
    expect(ids.rowCount).toBe(0);
    expect(await ask(c, { channel: 'email', email: 'not-an-email' })).toEqual({
      ok: false,
      code: 'invalid_email',
    });
  });

  it("reuses the conversation's contact, else the same visitor's latest", async () => {
    const contact = (
      await owner.query<{ id: string }>(
        `insert into contacts (tenant_id, name) values ($1, 'Siti') returning id`,
        [TENANT_A],
      )
    ).rows[0]!.id;
    const first = await conversation(TENANT_A, { contactId: contact });
    const later = await conversation(TENANT_A, { visitorId: first.visitorId });
    const r = await ask(later, { channel: 'telegram' });
    if (!r.ok) throw new Error(r.code);
    const { rows } = await owner.query(
      `select l.contact_id, c.contact_id as conv from handoff_links l
       join conversations c on c.tenant_id = l.tenant_id and c.id = l.conversation_id where l.id = $1`,
      [r.linkId],
    );
    expect(rows[0]).toEqual({ contact_id: contact, conv: contact });
  });

  it('refuses a closed, moved or another visitor’s conversation', async () => {
    const closed = await conversation();
    await owner.query(
      `update conversations set status = 'closed', closed_at = now(), close_reason = 'visitor' where id = $1`,
      [closed.id],
    );
    expect(await ask(closed, { channel: 'telegram' })).toEqual({
      ok: false,
      code: 'conversation_closed',
    });
    const moved = await conversation();
    await owner.query(`update conversations set channel = 'telegram' where id = $1`, [moved.id]);
    expect(await ask(moved, { channel: 'email', email: 'a@b.co' })).toEqual({
      ok: false,
      code: 'moved',
      channel: 'telegram',
    });
    const other = await conversation();
    expect(await ask({ id: other.id, visitorId: randomUUID() }, { channel: 'telegram' })).toEqual({
      ok: false,
      code: 'not_found',
    });
    const b = await conversation(TENANT_B);
    expect(await ask(b, { channel: 'telegram' })).toEqual({ ok: false, code: 'not_found' });
  });

  it('rate limits: 5 an hour per conversation, 3 emails a day, 20 emails an hour per business (D6)', async () => {
    const c = await conversation();
    for (let i = 0; i < HANDOFF_LIMITS.perConversationHour; i++)
      expect((await ask(c, { channel: 'telegram' })).ok).toBe(true);
    expect(await ask(c, { channel: 'telegram' })).toEqual({ ok: false, code: 'rate_limited' });

    const e = await conversation();
    for (let i = 0; i < HANDOFF_LIMITS.emailPerConversationDay; i++) {
      const at = new Date(Date.now() - (i + 1) * 2 * 3_600_000);
      expect((await ask(e, { channel: 'email', email: 'a@b.co' }, TENANT_A, at)).ok).toBe(true);
    }
    expect(await ask(e, { channel: 'email', email: 'a@b.co' })).toEqual({
      ok: false,
      code: 'rate_limited',
    });
    expect((await ask(e, { channel: 'telegram' })).ok).toBe(true);

    await owner.query(`delete from handoff_links where tenant_id = $1`, [TENANT_A]);
    for (let i = 0; i < HANDOFF_LIMITS.emailPerTenantHour; i++)
      expect((await ask(await conversation(), { channel: 'email', email: 'a@b.co' })).ok).toBe(
        true,
      );
    expect(await ask(await conversation(), { channel: 'email', email: 'a@b.co' })).toEqual({
      ok: false,
      code: 'rate_limited',
    });
    expect((await ask(await conversation(), { channel: 'telegram' })).ok).toBe(true);
  });
});

describe('sendHandoffEmail (FEAT-038 §5.4; AC-6)', () => {
  const sent: Email[] = [];
  let fail: Error | null = null;
  const mailer: Mailer = {
    async send(e) {
      if (fail) throw fail;
      sent.push(e);
    },
    async close() {},
  };
  const deps = () => ({
    zdb: tdb.zone('visitor'),
    mailer,
    secret: SECRET,
    inboundDomain: 'in.kakiagent.test',
    apiUrl: 'https://api.kakiagent.test/',
    businessName: async () => 'Kaki Bakery',
  });
  // The rate-limit case above leaves the business at its hourly email limit.
  beforeAll(async () => {
    await owner.query(`delete from handoff_links`);
  });

  it('sends one mail from the reply address with the confirm link; a used or expired link is skipped', async () => {
    sent.length = 0;
    const c = await conversation();
    const r = await ask(c, { channel: 'email', email: 'siti@example.com' });
    if (!r.ok) throw new Error(r.code);
    expect(await sendHandoffEmail(deps(), { tenantId: TENANT_A, linkId: r.linkId })).toBe('sent');
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail).toMatchObject({
      from: '"Kaki Bakery" <kaki-bakery@in.kakiagent.test>',
      to: 'siti@example.com',
      subject: 'Continue your chat with Kaki Bakery',
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    const code = /https:\/\/api\.kakiagent\.test\/continue\/(e-[A-Za-z0-9_-]{43})/.exec(
      mail.text,
    )![1]!;
    expect(openHandoff(SECRET, TENANT_A, code)).toEqual({ linkId: r.linkId, channel: 'email' });
    expect(mail.text).toContain('It works for 24 hours');

    await owner.query(`update handoff_links set used_at = now() where id = $1`, [r.linkId]);
    expect(await sendHandoffEmail(deps(), { tenantId: TENANT_A, linkId: r.linkId })).toBe(
      'skipped',
    );
    expect(await sendHandoffEmail(deps(), { tenantId: TENANT_A, linkId: randomUUID() })).toBe(
      'skipped',
    );
    expect(sent).toHaveLength(1);
  });

  it('a permanent SMTP failure is dropped; a transient one throws for the retry', async () => {
    const c = await conversation();
    const r = await ask(c, { channel: 'email', email: 'siti@example.com' });
    if (!r.ok) throw new Error(r.code);
    fail = Object.assign(new Error('550 no such user'), { responseCode: 550 });
    expect(await sendHandoffEmail(deps(), { tenantId: TENANT_A, linkId: r.linkId })).toBe('failed');
    fail = Object.assign(new Error('421 try later'), { responseCode: 421 });
    await expect(
      sendHandoffEmail(deps(), { tenantId: TENANT_A, linkId: r.linkId }),
    ).rejects.toThrow();
    fail = null;
  });
});

describe('purgeHandoffLinks (FEAT-038 §5.9; AC-10)', () => {
  it('the scheduler zone deletes only links 7 days past expiry, across tenants', async () => {
    const make = async () => {
      const r = await ask(await conversation(), { channel: 'telegram' });
      if (!r.ok) throw new Error(r.code);
      return r.linkId;
    };
    const [old, recent, fresh] = [await make(), await make(), await make()];
    await owner.query(
      `update handoff_links set created_at = now() - interval '9 days', expires_at = now() - interval '8 days' where id = $1`,
      [old],
    );
    await owner.query(
      `update handoff_links set created_at = now() - interval '7 days', expires_at = now() - interval '6 days' where id = $1`,
      [recent],
    );
    const n = await purgeHandoffLinks(tdb.zone('outbox'));
    expect(n).toBeGreaterThanOrEqual(1);
    const left = await owner.query<{ id: string }>(
      `select id from handoff_links where id = any($1::uuid[])`,
      [[old, recent, fresh]],
    );
    expect(left.rows.map((r) => r.id).sort()).toEqual([recent, fresh].sort());
    await expect(purgeHandoffLinks(tdb.zone('visitor'))).rejects.toThrow();
  });
});
