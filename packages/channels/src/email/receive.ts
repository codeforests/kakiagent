/**
 * Inbound email (CHN-04, CHN-10, UC-27 1–2a; FEAT-036 §5.2). SES stores the raw MIME in S3
 * and notifies SNS → SQS `email-inbound`; the agent-worker calls `receiveEmail` per message.
 * Each recipient on our domain is handled in its own visitor-zone transaction under its
 * tenant (the tenant comes from `email_route()`, never from the mail). `inbound_events`
 * makes a redelivery a no-op; the raw object is deleted only after the commit, so a failure
 * leaves the SQS message for redelivery (NFR-17).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  schema,
  sql,
  withTenant,
  type Tx,
  type ZoneDb,
} from '@kaki/db';
import { sniffType } from '@kaki/kb';
import { piiMask } from '@kaki/platform';
import { enqueue } from '@kaki/platform/outbox';
import type { EmailIgnoreReason } from '@kaki/contracts';
import { ignoreReason, type SesVerdicts } from './ignore.js';
import {
  bodyText,
  forwardingConfirmation,
  NO_TEXT,
  parseEmail,
  type ParsedEmail,
} from './parse.js';
import { lookupIds, threadSubject } from './thread.js';

type ConversationRow = typeof schema.conversations.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;

/**
 * The inbox functions receive needs (@kaki/inbox). Passed in by the worker (email) or the api
 * (Telegram, FEAT-037 §5.3 step 4), because inbox depends on tenancy, which depends on
 * channels (no cycles, AGENTS.md).
 */
export interface InboxPort {
  createConversation(
    tx: Tx,
    tenantId: string,
    visitorId: string,
    channel: 'email' | 'telegram',
  ): Promise<ConversationRow>;
  getConversation(
    tx: Tx,
    tenantId: string,
    conversationId: string,
  ): Promise<ConversationRow | null>;
  setConversationContact(
    tx: Tx,
    tenantId: string,
    conversationId: string,
    contactId: string,
  ): Promise<void>;
  appendVisitorMessage(
    tx: Tx,
    input: {
      tenantId: string;
      conversationId: string;
      visitorId: string;
      text: string;
      clientMessageId: string;
      scheduleTurn?: boolean;
    },
  ): Promise<{ message: MessageRow; created: boolean; conversation: ConversationRow }>;
  /** A closed conversation that a new message reopens (INB-08: within 7 days). */
  reopenable(row: ConversationRow, now?: Date): boolean;
}

/** Raw mail in, attachments to quarantine (S3 in the worker, a fake in tests). */
export interface MailObjectStore {
  getRaw(bucket: string, key: string): Promise<Uint8Array>;
  deleteRaw(bucket: string, key: string): Promise<void>;
  putQuarantine(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface InboundEmailConfig {
  /** `EMAIL_SNS_TOPIC_ARN`: the only topic whose notifications are trusted. */
  topicArn: string;
  /** `EMAIL_INBOUND_BUCKET`: where SES stores the raw mail. */
  inboundBucket: string;
  /** `EMAIL_INBOUND_DOMAIN`: `in.<platform domain>`. */
  inboundDomain: string;
}

export interface ReceiveDeps {
  zdb: ZoneDb;
  store: MailObjectStore;
  inbox: InboxPort;
  config: InboundEmailConfig;
  now?: () => Date;
}

/** CHN-04 attachment limits (§5.2 step 4, D9). */
export const ATTACHMENT_LIMITS = {
  count: 10,
  bytes: 10 * 1024 * 1024,
  types: ['png', 'jpeg', 'pdf'] as readonly string[],
};
/** D8: more inbound mails than this in one thread in an hour are ignored as `loop`. */
export const LOOP_LIMIT = 20;

export type RecipientOutcome =
  | { local: string; outcome: 'unknown_connection' }
  | { local: string; tenantId: string; outcome: 'duplicate' }
  | { local: string; tenantId: string; outcome: 'confirmation' }
  | { local: string; tenantId: string; outcome: 'ignored'; reason: EmailIgnoreReason }
  | {
      local: string;
      tenantId: string;
      outcome: 'accepted';
      conversation: ConversationRow;
      message: MessageRow;
      created: boolean;
      newConversation: boolean;
    };

export type ReceiveResult =
  | { rejected: 'bad_signature' | 'malformed' }
  | { notification: 'bounce'; sesMessageId: string; permanent: boolean }
  | { notification: 'other' }
  | { sesMessageId: string; recipients: RecipientOutcome[] };

interface SesReceipt {
  notificationType?: string;
  eventType?: string;
  mail?: { messageId?: string };
  receipt?: {
    recipients?: string[];
    spamVerdict?: { status?: string };
    virusVerdict?: { status?: string };
    dmarcVerdict?: { status?: string };
    action?: { type?: string; bucketName?: string; objectKey?: string };
  };
  bounce?: { bounceType?: string };
}

/** Parses the SNS envelope and checks it came from our topic (`verifyInbound`, §5.2 step 1). */
export function verifySnsEnvelope(
  body: unknown,
  config: Pick<InboundEmailConfig, 'topicArn' | 'inboundBucket'>,
): { ok: true; ses: SesReceipt } | { ok: false; rejected: 'bad_signature' | 'malformed' } {
  if (!body || typeof body !== 'object') return { ok: false, rejected: 'malformed' };
  const env = body as { Type?: string; TopicArn?: string; Message?: string };
  if (env.TopicArn !== config.topicArn) return { ok: false, rejected: 'bad_signature' };
  if (env.Type !== 'Notification' || typeof env.Message !== 'string')
    return { ok: false, rejected: 'malformed' };
  let ses: SesReceipt;
  try {
    ses = JSON.parse(env.Message) as SesReceipt;
  } catch {
    return { ok: false, rejected: 'malformed' };
  }
  const action = ses.receipt?.action;
  if (ses.notificationType === 'Received' && action?.bucketName !== config.inboundBucket)
    return { ok: false, rejected: 'bad_signature' };
  return { ok: true, ses };
}

/** `visitor_id` for an email sender: UUIDv5-shaped, from `tenant:address` (no PII in the column). */
export function emailVisitorId(tenantId: string, address: string): string {
  const h = createHash('sha1').update(`kaki-email:${tenantId}:${address.toLowerCase()}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function receiveEmail(deps: ReceiveDeps, body: unknown): Promise<ReceiveResult> {
  const v = verifySnsEnvelope(body, deps.config);
  if (!v.ok) return { rejected: v.rejected };
  const ses = v.ses;
  if (ses.eventType === 'Bounce' || ses.notificationType === 'Bounce')
    return {
      notification: 'bounce',
      sesMessageId: ses.mail?.messageId ?? '',
      permanent: ses.bounce?.bounceType === 'Permanent',
    };
  if (ses.notificationType !== 'Received') return { notification: 'other' };
  const sesMessageId = ses.mail?.messageId;
  const key = ses.receipt?.action?.objectKey;
  if (!sesMessageId || !key) return { rejected: 'malformed' };

  const raw = await deps.store.getRaw(deps.config.inboundBucket, key);
  const parsed = await parseEmail(Buffer.from(raw));
  const verdicts: SesVerdicts = {
    spam: ses.receipt?.spamVerdict?.status,
    virus: ses.receipt?.virusVerdict?.status,
    dmarc: ses.receipt?.dmarcVerdict?.status,
  };
  const domain = deps.config.inboundDomain.toLowerCase();
  const locals = [
    ...new Set(
      (ses.receipt?.recipients ?? [])
        .map((r) => r.toLowerCase())
        .filter((r) => r.endsWith(`@${domain}`))
        .map((r) => r.slice(0, r.indexOf('@'))),
    ),
  ];
  const recipients: RecipientOutcome[] = [];
  for (const local of locals) {
    const route = (
      await deps.zdb.db.execute<{ tenant_id: string; connection_id: string }>(
        sql`select tenant_id, connection_id from email_route(${local})`,
      )
    ).rows[0];
    if (!route) {
      recipients.push({ local, outcome: 'unknown_connection' });
      continue;
    }
    recipients.push(
      await withTenant(deps.zdb, route.tenant_id, (tx) =>
        receiveForTenant(tx, deps, {
          local,
          tenantId: route.tenant_id,
          connectionId: route.connection_id,
          sesMessageId,
          parsed,
          verdicts,
        }),
      ),
    );
  }
  // After every commit: the bucket's 7-day lifecycle is the backstop (§5.2 step 5).
  await deps.store.deleteRaw(deps.config.inboundBucket, key);
  return { sesMessageId, recipients };
}

interface ForTenant {
  local: string;
  tenantId: string;
  connectionId: string;
  sesMessageId: string;
  parsed: ParsedEmail;
  verdicts: SesVerdicts;
}

const { emailSettings, inboundEvents, emailMessages, emailThreads, emailAttachments } = schema;

async function receiveForTenant(
  tx: Tx,
  deps: ReceiveDeps,
  r: ForTenant,
): Promise<RecipientOutcome> {
  const now = deps.now?.() ?? new Date();
  const { tenantId, parsed, local } = r;
  const event = async (outcome: 'accepted' | 'ignored', reason: EmailIgnoreReason | null = null) =>
    tx
      .insert(inboundEvents)
      .values({
        tenantId,
        connectionId: r.connectionId,
        providerEventId: r.sesMessageId,
        receivedAt: now,
        outcome,
        ignoreReason: reason,
      })
      .onConflictDoNothing()
      .returning({ id: inboundEvents.id })
      .then((rows) => rows.length > 0);
  // The redelivery guard (ADR-011), before anything is decided; the insert's conflict below
  // is the guard against a concurrent delivery of the same mail.
  const [claimed] = await tx
    .select({ id: inboundEvents.id })
    .from(inboundEvents)
    .where(
      and(
        eq(inboundEvents.tenantId, tenantId),
        eq(inboundEvents.connectionId, r.connectionId),
        eq(inboundEvents.providerEventId, r.sesMessageId),
      ),
    );
  if (claimed) return { local, tenantId, outcome: 'duplicate' };
  const duplicate = { local, tenantId, outcome: 'duplicate' } as const;

  const [settings] = await tx
    .select()
    .from(emailSettings)
    .where(eq(emailSettings.tenantId, tenantId));
  if (!settings) throw new Error('email settings missing for a routed address');

  // Gmail's forwarding confirmation (D5): shown on the page, never a conversation.
  const confirmation = forwardingConfirmation(parsed);
  if (confirmation) {
    if (!(await event('accepted'))) return duplicate;
    await tx
      .update(emailSettings)
      .set({ forwardingConfirmation: { ...confirmation, receivedAt: now.toISOString() } })
      .where(eq(emailSettings.tenantId, tenantId));
    return { local, tenantId, outcome: 'confirmation' };
  }

  const own = parsed.messageId
    ? await tx
        .select({ id: emailMessages.rfcMessageId })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.tenantId, tenantId),
            eq(emailMessages.rfcMessageId, parsed.messageId),
            eq(emailMessages.direction, 'out'),
          ),
        )
    : [];
  const ownAddresses = [
    `${settings.forwardingLocal}@${deps.config.inboundDomain.toLowerCase()}`,
    ...(settings.domainAddress ? [settings.domainAddress.toLowerCase()] : []),
  ];
  const reason = ignoreReason(parsed, {
    ownMessage: own.length > 0,
    ownAddresses,
    verdicts: r.verdicts,
  });
  if (reason || !parsed.from) {
    if (!(await event('ignored', reason ?? 'unsafe'))) return duplicate;
    return { local, tenantId, outcome: 'ignored', reason: reason ?? 'unsafe' };
  }

  // The thread: the newest of our rows any of its References or In-Reply-To point at.
  const ids = lookupIds(parsed);
  const [hit] = ids.length
    ? await tx
        .select({ conversationId: emailMessages.conversationId })
        .from(emailMessages)
        .where(and(eq(emailMessages.tenantId, tenantId), inArray(emailMessages.rfcMessageId, ids)))
        .orderBy(desc(emailMessages.createdAt))
        .limit(1)
    : [];
  let conversation = hit
    ? await deps.inbox.getConversation(tx, tenantId, hit.conversationId)
    : null;
  if (conversation && conversation.status === 'closed' && !deps.inbox.reopenable(conversation, now))
    conversation = null;

  // D8: a runaway sender can't fill the inbox.
  if (conversation) {
    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.tenantId, tenantId),
          eq(emailMessages.conversationId, conversation.id),
          eq(emailMessages.direction, 'in'),
          gte(emailMessages.createdAt, new Date(now.getTime() - 3_600_000)),
        ),
      );
    if ((recent?.n ?? 0) >= LOOP_LIMIT) {
      if (!(await event('ignored', 'loop'))) return duplicate;
      return { local, tenantId, outcome: 'ignored', reason: 'loop' };
    }
  }
  if (!(await event('accepted'))) return duplicate;

  // The contact by the From address (D6, as FEAT-049).
  const contactId = await contactFor(tx, tenantId, parsed.from);
  let newConversation = false;
  if (!conversation) {
    conversation = await deps.inbox.createConversation(
      tx,
      tenantId,
      emailVisitorId(tenantId, parsed.from.address),
      'email',
    );
    await deps.inbox.setConversationContact(tx, tenantId, conversation.id, contactId);
    newConversation = true;
  } else if (!conversation.contactId) {
    await deps.inbox.setConversationContact(tx, tenantId, conversation.id, contactId);
  }

  const text = bodyText(parsed);
  const rfcId = parsed.messageId ?? `<${r.sesMessageId}@ses.invalid>`;
  const appended = await deps.inbox.appendVisitorMessage(tx, {
    tenantId,
    conversationId: conversation.id,
    visitorId: conversation.visitorId,
    text: text || NO_TEXT,
    clientMessageId: sha256(rfcId),
    scheduleTurn: text.length > 0,
  });
  await tx
    .insert(emailMessages)
    .values({
      tenantId,
      rfcMessageId: rfcId,
      conversationId: conversation.id,
      messageId: appended.message.id,
      direction: 'in',
      createdAt: now,
    })
    .onConflictDoNothing();
  const [thread] = await tx
    .select()
    .from(emailThreads)
    .where(
      and(eq(emailThreads.tenantId, tenantId), eq(emailThreads.conversationId, conversation.id)),
    );
  const chain = [...new Set([...(thread?.references ?? []), ...parsed.references, rfcId])].slice(
    -20,
  );
  if (thread)
    await tx
      .update(emailThreads)
      .set({ references: chain, lastInboundId: rfcId, updatedAt: now })
      .where(
        and(eq(emailThreads.tenantId, tenantId), eq(emailThreads.conversationId, conversation.id)),
      );
  else
    await tx.insert(emailThreads).values({
      tenantId,
      conversationId: conversation.id,
      subject: piiMask(threadSubject(parsed.subject)).slice(0, 200),
      references: chain,
      lastInboundId: rfcId,
      updatedAt: now,
    });
  await tx
    .update(emailSettings)
    .set({ lastReceivedAt: now })
    .where(eq(emailSettings.tenantId, tenantId));
  if (appended.created)
    await storeAttachments(tx, deps, tenantId, conversation.id, appended.message.id, parsed);
  return {
    local,
    tenantId,
    outcome: 'accepted',
    conversation: appended.conversation,
    message: appended.message,
    created: appended.created,
    newConversation,
  };
}

async function contactFor(
  tx: Tx,
  tenantId: string,
  from: { address: string; name: string | null },
): Promise<string> {
  const email = from.address.toLowerCase().slice(0, 254);
  const name = from.name?.trim().slice(0, 120) || null;
  const inserted = await tx.execute<{ id: string }>(
    sql`insert into contacts (tenant_id, name, email) values (${tenantId}, ${name}, ${email})
        on conflict (tenant_id, email) where email is not null do nothing returning id`,
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const found = await tx.execute<{ id: string }>(
    sql`select id from contacts where tenant_id = ${tenantId} and email = ${email}`,
  );
  return found.rows[0]!.id;
}

async function storeAttachments(
  tx: Tx,
  deps: ReceiveDeps,
  tenantId: string,
  conversationId: string,
  messageId: string,
  parsed: ParsedEmail,
): Promise<void> {
  for (const [i, a] of parsed.attachments.entries()) {
    const id = randomUUID();
    const sniffed = sniffType(a.content, a.name);
    const reject =
      i >= ATTACHMENT_LIMITS.count
        ? ('too_many' as const)
        : a.size > ATTACHMENT_LIMITS.bytes
          ? ('too_large' as const)
          : !sniffed.ok || !ATTACHMENT_LIMITS.types.includes(sniffed.type)
            ? sniffed.ok || sniffed.failure !== 'encrypted'
              ? ('unsupported_type' as const)
              : ('encrypted' as const)
            : null;
    const contentType = sniffed.ok ? (SNIFFED_TYPES[sniffed.type] ?? null) : null;
    await tx.insert(emailAttachments).values({
      tenantId,
      id,
      conversationId,
      messageId,
      name: piiMask(a.name).slice(0, 200) || 'attachment',
      contentType,
      size: a.size,
      status: reject ? 'rejected' : 'scanning',
      rejectReason: reject,
    });
    if (reject) continue;
    await deps.store.putQuarantine(
      `email/${tenantId}/${id}`,
      a.content,
      'application/octet-stream',
    );
    await enqueue(tx, {
      tenantId,
      topic: 'ingest',
      groupKey: id,
      payload: { kind: 'attachment_scan', tenantId, attachmentId: id },
    });
  }
}

const SNIFFED_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
};
