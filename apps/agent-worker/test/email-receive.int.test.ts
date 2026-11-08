/**
 * Inbound email (CHN-04, CHN-10, UC-27 1–2a; FEAT-036 §5.2, AC-2–AC-4, AC-10) against real
 * Postgres, with a fake S3 and SES-shaped SNS envelopes.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import * as inbox from '@kaki/inbox';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receiveEmail, type MailObjectStore, type ReceiveDeps } from '@kaki/channels';

const TOPIC = 'arn:aws:sns:ap-southeast-1:000000000000:email-inbound';
const BUCKET = 'kaki-local-inbound-mail';
const DOMAIN = 'in.kaki.test';

let tdb: TestDatabase;
let owner: pg.Client;
let deps: ReceiveDeps;
const objects = new Map<string, Uint8Array>();
const quarantine = new Map<string, Uint8Array>();
const deleted: string[] = [];
let clock = new Date();

const store: MailObjectStore = {
  async getRaw(bucket, key) {
    const o = objects.get(`${bucket}/${key}`);
    if (!o) throw new Error(`no object ${key}`);
    return o;
  },
  async deleteRaw(bucket, key) {
    deleted.push(key);
    objects.delete(`${bucket}/${key}`);
  },
  async putQuarantine(key, bytes) {
    quarantine.set(key, bytes);
  },
};

/** A fixture with its Message-IDs made unique to the test (`<x@…>` → `<x-tag@…>`). */
const mail = (name: string, tag: string) =>
  readFileSync(
    new URL(`../../../packages/channels/test/fixtures/email/${name}.eml`, import.meta.url),
    'utf8',
  ).replace(/^(Message-ID|In-Reply-To|References):.*$/gim, (line) =>
    line.replace(/<([^<>@\s]+)@/g, `<$1-${tag}@`),
  );

function envelope(
  raw: string,
  opts: { local?: string; topic?: string; verdicts?: Record<string, string>; sesId?: string } = {},
) {
  const sesId = opts.sesId ?? randomUUID();
  const key = `inbound-mail/${sesId}`;
  objects.set(`${BUCKET}/${key}`, Buffer.from(raw));
  const v = { spam: 'PASS', virus: 'PASS', dmarc: 'PASS', ...opts.verdicts };
  return {
    sesId,
    body: {
      Type: 'Notification',
      MessageId: randomUUID(),
      TopicArn: opts.topic ?? TOPIC,
      Message: JSON.stringify({
        notificationType: 'Received',
        mail: { messageId: sesId },
        receipt: {
          recipients: [`${opts.local ?? 'kaki-bakery'}@${DOMAIN}`],
          spamVerdict: { status: v.spam },
          virusVerdict: { status: v.virus },
          dmarcVerdict: { status: v.dmarc },
          action: { type: 'S3', bucketName: BUCKET, objectKey: key },
        },
      }),
    },
  };
}

async function receive(raw: string, opts: Parameters<typeof envelope>[1] = {}) {
  const e = envelope(raw, opts);
  return { ...(await receiveEmail(deps, e.body)), envelope: e };
}

const accepted = (r: Awaited<ReturnType<typeof receive>>) => {
  if (!('recipients' in r)) throw new Error(`not received: ${JSON.stringify(r)}`);
  const one = r.recipients[0]!;
  if (one.outcome !== 'accepted') throw new Error(`not accepted: ${one.outcome}`);
  return one;
};

const count = async (sql: string, params: unknown[] = []) =>
  Number((await owner.query(`select count(*)::int as n from (${sql}) x`, params)).rows[0].n);

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  for (const [t, local] of [
    [TENANT_A, 'kaki-bakery'],
    [TENANT_B, 'second-tenant'],
  ] as const) {
    const c = await owner.query<{ id: string }>(
      `insert into channel_connections (tenant_id, kind, state, offline_mode, health, ai_reply_cap)
       values ($1, 'email', 'live', 'hidden', 'ok', 10) returning id`,
      [t],
    );
    await owner.query(
      `insert into email_settings (tenant_id, connection_id, forwarding_local) values ($1, $2, $3)`,
      [t, c.rows[0]!.id, local],
    );
  }
  deps = {
    zdb: tdb.zone('visitor'),
    store,
    inbox,
    config: { topicArn: TOPIC, inboundBucket: BUCKET, inboundDomain: DOMAIN },
    now: () => clock,
  };
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('receiveEmail (FEAT-036 §5.2)', () => {
  it('a first mail creates the email conversation, its contact and the turn; NRIC is masked', async () => {
    clock = new Date();
    const r = await receive(mail('first', 'a1'));
    const one = accepted(r);
    expect(one.newConversation).toBe(true);
    expect(one.conversation.channel).toBe('email');
    expect(one.message.body).toContain('do you deliver to Tampines?');
    expect(one.message.body).not.toContain('S1234567D');
    const contact = await owner.query(
      `select k.email, k.name from conversations c join contacts k on k.tenant_id = c.tenant_id and k.id = c.contact_id where c.id = $1`,
      [one.conversation.id],
    );
    expect(contact.rows).toEqual([{ email: 'tan.mei@gmail.com', name: 'Tan Mei' }]);
    const turns = await owner.query(
      `select payload->>'messageId' as id from outbox where topic = 'conversation-turns' and group_key = $1`,
      [one.conversation.id],
    );
    expect(turns.rows).toEqual([{ id: one.message.id }]);
    const thread = await owner.query(
      `select subject, "references", last_inbound_id from email_threads where conversation_id = $1`,
      [one.conversation.id],
    );
    expect(thread.rows).toEqual([
      {
        subject: 'Birthday cake for Saturday',
        references: ['<CAF1first-a1@mail.gmail.com>'],
        last_inbound_id: '<CAF1first-a1@mail.gmail.com>',
      },
    ]);
    expect(deleted).toContain(`inbound-mail/${r.envelope.sesId}`);
    const settings = await owner.query(
      `select last_received_at from email_settings where tenant_id = $1`,
      [TENANT_A],
    );
    expect(settings.rows[0].last_received_at).not.toBeNull();

    // A redelivery of the same SES notification creates nothing.
    const before = await count(`select 1 from messages where tenant_id = $1`, [TENANT_A]);
    const again = await receiveEmail(
      deps,
      envelope(mail('first', 'a1'), { sesId: r.envelope.sesId }).body,
    );
    expect(again).toMatchObject({ recipients: [{ outcome: 'duplicate' }] });
    expect(await count(`select 1 from messages where tenant_id = $1`, [TENANT_A])).toBe(before);
  });

  it('Gmail and Outlook replies thread (full and trimmed References); a same-subject mail is new', async () => {
    clock = new Date();
    const first = accepted(await receive(mail('first', 'b1')));
    const gmail = accepted(await receive(mail('gmail-reply', 'b1')));
    expect(gmail.conversation.id).toBe(first.conversation.id);
    expect(gmail.newConversation).toBe(false);
    expect(gmail.message.body).toBe('Great, 1kg please.');

    // Outlook trims References to our reply only: our `out` row threads it.
    const other = accepted(await receive(mail('same-subject', 'b2')));
    await owner.query(
      `insert into email_messages (tenant_id, rfc_message_id, conversation_id, direction) values ($1, '<out-2-b3@in.kaki.test>', $2, 'out')`,
      [TENANT_A, other.conversation.id],
    );
    const outlook = accepted(await receive(mail('outlook-reply', 'b3')));
    expect(outlook.conversation.id).toBe(other.conversation.id);
    expect(outlook.message.body).toBe('Can I collect at 3pm instead?');

    const same = accepted(await receive(mail('same-subject', 'b4')));
    expect(same.newConversation).toBe(true);
    expect(same.conversation.id).not.toBe(first.conversation.id);
  });

  it('a reply within 7 days of close reopens; 8 days after, a new conversation on the same contact', async () => {
    clock = new Date();
    const first = accepted(await receive(mail('first', 'c1')));
    const close = (days: number) =>
      owner.query(
        `update conversations set status = 'closed', close_reason = 'staff', closed_at = now() - $2::interval, version = version + 1 where id = $1`,
        [first.conversation.id, `${days} days`],
      );
    await close(2);
    const reopened = accepted(await receive(mail('gmail-reply', 'c1')));
    expect(reopened.conversation.id).toBe(first.conversation.id);
    expect(reopened.conversation.status).toBe('ai');

    await close(8);
    const later = mail('gmail-reply', 'c1').replace('<CAF2reply-c1@', '<CAF2later-c1@');
    const fresh = accepted(await receive(later));
    expect(fresh.newConversation).toBe(true);
    expect(fresh.conversation.id).not.toBe(first.conversation.id);
    const contacts = await owner.query(
      `select distinct contact_id from conversations where id = any($1)`,
      [[first.conversation.id, fresh.conversation.id]],
    );
    expect(contacts.rows).toHaveLength(1);
  });

  it('each ignored kind writes only an ignored event, by reason', async () => {
    clock = new Date();
    const cases: [string, Parameters<typeof envelope>[1], string][] = [
      ['gmail-vacation', {}, 'auto_reply'],
      ['outlook-oof', {}, 'auto_reply'],
      ['dsn', {}, 'bounce'],
      ['list-post', {}, 'list'],
      ['newsletter', {}, 'bulk'],
      ['first', { verdicts: { spam: 'FAIL' } }, 'spam'],
      ['first', { verdicts: { virus: 'FAIL' } }, 'unsafe'],
    ];
    for (const [i, [name, opts, reason]] of cases.entries()) {
      const msgs = await count(`select 1 from messages`);
      const convs = await count(`select 1 from conversations`);
      const r = await receive(mail(name, `d${i}`), opts);
      expect(r, name).toMatchObject({ recipients: [{ outcome: 'ignored', reason }] });
      expect(await count(`select 1 from messages`), name).toBe(msgs);
      expect(await count(`select 1 from conversations`), name).toBe(convs);
      const ev = await owner.query(
        `select outcome, ignore_reason from inbound_events where provider_event_id = $1`,
        [r.envelope.sesId],
      );
      expect(ev.rows, name).toEqual([{ outcome: 'ignored', ignore_reason: reason }]);
    }
    // An echo of our own reply (its Message-ID is an `out` row).
    const conv = accepted(await receive(mail('first', 'd9')));
    await owner.query(
      `insert into email_messages (tenant_id, rfc_message_id, conversation_id, direction) values ($1, '<echo-d9@in.kaki.test>', $2, 'out')`,
      [TENANT_A, conv.conversation.id],
    );
    const echo = mail('first', 'd9').replace(
      '<CAF1first-d9@mail.gmail.com>',
      '<echo-d9@in.kaki.test>',
    );
    expect(await receive(echo)).toMatchObject({
      recipients: [{ outcome: 'ignored', reason: 'echo' }],
    });
  });

  it('the 21st mail in a thread within an hour is a loop', async () => {
    clock = new Date();
    const first = accepted(await receive(mail('first', 'e0')));
    for (let i = 1; i < 20; i++) {
      const raw = mail('gmail-reply', 'e0').replace('<CAF2reply-e0@', `<CAF2reply${i}-e0@`);
      accepted(await receive(raw));
    }
    const raw = mail('gmail-reply', 'e0').replace('<CAF2reply-e0@', '<CAF2reply21-e0@');
    expect(await receive(raw)).toMatchObject({
      recipients: [{ outcome: 'ignored', reason: 'loop' }],
    });
    expect(
      await count(`select 1 from messages where conversation_id = $1`, [first.conversation.id]),
    ).toBe(20);
  });

  it("Gmail's forwarding confirmation fills the settings and opens no conversation (D5)", async () => {
    const convs = await count(`select 1 from conversations where tenant_id = $1`, [TENANT_B]);
    const r = await receive(mail('gmail-confirmation', 'f1'), { local: 'second-tenant' });
    expect(r).toMatchObject({ recipients: [{ outcome: 'confirmation', tenantId: TENANT_B }] });
    const s = await owner.query(
      `select forwarding_confirmation from email_settings where tenant_id = $1`,
      [TENANT_B],
    );
    expect(s.rows[0].forwarding_confirmation).toMatchObject({
      code: '482915736',
      link: 'https://mail-settings.google.com/mail/vf-%5BANGjdJ8abc%5D-xyz',
    });
    expect(await count(`select 1 from conversations where tenant_id = $1`, [TENANT_B])).toBe(convs);
  });

  it('a wrong topic ARN or an unknown local part writes nothing', async () => {
    const events = await count(`select 1 from inbound_events`);
    expect(await receive(mail('first', 'g1'), { topic: 'arn:aws:sns:x:1:other' })).toMatchObject({
      rejected: 'bad_signature',
    });
    expect(await receive(mail('first', 'g2'), { local: 'nobody' })).toMatchObject({
      recipients: [{ outcome: 'unknown_connection' }],
    });
    expect(await count(`select 1 from inbound_events`)).toBe(events);
  });

  it('attachments: images and PDFs go to quarantine with a scan job; a disguised executable is rejected', async () => {
    clock = new Date();
    const one = accepted(await receive(mail('attachments', 'h1')));
    const rows = await owner.query(
      `select id, name, content_type, status, reject_reason, object_key from email_attachments where message_id = $1 order by name`,
      [one.message.id],
    );
    expect(rows.rows.map((r) => [r.name, r.content_type, r.status, r.reject_reason])).toEqual([
      ['design.png', 'image/png', 'scanning', null],
      ['invoice.pdf', null, 'rejected', 'unsupported_type'],
      ['order.pdf', 'application/pdf', 'scanning', null],
    ]);
    const scanning = rows.rows.filter((r) => r.status === 'scanning');
    for (const a of scanning) expect(quarantine.has(`email/${TENANT_A}/${a.id}`)).toBe(true);
    const rejected = rows.rows.find((r) => r.status === 'rejected');
    expect(quarantine.has(`email/${TENANT_A}/${rejected.id}`)).toBe(false);
    const jobs = await owner.query(
      `select payload->>'attachmentId' as id from outbox where topic = 'ingest' and payload->>'kind' = 'attachment_scan' and payload->>'attachmentId' = any($1)`,
      [rows.rows.map((r) => r.id)],
    );
    expect(jobs.rows.map((j) => j.id).sort()).toEqual(scanning.map((a) => a.id).sort());
  });

  it('an 11 MB PDF is rejected as too_large, never quarantined, and has no scan job (AC-7)', async () => {
    clock = new Date();
    const big = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(11 * 1024 * 1024, 0x20),
      Buffer.from('\n%%EOF\n'),
    ]);
    const b64 = big.toString('base64').replace(/.{76}/g, '$&\r\n');
    const raw = mail('attachments', 'h3').replace(
      /--att\r?\nContent-Type: image\/png[\s\S]*--att--/,
      `--att\r\nContent-Type: application/pdf; name="big.pdf"\r\nContent-Disposition: attachment; filename="big.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--att--`,
    );
    const one = accepted(await receive(raw));
    const rows = await owner.query(
      `select id, name, status, reject_reason from email_attachments where message_id = $1`,
      [one.message.id],
    );
    expect(rows.rows.map((r) => [r.name, r.status, r.reject_reason])).toEqual([
      ['big.pdf', 'rejected', 'too_large'],
    ]);
    expect(quarantine.has(`email/${TENANT_A}/${rows.rows[0].id}`)).toBe(false);
    expect(
      await count(`select 1 from outbox where topic = 'ingest' and payload->>'attachmentId' = $1`, [
        rows.rows[0].id,
      ]),
    ).toBe(0);
  });

  it('an attachment-only mail is stored as (no text) and schedules no turn', async () => {
    clock = new Date();
    const raw = mail('attachments', 'h2').replace('Here is the design and the order form.', '');
    const one = accepted(await receive(raw));
    expect(one.message.body).toBe('(no text)');
    expect(
      await count(
        `select 1 from outbox where topic = 'conversation-turns' and payload->>'messageId' = $1`,
        [one.message.id],
      ),
    ).toBe(0);
  });

  it('no new row holds the address or subject outside contacts and email_threads (ADR-015)', async () => {
    for (const table of [
      'inbound_events',
      'email_messages',
      'message_deliveries',
      'email_attachments',
      'audit_entries',
      'conversations',
      'outbox',
    ]) {
      const hits = await count(
        `select 1 from ${table} t where t::text ilike '%tan.mei@gmail.com%' or t::text ilike '%Birthday cake%'`,
      );
      expect(hits, table).toBe(0);
    }
  });
});
