/**
 * Channel connections (ONB-10, CHN-12; FEAT-034 §5.1): each channel's live/offline state,
 * its offline message, and its health. Dashboard calls run under the dashboard zone, the
 * visitor read under the visitor zone (`visitor_channel()`), the health job under the
 * outbox zone. Audit payloads carry kinds, IDs, reasons and field names only (ADR-014).
 */
import {
  CHANNEL_OFFLINE_TEXT_MAX,
  type ChannelItem,
  type ChannelOfflineMode,
  type ChannelsResponse,
  type OfflineText,
} from '@kaki/contracts';
import { and, eq, schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import type { CredentialRef, HealthStatus } from './adapter.js';
import {
  CHANNEL_REGISTRY,
  connectable,
  registryEntry,
  type ChannelRegistry,
  type ChannelRegistryEntry,
} from './registry.js';

export class ChannelNotFoundError extends Error {}
export class ChannelConflictError extends Error {}
export class OfflineModeError extends Error {}
export class OfflineTextError extends Error {
  constructor(readonly field: 'en' | 'zh') {
    super(`offline message ${field} is over ${CHANNEL_OFFLINE_TEXT_MAX} characters`);
  }
}
export class NoHealthCheckError extends Error {}
export class TooSoonError extends Error {}

/** The offline message when the tenant hasn't written one (D7). */
export const OFFLINE_DEFAULTS = {
  en: "Our chat isn't open yet. Please contact us directly for now.",
  zh: '我们的在线聊天尚未开放，请先直接联系我们。',
} as const;

/** Two consecutive unreachable checks (5 minutes apart) mark a channel degraded (AC-6). */
export const UNREACHABLE_LIMIT = 2;
/** "Check again" is refused this soon after the last check (429 `too_soon`). */
export const CHECK_AGAIN_MS = 30_000;
const HEALTH_TIMEOUT_MS = 10_000;

const cc = schema.channelConnections;

/** Every column except the sealed credential, which the dashboard zone can't read. */
const columns = {
  id: cc.id,
  tenantId: cc.tenantId,
  kind: cc.kind,
  state: cc.state,
  stateChangedAt: cc.stateChangedAt,
  offlineMode: cc.offlineMode,
  offlineMessageEn: cc.offlineMessageEn,
  offlineMessageZh: cc.offlineMessageZh,
  health: cc.health,
  healthReason: cc.healthReason,
  healthFailures: cc.healthFailures,
  healthCheckedAt: cc.healthCheckedAt,
  degradedSince: cc.degradedSince,
  version: cc.version,
};
type Row = {
  [K in keyof typeof columns]: (typeof columns)[K]['_']['notNull'] extends true
    ? (typeof columns)[K]['_']['data']
    : (typeof columns)[K]['_']['data'] | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function itemOf(row: Row, entry: ChannelRegistryEntry): ChannelItem {
  return {
    id: row.id,
    kind: row.kind,
    name: entry.name,
    state: row.state,
    stateChangedAt: iso(row.stateChangedAt),
    health: row.health,
    healthReason: row.healthReason,
    healthCheckedAt: iso(row.healthCheckedAt),
    degradedSince: iso(row.degradedSince),
    checksHealth: entry.checksHealth,
    offlineModes: [...entry.offlineModes],
    offline: {
      mode: row.offlineMode,
      message: { en: row.offlineMessageEn, zh: row.offlineMessageZh },
      defaults: { ...OFFLINE_DEFAULTS },
    },
    version: row.version,
  };
}

async function load(tx: Tx, id: string, registry: ChannelRegistry) {
  const [row] = await tx.select(columns).from(cc).where(eq(cc.id, id));
  const entry = row && registryEntry(row.kind, registry);
  if (!row || !entry) throw new ChannelNotFoundError();
  return { row, entry };
}

const subject = (row: Row) => ({ subjectType: 'channel', subjectId: row.id });
const ids = (row: Row) => ({ kind: auditCode(row.kind), connectionId: auditId(row.id) });

/** The Channels page: connections in registry order (unregistered kinds left out). */
export async function listChannels(
  tx: Tx,
  registry: ChannelRegistry = CHANNEL_REGISTRY,
): Promise<ChannelsResponse> {
  const rows = await tx.select(columns).from(cc);
  const channels = registry.flatMap((entry) => {
    const row = rows.find((r) => r.kind === entry.kind);
    return row ? [itemOf(row, entry)] : [];
  });
  return {
    channels,
    connectable: connectable(
      registry,
      rows.map((r) => r.kind),
    ),
  };
}

export interface ChannelChange {
  tenantId: string;
  userId: string;
  id: string;
  version: number;
}

/** Go live or go offline (ONB-10): explicit, versioned, audited; repeating is a no-op. */
export async function setChannelState(
  tx: Tx,
  input: ChannelChange & { state: 'live' | 'offline' },
  registry: ChannelRegistry = CHANNEL_REGISTRY,
): Promise<ChannelItem> {
  const { row, entry } = await load(tx, input.id, registry);
  if (row.state === input.state) return itemOf(row, entry);
  const now = new Date();
  const [updated] = await tx
    .update(cc)
    .set({
      state: input.state,
      stateChangedAt: now,
      stateChangedBy: input.userId,
      version: sql`${cc.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(cc.id, input.id), eq(cc.version, input.version)))
    .returning(columns);
  if (!updated) throw new ChannelConflictError();
  await audit.append(tx, input.tenantId, {
    action: input.state === 'live' ? 'channel.live' : 'channel.offline',
    actorType: 'user',
    actorId: input.userId,
    ...subject(updated),
    payload: ids(updated),
  });
  return itemOf(updated, entry);
}

function cleanText(v: string | null, field: 'en' | 'zh'): string | null {
  const t = v?.trim() ?? '';
  if (!t) return null;
  if (t.length > CHANNEL_OFFLINE_TEXT_MAX) throw new OfflineTextError(field);
  return t;
}

/** What a channel shows while it isn't live (ONB-10, AC-5). */
export async function saveOfflineSettings(
  tx: Tx,
  input: ChannelChange & { mode: ChannelOfflineMode; message: OfflineText },
  registry: ChannelRegistry = CHANNEL_REGISTRY,
): Promise<ChannelItem> {
  const { row, entry } = await load(tx, input.id, registry);
  if (!entry.offlineModes.includes(input.mode)) throw new OfflineModeError();
  const next = {
    offlineMode: input.mode,
    offlineMessageEn: cleanText(input.message.en, 'en'),
    offlineMessageZh: cleanText(input.message.zh, 'zh'),
  };
  if (row.version !== input.version) throw new ChannelConflictError();
  const changed = [
    next.offlineMode !== row.offlineMode && 'mode',
    next.offlineMessageEn !== row.offlineMessageEn && 'message_en',
    next.offlineMessageZh !== row.offlineMessageZh && 'message_zh',
  ].filter((f): f is string => !!f);
  if (!changed.length) return itemOf(row, entry);
  const [updated] = await tx
    .update(cc)
    .set({ ...next, version: sql`${cc.version} + 1`, updatedAt: new Date() })
    .where(and(eq(cc.id, input.id), eq(cc.version, input.version)))
    .returning(columns);
  if (!updated) throw new ChannelConflictError();
  await audit.append(tx, input.tenantId, {
    action: 'channel.offline_settings',
    actorType: 'user',
    actorId: input.userId,
    ...subject(updated),
    payload: {
      kind: auditCode(updated.kind),
      mode: auditCode(updated.offlineMode),
      changed: changed.map(auditCode),
    },
  });
  return itemOf(updated, entry);
}

export interface VisitorChannel {
  live: boolean;
  mode: ChannelOfflineMode;
  /** The stored text or the default, per language. */
  message: { en: string; zh: string };
  contact: { email: string | null; phone: string | null };
}

interface VisitorChannelRow extends Record<string, unknown> {
  state: string;
  offline_mode: ChannelOfflineMode;
  offline_message_en: string | null;
  offline_message_zh: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

/**
 * A channel's availability for visitors and the send gate, through `visitor_channel()`.
 * No row or no tenant context → not live and hidden (fail closed).
 */
export async function visitorChannel(tx: Tx, kind: string): Promise<VisitorChannel> {
  const { rows } = await tx.execute<VisitorChannelRow>(sql`select * from visitor_channel(${kind})`);
  const row = rows[0];
  if (!row)
    return {
      live: false,
      mode: 'hidden',
      message: { ...OFFLINE_DEFAULTS },
      contact: { email: null, phone: null },
    };
  return {
    live: row.state === 'live',
    mode: row.offline_mode,
    message: {
      en: row.offline_message_en ?? OFFLINE_DEFAULTS.en,
      zh: row.offline_message_zh ?? OFFLINE_DEFAULTS.zh,
    },
    contact: { email: row.contact_email, phone: row.contact_phone },
  };
}

export type HealthTransition = 'degraded' | 'recovered' | null;

/**
 * Applies one health result (CHN-12, AC-6). A revoked or invalid credential or a rejected
 * send degrades at once; `unreachable` only at the second consecutive failure; `ok`
 * recovers. Entering and leaving degraded are audited once each.
 */
export async function recordHealth(
  tx: Tx,
  connection: Pick<Row, 'id' | 'tenantId' | 'kind' | 'health' | 'healthFailures' | 'degradedSince'>,
  status: HealthStatus,
  now: Date = new Date(),
): Promise<HealthTransition> {
  const wasDegraded = connection.health === 'degraded';
  let set: Partial<typeof cc.$inferInsert>;
  let transition: HealthTransition = null;
  if (status.ok) {
    set = { health: 'ok', healthReason: null, healthFailures: 0, degradedSince: null };
    if (wasDegraded) transition = 'recovered';
  } else {
    const failures = connection.healthFailures + 1;
    const degrade = status.reason !== 'unreachable' || failures >= UNREACHABLE_LIMIT;
    set = degrade
      ? {
          health: 'degraded',
          healthReason: status.reason,
          healthFailures: failures,
          degradedSince: connection.degradedSince ?? now,
        }
      : { healthFailures: failures };
    if (degrade && !wasDegraded) transition = 'degraded';
  }
  await tx
    .update(cc)
    .set({ ...set, healthCheckedAt: now, updatedAt: now })
    .where(eq(cc.id, connection.id));
  if (transition)
    await audit.append(tx, connection.tenantId, {
      action: transition === 'degraded' ? 'channel.degraded' : 'channel.recovered',
      actorType: 'system',
      subjectType: 'channel',
      subjectId: connection.id,
      payload: {
        kind: auditCode(connection.kind),
        connectionId: auditId(connection.id),
        ...(status.ok ? {} : { reason: auditCode(status.reason) }),
      },
    });
  return transition;
}

/**
 * The send-path hook for adapters (FEAT-036+; ADR-011): a 401/403 from `send` degrades the
 * connection at once. Other failures change nothing here; the outbox retries (NFR-17).
 */
export async function reportSendFailure(
  tx: Tx,
  connectionId: string,
  result: { ok: true } | { ok: false; failed: 'auth' | 'transient' | 'permanent' },
): Promise<HealthTransition> {
  if (result.ok || result.failed !== 'auth') return null;
  const [row] = await tx.select(columns).from(cc).where(eq(cc.id, connectionId));
  if (!row) return null;
  return recordHealth(tx, row, { ok: false, reason: 'send_rejected' });
}

/** Runs an adapter's check with a timeout; a throw or a timeout counts as unreachable. */
async function probe(
  entry: ChannelRegistryEntry,
  creds: CredentialRef,
  timeoutMs: number,
): Promise<HealthStatus> {
  let timer: NodeJS.Timeout | undefined;
  const unreachable: HealthStatus = { ok: false, reason: 'unreachable' };
  try {
    if (!entry.adapter) return unreachable;
    const adapter = await entry.adapter();
    const timeout = new Promise<HealthStatus>((resolve) => {
      timer = setTimeout(() => resolve(unreachable), timeoutMs);
    });
    return await Promise.race([adapter.checkHealth(creds), timeout]);
  } catch {
    return unreachable;
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthRunResult {
  checked: number;
  degraded: number;
  recovered: number;
  failed: number;
}

interface DueRow extends Record<string, unknown> {
  tenant_id: string;
  id: string;
  kind: string;
}

/**
 * The scheduler's health job (CHN-12; outbox zone): every connection of a health-checked
 * kind, across tenants via `channel_health_due()`. The network call runs outside any
 * transaction; one failing tenant doesn't stop the others.
 */
export async function runChannelHealth(
  zdb: ZoneDb,
  opts: { registry?: ChannelRegistry; now?: () => Date; timeoutMs?: number } = {},
): Promise<HealthRunResult> {
  const registry = opts.registry ?? CHANNEL_REGISTRY;
  const now = opts.now ?? (() => new Date());
  const out: HealthRunResult = { checked: 0, degraded: 0, recovered: 0, failed: 0 };
  const kinds = registry.filter((e) => e.checksHealth).map((e) => e.kind);
  if (!kinds.length) return out;
  const { rows } = await zdb.db.execute<DueRow>(
    sql`select tenant_id, id, kind from channel_health_due(string_to_array(${kinds.join(',')}, ','))`,
  );
  for (const due of rows) {
    const entry = registryEntry(due.kind, registry);
    if (!entry) continue;
    try {
      const creds = await withTenant(zdb, due.tenant_id, async (tx) => {
        const [c] = await tx
          .select({ ciphertext: cc.credentialCiphertext, keyRef: cc.credentialKeyRef })
          .from(cc)
          .where(eq(cc.id, due.id));
        return c;
      });
      if (!creds) continue;
      const status = await probe(
        entry,
        {
          connectionId: due.id,
          tenantId: due.tenant_id,
          ciphertext: creds.ciphertext,
          keyRef: creds.keyRef,
        },
        opts.timeoutMs ?? HEALTH_TIMEOUT_MS,
      );
      const transition = await withTenant(zdb, due.tenant_id, async (tx) => {
        const [row] = await tx.select(columns).from(cc).where(eq(cc.id, due.id));
        return row ? recordHealth(tx, row, status, now()) : null;
      });
      out.checked += 1;
      if (transition === 'degraded') out.degraded += 1;
      if (transition === 'recovered') out.recovered += 1;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}

/**
 * "Check again" on the Channels page (dashboard zone). The dashboard zone can't read the
 * sealed credential, so `credentialOf` supplies it; until a channel stores one (FEAT-036+)
 * the adapter gets a reference without ciphertext.
 */
export async function checkChannelNow(
  tx: Tx,
  input: {
    id: string;
    registry?: ChannelRegistry;
    now?: Date;
    timeoutMs?: number;
    credentialOf?: (connectionId: string) => Promise<CredentialRef>;
  },
): Promise<ChannelItem> {
  const registry = input.registry ?? CHANNEL_REGISTRY;
  const now = input.now ?? new Date();
  const { row, entry } = await load(tx, input.id, registry);
  if (!entry.checksHealth) throw new NoHealthCheckError();
  if (row.healthCheckedAt && now.getTime() - row.healthCheckedAt.getTime() < CHECK_AGAIN_MS)
    throw new TooSoonError();
  const creds = input.credentialOf
    ? await input.credentialOf(row.id)
    : { connectionId: row.id, tenantId: row.tenantId, ciphertext: null, keyRef: null };
  const status = await probe(entry, creds, input.timeoutMs ?? HEALTH_TIMEOUT_MS);
  await recordHealth(tx, row, status, now);
  return itemOf((await load(tx, input.id, registry)).row, entry);
}
