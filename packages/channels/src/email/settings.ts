/**
 * The email channel's settings (CHN-04, CHN-10; FEAT-036 §3, SCR-APP-038): set up with a
 * forwarding address, the reply cap, the custom sending domain, and a failed delivery's
 * retry. Dashboard zone, in the caller's tenant transaction; provider calls (SES) happen
 * between the caller's transactions, never inside one.
 */
import { and, desc, eq, gte, schema, sql, type Tx } from '@kaki/db';
import type { EmailChannelResponse, EmailIgnoreReason } from '@kaki/contracts';
import { audit, auditCode } from '@kaki/governance';
import { enqueue } from '@kaki/platform/outbox';
import { domainOf, records, refusedDomain, type DomainChecks } from './identity.js';

const { channelConnections: cc, emailSettings: es, inboundEvents: ie, tenants } = schema;
const md = schema.messageDeliveries;

/** The setup's AI reply cap (CHN-10: 10 per thread per 24 h, tenant-set). */
export const DEFAULT_REPLY_CAP = 10;
/** "Check" at most this often (§3: 429 `too_soon`). */
export const DOMAIN_CHECK_MS = 30_000;
const IGNORED_DAYS = 7;

export class EmailChannelError extends Error {
  constructor(
    readonly code:
      | 'already_connected'
      | 'not_connected'
      | 'stale'
      | 'platform_domain'
      | 'provider_unavailable'
      | 'too_soon'
      | 'not_failed'
      | 'not_found',
  ) {
    super(code);
  }
}

export interface EmailSettingsConfig {
  /** `in.<platform domain>`. */
  inboundDomain: string;
  /** For the MAIL FROM MX record. */
  region: string;
}

type SettingsRow = typeof es.$inferSelect;

async function settingsOf(tx: Tx, tenantId: string, lock = false): Promise<SettingsRow | null> {
  const q = tx.select().from(es).where(eq(es.tenantId, tenantId));
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
}

function requireVersion(row: SettingsRow | null, version: number): SettingsRow {
  if (!row) throw new EmailChannelError('not_connected');
  if (row.version !== version) throw new EmailChannelError('stale');
  return row;
}

/** `GET /api/v1/channels/email`; `checks` (a check just ran) gives each record its result. */
export async function emailChannelView(
  tx: Tx,
  tenantId: string,
  cfg: EmailSettingsConfig,
  checks: DomainChecks | null = null,
): Promise<EmailChannelResponse> {
  const settings = await settingsOf(tx, tenantId);
  const [conn] = settings
    ? await tx
        .select({ id: cc.id, state: cc.state, version: cc.version, cap: cc.aiReplyCap })
        .from(cc)
        .where(and(eq(cc.tenantId, tenantId), eq(cc.id, settings.connectionId)))
    : [];
  const domain = cfg.inboundDomain.toLowerCase();
  const forwarding = settings ? `${settings.forwardingLocal}@${domain}` : null;
  const since = new Date(Date.now() - IGNORED_DAYS * 24 * 60 * 60 * 1000);
  const ignored = settings
    ? await tx
        .select({ reason: ie.ignoreReason, count: sql<number>`count(*)::int` })
        .from(ie)
        .where(and(eq(ie.tenantId, tenantId), eq(ie.outcome, 'ignored'), gte(ie.receivedAt, since)))
        .groupBy(ie.ignoreReason)
        .orderBy(desc(sql`count(*)`), ie.ignoreReason)
    : [];
  const confirmation = settings?.forwardingConfirmation as {
    code?: string | null;
    link?: string | null;
    receivedAt?: string;
  } | null;
  const verified = settings?.domainState === 'verified' && settings.domainAddress;
  return {
    connected: !!settings && !!conn,
    connection: conn
      ? { id: conn.id, state: conn.state as 'live' | 'offline', version: conn.version }
      : null,
    forwardingAddress: forwarding,
    lastReceivedAt: settings?.lastReceivedAt?.toISOString() ?? null,
    forwardingConfirmation: confirmation?.receivedAt
      ? {
          code: confirmation.code ?? null,
          link: confirmation.link ?? null,
          receivedAt: confirmation.receivedAt,
        }
      : null,
    replyFrom: verified ? settings.domainAddress! : (forwarding ?? ''),
    domain:
      settings?.domain && settings.domainAddress && settings.domainState
        ? {
            address: settings.domainAddress,
            domain: settings.domain,
            state: settings.domainState,
            checkedAt: settings.domainCheckedAt?.toISOString() ?? null,
            verifiedAt: settings.domainVerifiedAt?.toISOString() ?? null,
            failingSince: settings.domainFailingSince?.toISOString() ?? null,
            records: records({
              domain: settings.domain,
              dkimTokens: settings.dkimTokens,
              region: cfg.region,
              state: settings.domainState,
              checks,
            }),
          }
        : null,
    replyCap: conn?.cap ?? DEFAULT_REPLY_CAP,
    ignored: ignored
      .filter((r): r is { reason: EmailIgnoreReason; count: number } => r.reason !== null)
      .map((r) => ({ reason: r.reason, count: Number(r.count) })),
    settingsVersion: settings?.version ?? 0,
  };
}

/** The forwarding local part: the tenant slug, suffixed `-2…` on a clash (§4). */
const localFrom = (slug: string) =>
  slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56) || 'shop';

/**
 * `POST /api/v1/channels/email` (UC-25): the connection, offline and hidden (D3), and the
 * settings with a globally unique forwarding address. Unique across tenants by index, which
 * RLS can't show, so each candidate is tried under a savepoint.
 */
export async function setupEmail(
  tx: Tx,
  input: { tenantId: string; userId: string },
): Promise<void> {
  if (await settingsOf(tx, input.tenantId)) throw new EmailChannelError('already_connected');
  const [existing] = await tx
    .select({ id: cc.id })
    .from(cc)
    .where(and(eq(cc.tenantId, input.tenantId), eq(cc.kind, 'email')));
  if (existing) throw new EmailChannelError('already_connected');
  const [tenant] = await tx
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId));
  // Raw SQL: Drizzle names every column (as DEFAULT), and the dashboard may insert only these.
  const { rows: inserted } = await tx.execute<{ id: string }>(
    sql`insert into channel_connections (tenant_id, kind, state, offline_mode, health, ai_reply_cap)
        values (${input.tenantId}, 'email', 'offline', 'hidden', 'ok', ${DEFAULT_REPLY_CAP})
        returning id`,
  );
  const conn = inserted[0];
  const base = localFrom(tenant?.slug ?? 'shop');
  let local: string | null = null;
  for (let n = 1; n <= 20 && !local; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    try {
      await tx.transaction(async (sp) => {
        await sp
          .insert(es)
          .values({ tenantId: input.tenantId, connectionId: conn!.id, forwardingLocal: candidate });
      });
      local = candidate;
    } catch (err) {
      if (
        (err as { code?: string }).code !== '23505' &&
        (err as { cause?: { code?: string } }).cause?.code !== '23505'
      )
        throw err;
    }
  }
  if (!local) throw new Error('no free forwarding address');
  await audit.append(tx, input.tenantId, {
    action: 'channel.connected',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'channel',
    subjectId: conn!.id,
    payload: { kind: auditCode('email') },
  });
}

/** `PUT /api/v1/channels/email/reply-cap` (CHN-10). */
export async function saveReplyCap(
  tx: Tx,
  input: { tenantId: string; userId: string; replyCap: number; settingsVersion: number },
): Promise<void> {
  const row = requireVersion(await settingsOf(tx, input.tenantId, true), input.settingsVersion);
  await tx
    .update(cc)
    .set({ aiReplyCap: input.replyCap })
    .where(and(eq(cc.tenantId, input.tenantId), eq(cc.id, row.connectionId)));
  await tx
    .update(es)
    .set({ version: sql`${es.version} + 1` })
    .where(eq(es.tenantId, input.tenantId));
  await audit.append(tx, input.tenantId, {
    action: 'channel.reply_cap',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'channel',
    subjectId: row.connectionId,
    payload: { replyCap: input.replyCap },
  });
}

/**
 * First half of `POST /api/v1/channels/email/domain`: checks the address and the version
 * and returns the domain the provider should create. Free mail and our own domain → 422.
 */
export async function domainToAdd(
  tx: Tx,
  input: { tenantId: string; address: string; settingsVersion: number },
  cfg: EmailSettingsConfig,
): Promise<string> {
  requireVersion(await settingsOf(tx, input.tenantId), input.settingsVersion);
  if (refusedDomain(input.address, cfg.inboundDomain))
    throw new EmailChannelError('platform_domain');
  return domainOf(input.address);
}

/** Second half: stores the pending domain and its DKIM tokens (the version is checked again). */
export async function storeDomain(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    address: string;
    domain: string;
    dkimTokens: string[];
    mailFrom: string;
    settingsVersion: number;
  },
): Promise<void> {
  const row = requireVersion(await settingsOf(tx, input.tenantId, true), input.settingsVersion);
  await tx
    .update(es)
    .set({
      domainAddress: input.address.toLowerCase(),
      domain: input.domain,
      domainState: 'pending',
      dkimTokens: input.dkimTokens,
      mailFromDomain: input.mailFrom,
      domainCheckedAt: null,
      domainVerifiedAt: null,
      domainFailingSince: null,
      version: sql`${es.version} + 1`,
    })
    .where(eq(es.tenantId, input.tenantId));
  await audit.append(tx, input.tenantId, {
    action: 'channel.domain_added',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'channel',
    subjectId: row.connectionId,
    payload: {},
  });
}

/** `POST …/domain/check`: the domain to check, at most once per 30 s. */
export async function domainToCheck(tx: Tx, tenantId: string, now = new Date()): Promise<string> {
  const row = await settingsOf(tx, tenantId);
  if (!row) throw new EmailChannelError('not_connected');
  if (!row.domain) throw new EmailChannelError('not_found');
  if (row.domainCheckedAt && now.getTime() - row.domainCheckedAt.getTime() < DOMAIN_CHECK_MS)
    throw new EmailChannelError('too_soon');
  return row.domain;
}

/** `DELETE …/domain`, first half: the domain whose identity the provider deletes. */
export async function domainToRemove(
  tx: Tx,
  input: { tenantId: string; settingsVersion: number },
): Promise<string | null> {
  const row = requireVersion(await settingsOf(tx, input.tenantId), input.settingsVersion);
  return row.domain;
}

/** Second half: replies go back to the forwarding address. */
export async function clearDomain(
  tx: Tx,
  input: { tenantId: string; userId: string; settingsVersion: number },
): Promise<void> {
  const row = requireVersion(await settingsOf(tx, input.tenantId, true), input.settingsVersion);
  await tx
    .update(es)
    .set({
      domainAddress: null,
      domain: null,
      domainState: null,
      dkimTokens: [],
      mailFromDomain: null,
      domainCheckedAt: null,
      domainVerifiedAt: null,
      domainFailingSince: null,
      version: sql`${es.version} + 1`,
    })
    .where(eq(es.tenantId, input.tenantId));
  await audit.append(tx, input.tenantId, {
    action: 'channel.domain_removed',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'channel',
    subjectId: row.connectionId,
    payload: {},
  });
}

/**
 * `POST /api/v1/messages/:id/delivery/retry` (NFR-17; §3): a failed delivery starts again
 * (pending, a fresh 24 h) and its `channel-send` job rides the conversation's FIFO group.
 */
export async function retryDelivery(
  tx: Tx,
  input: { tenantId: string; userId: string; messageId: string },
): Promise<{ conversationId: string }> {
  const [row] = await tx
    .select({ status: md.status, conversationId: md.conversationId })
    .from(md)
    .where(and(eq(md.tenantId, input.tenantId), eq(md.messageId, input.messageId)))
    .for('update');
  if (!row) throw new EmailChannelError('not_found');
  if (row.status !== 'failed') throw new EmailChannelError('not_failed');
  await tx
    .update(md)
    .set({
      status: 'pending',
      failedReason: null,
      attempts: 0,
      firstAttemptAt: new Date(),
      nextAttemptAt: null,
      version: sql`${md.version} + 1`,
    })
    .where(and(eq(md.tenantId, input.tenantId), eq(md.messageId, input.messageId)));
  await enqueue(tx, {
    tenantId: input.tenantId,
    topic: 'channel-send',
    groupKey: row.conversationId,
    payload: { tenantId: input.tenantId, messageId: input.messageId },
  });
  await audit.append(tx, input.tenantId, {
    action: 'channel.delivery_retry',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'message',
    subjectId: input.messageId,
    payload: {},
  });
  return { conversationId: row.conversationId };
}

/** `GET /api/v1/attachments/:id`: a clean attachment's object and name; null otherwise (404). */
export async function cleanAttachment(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<{ key: string; name: string; contentType: string | null } | null> {
  const ea = schema.emailAttachments;
  const [row] = await tx
    .select({ key: ea.objectKey, name: ea.name, contentType: ea.contentType, status: ea.status })
    .from(ea)
    .where(and(eq(ea.tenantId, tenantId), eq(ea.id, id)));
  if (!row || row.status !== 'clean' || !row.key) return null;
  return { key: row.key, name: row.name, contentType: row.contentType };
}
