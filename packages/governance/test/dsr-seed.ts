/**
 * Seeds one data subject across every `find+erase` store (FEAT-061 T4, T5), straight through
 * the owner connection: a contact with a merged-in duplicate, a widget chat with memory,
 * tracking, consent, lead, approval, escalation, suggestion and handoff link; an email chat with
 * an attachment; a Telegram chat; audit PII; a fact and a staged fact quoting the email; and an
 * anonymous chat that mentions the phone. Tenant B gets a contact with the same email.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';

export const SUBJECT = {
  email: 'mei.tan@example.com',
  phone: '+6591234567',
  telegramId: '700123456',
};

export interface Seeded {
  contact: string;
  merged: string;
  widgetConv: string;
  emailConv: string;
  telegramConv: string;
  mentionConv: string;
  otherConv: string;
  fact: string;
  staged: string;
  attachmentKey: string;
  visitor: string;
  lead: string;
  otherContact: string;
}

export async function seedSubject(owner: pg.Client, t: string): Promise<Seeded> {
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const id = () => randomUUID();
  const s: Seeded = {
    contact: id(),
    merged: id(),
    widgetConv: id(),
    emailConv: id(),
    telegramConv: id(),
    mentionConv: id(),
    otherConv: id(),
    fact: id(),
    staged: id(),
    attachmentKey: `attachments/${t}/${id()}`,
    visitor: id(),
    lead: id(),
    otherContact: id(),
  };
  const user = (await q(`select user_id from memberships where tenant_id = $1 limit 1`, [t]))[0]!
    .user_id as string;
  const conn = (
    await q(`select id from channel_connections where tenant_id = $1 and kind = 'widget'`, [t])
  )[0]!.id as string;
  const wording = id();
  await q(
    `insert into wording_versions (tenant_id, id, kind, seq, content) values ($1, $2, 'marketing_consent', 1, '{}')
     on conflict do nothing`,
    [t, wording],
  );

  await q(
    `insert into contacts (tenant_id, id, name, email, phone, telegram_id) values
       ($1, $2, 'Mei Tan', $4, $5, $6), ($1, $3, 'Mei', $4, null, null)`,
    [t, s.contact, s.merged, SUBJECT.email, SUBJECT.phone, SUBJECT.telegramId],
  );
  await q(`update contacts set merged_into = $2, merged_at = now() where id = $1`, [
    s.merged,
    s.contact,
  ]);
  await q(
    `insert into contacts (tenant_id, id, name, email) values ($1, $2, 'Someone Else', 'else@example.com')`,
    [t, s.otherContact],
  );
  await q(
    `insert into contact_identities (tenant_id, contact_id, kind, value, source, verified_at) values
       ($1, $2, 'email', $3, 'email', now()), ($1, $2, 'phone', $4, 'lead_form', null),
       ($1, $2, 'telegram', $5, 'telegram', now())`,
    [t, s.contact, SUBJECT.email, SUBJECT.phone, SUBJECT.telegramId],
  );
  await q(
    `insert into contact_merges (tenant_id, survivor_id, merged_id, automatic, moved)
     values ($1, $2, $3, false, '{}')`,
    [t, s.contact, s.merged],
  );

  await q(
    `insert into conversations (tenant_id, id, channel, visitor_id, contact_id) values
       ($1, $2, 'widget', $6, $7), ($1, $3, 'email', gen_random_uuid(), $8),
       ($1, $4, 'telegram', gen_random_uuid(), $7), ($1, $5, 'widget', gen_random_uuid(), null),
       ($1, $9, 'widget', gen_random_uuid(), $10)`,
    [
      t,
      s.widgetConv,
      s.emailConv,
      s.telegramConv,
      s.mentionConv,
      s.visitor,
      s.contact,
      s.merged,
      s.otherConv,
      s.otherContact,
    ],
  );
  const msg = async (conv: string, author: string, body: string) =>
    (
      await q(
        `insert into messages (tenant_id, conversation_id, author, body) values ($1, $2, $3, $4) returning id`,
        [t, conv, author, body],
      )
    )[0]!.id as string;
  const m1 = await msg(s.widgetConv, 'visitor', 'Hi, I want a birthday cake');
  await msg(s.widgetConv, 'agent', 'Sure, what size?');
  const em = await msg(s.emailConv, 'visitor', 'Order form attached');
  await msg(s.telegramConv, 'visitor', 'Hello from Telegram');
  await msg(s.mentionConv, 'visitor', 'Please call my wife at 9123 4567 about the order');
  await msg(s.otherConv, 'visitor', 'Unrelated question');

  await q(
    `insert into email_attachments (tenant_id, conversation_id, message_id, name, size, status, object_key)
     values ($1, $2, $3, 'order.pdf', 1200, 'clean', $4)`,
    [t, s.emailConv, em, s.attachmentKey],
  );
  await q(
    `insert into email_messages (tenant_id, rfc_message_id, conversation_id, message_id, direction)
     values ($1, $2, $3, $4, 'in')`,
    [t, `<${id()}@example.com>`, s.emailConv, em],
  );
  await q(
    `insert into email_threads (tenant_id, conversation_id, subject) values ($1, $2, 'Cake order')`,
    [t, s.emailConv],
  );
  await q(
    `insert into message_deliveries (tenant_id, message_id, conversation_id, connection_id) values ($1, $2, $3, $4)
     on conflict do nothing`,
    [t, em, s.emailConv, conn],
  );
  await q(
    `insert into telegram_chats (tenant_id, chat_id, bot_id, contact_id, conversation_id)
     values ($1, $2, 1, $3, $4)`,
    [t, Math.floor(Math.random() * 1e9), s.contact, s.telegramConv],
  );

  const consent = id();
  await q(
    `insert into consents (tenant_id, id, contact_id, conversation_id, purpose, decision, wording_id, channel)
     values ($1, $2, $3, $4, 'marketing', 'agreed', $5, 'widget')`,
    [t, consent, s.contact, s.widgetConv, wording],
  );
  await q(
    `insert into leads (tenant_id, id, contact_id, consent_id, conversation_id, need) values ($1, $2, $3, $4, $5, 'Cake')`,
    [t, s.lead, s.contact, consent, s.widgetConv],
  );
  await q(
    `insert into approvals (tenant_id, conversation_id, kind, request, draft, prices, sla_due_at, expires_at)
     values ($1, $2, 'quote', '{}', '{}', '[]', now() + interval '1 hour', now() + interval '1 day')`,
    [t, s.widgetConv],
  );
  await q(
    `insert into escalations (tenant_id, conversation_id, source, urgent, after_hours) values ($1, $2, 'visitor_asked', false, false)`,
    [t, s.widgetConv],
  );
  await q(
    `insert into suggestions (tenant_id, conversation_id, for_message_id, requested_by, outcome, language)
     values ($1, $2, $3, $4, 'no_checked_answer', 'en')`,
    [t, s.widgetConv, m1, user],
  );
  await q(
    `insert into conversation_owners (tenant_id, conversation_id, user_id) values ($1, $2, $3)`,
    [t, s.widgetConv, user],
  );
  await q(
    `insert into conversation_summaries (tenant_id, conversation_id, upto_seq, memory, messages_folded)
     values ($1, $2, 1, '{"facts":[]}', 1)`,
    [t, s.widgetConv],
  );
  await q(
    `insert into handoff_links (tenant_id, conversation_id, contact_id, channel, expires_at)
     values ($1, $2, $3, 'telegram', now() + interval '1 day')`,
    [t, s.widgetConv, s.contact],
  );
  await q(
    `insert into visitor_events (tenant_id, id, visitor_id, session_id, path, consented, viewed_at)
     values ($1, gen_random_uuid(), $2, gen_random_uuid(), '/cakes', true, now())`,
    [t, s.visitor],
  );
  await q(
    `insert into visitor_tracking_choices (tenant_id, visitor_id, choice, wording) values ($1, $2, 'accepted', 'v1')`,
    [t, s.visitor],
  );
  await q(
    `insert into corrections (tenant_id, source_type, proposed_by, conversation_ref, proposed_change)
     values ($1, 'thumbs_down', 'system', $2, '{"question":"cake"}')`,
    [t, s.widgetConv],
  );
  await q(
    `insert into audit_pii (tenant_id, contact_id, salt, data) values ($1, $2, $3, '{"email":"x"}')`,
    [t, s.contact, randomBytes(32)],
  );

  await q(
    `insert into facts (tenant_id, id, type, status, value, source) values
       ($1, $2, 'faq', 'approved', $3, 'manual')`,
    [t, s.fact, JSON.stringify({ question: 'Who to contact?', answer: `Email ${SUBJECT.email}` })],
  );
  const source = id();
  const page = id();
  await q(
    `insert into kb_sources (tenant_id, id, kind, created_by, name, upload_key, file_size, file_type)
     values ($1, $2, 'file', 'user', 'menu.pdf', 'k', 10, 'pdf')`,
    [t, source],
  );
  await q(
    `insert into kb_source_pages (tenant_id, id, source_id, attempt, seq, url, status)
     values ($1, $2, $3, 1, 1, 'file://menu.pdf', 'included')`,
    [t, page, source],
  );
  await q(
    `insert into kb_staged_facts (tenant_id, id, source_id, attempt, page_id, type, value, quote, quote_start, quote_end, confidence, dedupe_key)
     values ($1, $2, $3, 1, $4, 'faq', '{"question":"Owner"}', $5, 0, 10, 0.9, 'k1')`,
    [t, s.staged, source, page, `Contact ${SUBJECT.email} for orders`],
  );
  return s;
}

/** Rows each `find+erase` store still holds for the seeded subject. */
export async function rowsLeft(
  owner: pg.Client,
  t: string,
  s: Seeded,
): Promise<Record<string, number>> {
  const convs = [s.widgetConv, s.emailConv, s.telegramConv, s.mentionConv];
  const contacts = [s.contact, s.merged];
  const n = async (sql: string, args: unknown[]) =>
    Number((await owner.query(sql, args)).rows[0]!.n);
  const byConv = (table: string) =>
    n(`select count(*) as n from ${table} where tenant_id = $1 and conversation_id = any($2)`, [
      t,
      convs,
    ]);
  const byContact = (table: string) =>
    n(`select count(*) as n from ${table} where tenant_id = $1 and contact_id = any($2)`, [
      t,
      contacts,
    ]);
  return {
    contacts: await n(`select count(*) as n from contacts where tenant_id = $1 and id = any($2)`, [
      t,
      contacts,
    ]),
    contact_identities: await byContact('contact_identities'),
    telegram_chats: await byContact('telegram_chats'),
    handoff_links: await byConv('handoff_links'),
    consents: await byContact('consents'),
    leads: await byContact('leads'),
    conversations: await n(
      `select count(*) as n from conversations where tenant_id = $1 and id = any($2)`,
      [t, convs],
    ),
    messages: await byConv('messages'),
    conversation_summaries: await byConv('conversation_summaries'),
    escalations: await byConv('escalations'),
    approvals: await byConv('approvals'),
    suggestions: await byConv('suggestions'),
    email_attachments: await byConv('email_attachments'),
    visitor_events: await n(
      `select count(*) as n from visitor_events where tenant_id = $1 and visitor_id = $2`,
      [t, s.visitor],
    ),
    visitor_tracking_choices: await n(
      `select count(*) as n from visitor_tracking_choices where tenant_id = $1 and visitor_id = $2`,
      [t, s.visitor],
    ),
    audit_pii: await byContact('audit_pii'),
    facts: await n(`select count(*) as n from facts where tenant_id = $1 and id = $2`, [t, s.fact]),
    kb_staged_facts: await n(
      `select count(*) as n from kb_staged_facts where tenant_id = $1 and id = $2`,
      [t, s.staged],
    ),
  };
}
