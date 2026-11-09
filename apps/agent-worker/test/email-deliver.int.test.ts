/**
 * Outbound delivery on the email channel (NFR-17, NFR-18, CHN-12, UC-27 3c; FEAT-036 §5.3,
 * AC-2, AC-8, AC-9) against real Postgres with a fake mailer.
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { requestEscalation } from '@kaki/inbox';
import type { Email, Mailer } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deliverMessage,
  emailSender,
  escalateTimedOut,
  recordBounce,
  type DeliverDeps,
} from '@kaki/channels';

const DOMAIN = 'in.kaki.test';
const SES_DOMAIN = 'ap-southeast-1.amazonses.com';

let tdb: TestDatabase;
let owner: pg.Client;
let deps: DeliverDeps;
let connectionId: string;
const sent: Email[] = [];
let failNext: { responseCode?: number } | null = null;

const mailer: Mailer = {
  async send(email) {
    if (failNext) {
      const err = Object.assign(new Error('smtp'), failNext);
      failNext = null;
      throw err;
    }
    sent.push(email);
    return { providerId: `ses-${randomUUID()}`, response: '250 Ok' };
  },
  async close() {},
};

/** An email conversation with its contact and thread, as receive leaves it. */
async function thread() {
  const contact = (
    await owner.query<{ id: string }>(
      `insert into contacts (tenant_id, name, email) values ($1, 'Tan Mei', $2) returning id`,
      [TENANT_A, `mei-${randomUUID().slice(0, 8)}@example.test`],
    )
  ).rows[0]!.id;
  const conv = (
    await owner.query<{ id: string }>(
      `insert into conversations (tenant_id, channel, visitor_id, contact_id) values ($1, 'email', gen_random_uuid(), $2) returning id`,
      [TENANT_A, contact],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into email_threads (tenant_id, conversation_id, subject, "references", last_inbound_id)
     values ($1, $2, 'Birthday cake', array['<root@mail.test>', '<in-2@mail.test>'], '<in-2@mail.test>')`,
    [TENANT_A, conv],
  );
  return conv;
}

async function message(
  conv: string,
  author: 'agent' | 'staff' | 'system',
  body = 'Yes, we deliver.',
  notice: [string, string] | null = null,
) {
  const { rows } = await owner.query<{ id: string }>(
    `insert into messages (tenant_id, conversation_id, author, body, notice, notice_kind) values ($1, $2, $3, $4, $5, $6) returning id`,
    [TENANT_A, conv, author, body, notice?.[1] ?? null, notice?.[0] ?? null],
  );
  return rows[0]!.id;
}

const delivery = async (messageId: string) =>
  (
    await owner.query(
      `select status, failed_reason, attempts, next_attempt_at, external_id from message_deliveries where message_id = $1`,
      [messageId],
    )
  ).rows[0];
const escalations = async (conv: string) =>
  (await owner.query(`select source from escalations where conversation_id = $1`, [conv])).rows.map(
    (r) => r.source,
  );

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  connectionId = (
    await owner.query<{ id: string }>(
      `insert into channel_connections (tenant_id, kind, state, offline_mode, health, ai_reply_cap)
       values ($1, 'email', 'live', 'hidden', 'ok', 10) returning id`,
      [TENANT_A],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into email_settings (tenant_id, connection_id, forwarding_local) values ($1, $2, 'kaki-bakery')`,
    [TENANT_A, connectionId],
  );
  deps = {
    zdb: tdb.zone('visitor'),
    senders: {
      email: emailSender({ mailer, inboundDomain: DOMAIN, sesMessageIdDomain: SES_DOMAIN }),
    },
    footer: async () => ({ businessName: 'Kaki Bakery', privacyUrl: null }),
    escalate: async (tx, tenantId, conversationId, source) => {
      await requestEscalation(tx, { tenantId, conversationId, source, hours: null });
    },
  };
});
beforeEach(() => {
  sent.length = 0;
  failNext = null;
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const deliver = (messageId: string) => deliverMessage(deps, { tenantId: TENANT_A, messageId });

describe('deliverMessage on email (FEAT-036 §5.3)', () => {
  it('threads an AI reply from the forwarding address, once; a staff reply has no Auto-Submitted', async () => {
    const conv = await thread();
    const ai = await message(conv, 'agent');
    const r = await deliver(ai);
    expect(r.outcome).toBe('sent');
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.from).toBe(`"Kaki Bakery" <kaki-bakery@${DOMAIN}>`);
    expect(mail.subject).toBe('Re: Birthday cake');
    expect(mail.headers).toMatchObject({
      'In-Reply-To': '<in-2@mail.test>',
      References: '<root@mail.test> <in-2@mail.test>',
      'Auto-Submitted': 'auto-replied',
      'X-Kaki-Message': ai,
    });
    expect(mail.messageId).toMatch(new RegExp(`^<[0-9a-f-]{36}@${DOMAIN.replace(/\./g, '\\.')}>$`));
    expect(mail.text).toContain('Yes, we deliver.');
    expect(await delivery(ai)).toMatchObject({ status: 'sent', attempts: 1 });
    const outs = await owner.query(
      `select rfc_message_id from email_messages where message_id = $1 and direction = 'out' order by 1`,
      [ai],
    );
    expect(outs.rows.map((o) => o.rfc_message_id)).toEqual(
      expect.arrayContaining([
        mail.messageId,
        expect.stringMatching(/^<ses-.+@ap-southeast-1\.amazonses\.com>$/),
      ]),
    );
    const t = await owner.query(
      `select "references" from email_threads where conversation_id = $1`,
      [conv],
    );
    expect(t.rows[0].references.at(-1)).toBe(mail.messageId);

    // A second job for the same message sends nothing.
    expect((await deliver(ai)).outcome).toBe('already_done');
    expect(sent).toHaveLength(1);

    const staff = await message(conv, 'staff', 'Hi Mei, Ah Kow here.');
    expect((await deliver(staff)).outcome).toBe('sent');
    expect(sent[1]!.headers).not.toHaveProperty('Auto-Submitted');
    expect(sent[1]!.headers!.References).toContain(mail.messageId);
  });

  it("doesn't send a staff_joined notice but marks it delivered (AC-9)", async () => {
    const conv = await thread();
    const notice = await message(conv, 'system', 'Ah Kow joined', [
      'staff_joined',
      'Ah Kow joined',
    ]);
    expect((await deliver(notice)).outcome).toBe('not_sent');
    expect(sent).toHaveLength(0);
    expect(await delivery(notice)).toMatchObject({ status: 'sent', external_id: null });
  });

  it('a transient failure backs off; a 535 also degrades the channel at once', async () => {
    const conv = await thread();
    const id = await message(conv, 'agent');
    failNext = { responseCode: 421 };
    const before = Date.now();
    expect((await deliver(id)).outcome).toBe('retry');
    const row = await delivery(id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(before + 60_000);

    failNext = { responseCode: 535 };
    expect((await deliver(id)).outcome).toBe('retry');
    const health = await owner.query(
      `select health, health_reason from channel_connections where id = $1`,
      [connectionId],
    );
    expect(health.rows[0]).toEqual({ health: 'degraded', health_reason: 'send_rejected' });
    const audits = await owner.query(
      `select count(*)::int as n from audit_entries where tenant_id = $1 and event_type = 'channel.degraded'`,
      [TENANT_A],
    );
    expect(audits.rows[0].n).toBe(1);
    await owner.query(
      `update channel_connections set health = 'ok', health_reason = null, degraded_since = null where id = $1`,
      [connectionId],
    );
    expect((await deliver(id)).outcome).toBe('sent');
    expect(await delivery(id)).toMatchObject({ status: 'sent', attempts: 3 });
  });

  it('a permanent rejection fails the delivery and escalates', async () => {
    const conv = await thread();
    const id = await message(conv, 'agent');
    failNext = { responseCode: 554 };
    expect((await deliver(id)).outcome).toBe('failed');
    expect(await delivery(id)).toMatchObject({ status: 'failed', failed_reason: 'rejected' });
    expect(await escalations(conv)).toEqual(['delivery_failed']);
  });

  it('24 hours of retries time out once, with one escalation; Retry sends it (AC-8)', async () => {
    const conv = await thread();
    const id = await message(conv, 'agent');
    await owner.query(
      `update message_deliveries set first_attempt_at = now() - interval '25 hours', attempts = 9 where message_id = $1`,
      [id],
    );
    const swept = await withTenant(tdb.zone('outbox'), TENANT_A, async (tx) =>
      tx.execute(sql`select * from channel_deliveries_due()`),
    );
    expect(swept.rows.filter((r) => r.message_id === id)).toEqual([
      expect.objectContaining({ outcome: 'timed_out' }),
    ]);
    expect(await delivery(id)).toMatchObject({ status: 'failed', failed_reason: 'timed_out' });
    for (let i = 0; i < 2; i++)
      await escalateTimedOut(deps, { tenantId: TENANT_A, conversationId: conv, messageId: id });
    expect(await escalations(conv)).toEqual(['delivery_failed']);
    expect((await deliver(id)).outcome).toBe('already_done');

    // What the Retry route does (T9): back to pending, then the job.
    await owner.query(
      `update message_deliveries set status = 'pending', failed_reason = null, attempts = 0, first_attempt_at = now() where message_id = $1`,
      [id],
    );
    expect((await deliver(id)).outcome).toBe('sent');
  });

  it('a bounce of a sent reply marks it bounced and escalates once', async () => {
    const conv = await thread();
    const id = await message(conv, 'agent');
    await deliver(id);
    const ses = (
      await owner.query(
        `select rfc_message_id from email_messages where message_id = $1 and rfc_message_id like '%amazonses.com>'`,
        [id],
      )
    ).rows[0].rfc_message_id as string;
    expect(await recordBounce(deps, ses)).toMatchObject({ tenantId: TENANT_A });
    expect(await delivery(id)).toMatchObject({ status: 'failed', failed_reason: 'bounced' });
    expect(await recordBounce(deps, ses)).toBeNull();
    expect(await escalations(conv)).toEqual(['delivery_failed']);
    expect(await recordBounce(deps, '<unknown@x>')).toBeNull();
  });

  it('replies come from the custom address only while it is verified (D4)', async () => {
    const conv = await thread();
    await owner.query(
      `update email_settings set domain_address = 'hello@kakibakery.test', domain = 'kakibakery.test', domain_state = 'pending' where tenant_id = $1`,
      [TENANT_A],
    );
    await deliver(await message(conv, 'agent'));
    expect(sent.at(-1)!.from).toContain(`kaki-bakery@${DOMAIN}`);
    await owner.query(`update email_settings set domain_state = 'verified' where tenant_id = $1`, [
      TENANT_A,
    ]);
    await deliver(await message(conv, 'agent'));
    expect(sent.at(-1)!.from).toBe('"Kaki Bakery" <hello@kakibakery.test>');
    await owner.query(`update email_settings set domain_state = 'failing' where tenant_id = $1`, [
      TENANT_A,
    ]);
    await deliver(await message(conv, 'agent'));
    expect(sent.at(-1)!.from).toContain(`kaki-bakery@${DOMAIN}`);
    await owner.query(
      `update email_settings set domain_address = null, domain = null, domain_state = null where tenant_id = $1`,
      [TENANT_A],
    );
  });
});
