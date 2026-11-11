import { isEmail } from '@kaki/contracts/lead-check';
import { and, desc, eq, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import { enqueue } from '@kaki/platform/outbox';
import { visitorChannel } from '../connections.js';
import { maskEmail } from './recap.js';
import { signHandoff, type HandoffLinkChannel } from './token.js';

/**
 * A widget visitor asks to continue on Telegram or by email (CHN-07, UC-26 steps 1–2 and 1a;
 * FEAT-038 §5.2). Creates a one-time link; the email path queues the confirmation mail
 * (`handoff-email`, only the link ID: D4). Nothing about the visitor changes until the link
 * is used: the typed email is not an identity until it is proven.
 */
export const HANDOFF_TTL_MS: Record<HandoffLinkChannel, number> = {
  telegram: 30 * 60_000,
  email: 24 * 3_600_000,
};
/** D6: per conversation 5 an hour; email 3 per conversation a day and 20 per business an hour. */
export const HANDOFF_LIMITS = {
  perConversationHour: 5,
  emailPerConversationDay: 3,
  emailPerTenantHour: 20,
} as const;

export type HandoffRequestBody = { channel: 'telegram' } | { channel: 'email'; email: string };

export type HandoffRequestResult =
  | { ok: true; channel: 'telegram'; url: string; expiresAt: Date; linkId: string }
  | { ok: true; channel: 'email'; sentTo: string; expiresAt: Date; linkId: string }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'channel_unavailable'
        | 'conversation_closed'
        | 'moved'
        | 'invalid_email'
        | 'rate_limited';
      channel?: 'telegram' | 'email';
    };

export interface HandoffOptions {
  telegram: boolean;
  email: boolean;
}

/** Which channels the business can hand off to now (§5.2 step 2; the config flags and the card). */
export async function handoffOptions(tx: Tx, tenantId: string): Promise<HandoffOptions> {
  const [telegram, email] = await Promise.all([
    visitorChannel(tx, 'telegram'),
    visitorChannel(tx, 'email'),
  ]);
  return {
    telegram: telegram.live && (await botUsername(tx, tenantId)) !== null,
    email: email.live,
  };
}

async function botUsername(tx: Tx, tenantId: string): Promise<string | null> {
  const ts = schema.telegramSettings;
  const [row] = await tx.select({ u: ts.botUsername }).from(ts).where(eq(ts.tenantId, tenantId));
  return row?.u ?? null;
}

/**
 * The visitor's contact (the leads rule, FEAT-039 D1): the conversation's contact, else the
 * same `visitor_id`'s latest, else a new empty one; linked to the conversation when empty.
 */
async function visitorContact(
  tx: Tx,
  tenantId: string,
  conversation: { id: string; visitorId: string; contactId: string | null },
): Promise<string> {
  const c = schema.conversations;
  const k = schema.contacts;
  let contactId = conversation.contactId;
  if (!contactId) {
    const [prior] = await tx
      .select({ id: c.contactId })
      .from(c)
      .innerJoin(k, and(eq(k.tenantId, c.tenantId), eq(k.id, c.contactId)))
      .where(
        and(
          eq(c.tenantId, tenantId),
          eq(c.visitorId, conversation.visitorId),
          sql`${c.contactId} is not null`,
        ),
      )
      .orderBy(desc(c.createdAt))
      .limit(1);
    contactId = prior?.id ?? null;
  }
  if (!contactId) {
    const [row] = await tx.insert(k).values({ tenantId }).returning({ id: k.id });
    contactId = row!.id;
  }
  contactId = await survivorOf(tx, tenantId, contactId);
  if (conversation.contactId !== contactId)
    await tx
      .update(c)
      .set({ contactId })
      .where(and(eq(c.tenantId, tenantId), eq(c.id, conversation.id), sql`${c.contactId} is null`));
  return contactId;
}

/** A contact merged away (FEAT-039) is represented by the one it was merged into. */
export async function survivorOf(tx: Tx, tenantId: string, contactId: string): Promise<string> {
  let id = contactId;
  for (let i = 0; i < 10; i++) {
    const [row] = await tx
      .select({ into: schema.contacts.mergedInto })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.tenantId, tenantId), eq(schema.contacts.id, id)));
    if (!row?.into) return id;
    id = row.into;
  }
  return id;
}

export async function requestHandoff(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    visitorId: string;
    body: HandoffRequestBody;
    secret: string;
    now?: Date;
  },
): Promise<HandoffRequestResult> {
  const now = input.now ?? new Date();
  const c = schema.conversations;
  const [conv] = await tx
    .select()
    .from(c)
    .where(and(eq(c.tenantId, input.tenantId), eq(c.id, input.conversationId)))
    .for('update');
  if (!conv || conv.visitorId !== input.visitorId) return { ok: false, code: 'not_found' };
  if (conv.channel !== 'widget')
    return { ok: false, code: 'moved', channel: conv.channel as 'telegram' | 'email' };
  if (conv.status === 'closed') return { ok: false, code: 'conversation_closed' };

  const channel = input.body.channel;
  const live = (await visitorChannel(tx, channel)).live;
  const bot = channel === 'telegram' ? await botUsername(tx, input.tenantId) : null;
  if (!live || (channel === 'telegram' && !bot)) return { ok: false, code: 'channel_unavailable' };

  let email: string | null = null;
  if (input.body.channel === 'email') {
    const typed = input.body.email.trim();
    if (!isEmail(typed)) return { ok: false, code: 'invalid_email' };
    email = typed.toLowerCase();
  }

  const l = schema.handoffLinks;
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
  const { rows } = await tx.execute<{
    conv_hour: number;
    conv_email_day: number;
    tenant_email_hour: number;
  }>(sql`
    select
      count(*) filter (where ${l.conversationId} = ${conv.id} and ${l.createdAt} > ${hourAgo})::int as conv_hour,
      count(*) filter (where ${l.conversationId} = ${conv.id} and ${l.channel} = 'email' and ${l.createdAt} > ${dayAgo})::int as conv_email_day,
      count(*) filter (where ${l.channel} = 'email' and ${l.createdAt} > ${hourAgo})::int as tenant_email_hour
    from ${l} where ${l.tenantId} = ${input.tenantId} and ${l.createdAt} > ${dayAgo}`);
  const n = rows[0]!;
  if (
    n.conv_hour >= HANDOFF_LIMITS.perConversationHour ||
    (channel === 'email' &&
      (n.conv_email_day >= HANDOFF_LIMITS.emailPerConversationDay ||
        n.tenant_email_hour >= HANDOFF_LIMITS.emailPerTenantHour))
  )
    return { ok: false, code: 'rate_limited' };

  const contactId = await visitorContact(tx, input.tenantId, conv);
  const expiresAt = new Date(now.getTime() + HANDOFF_TTL_MS[channel]);
  const [link] = await tx
    .insert(l)
    .values({
      tenantId: input.tenantId,
      conversationId: conv.id,
      contactId,
      channel,
      email,
      createdAt: now,
      expiresAt,
    })
    .returning({ id: l.id });
  const linkId = link!.id;
  if (channel === 'email')
    await enqueue(tx, {
      tenantId: input.tenantId,
      topic: 'conversation-turns',
      groupKey: conv.id,
      payload: { kind: 'handoff_email', tenantId: input.tenantId, linkId },
    });
  await audit.append(tx, input.tenantId, {
    action: 'handoff.requested',
    actorType: 'visitor',
    subjectType: 'conversation',
    subjectId: conv.id,
    payload: { conversationId: auditId(conv.id), channel: auditCode(channel) },
  });
  if (channel === 'telegram')
    return {
      ok: true,
      channel,
      url: `https://t.me/${bot}?start=${signHandoff(input.secret, input.tenantId, linkId, 'telegram')}`,
      expiresAt,
      linkId,
    };
  return { ok: true, channel, sentTo: maskEmail(email!), expiresAt, linkId };
}
