/**
 * The website widget's settings (ONB-07, CHN-11, CHN-14, CHN-02; FEAT-032 §5.5): its look,
 * logo and position, the allowed origins (on `tenants`, D2), the install check and the
 * server-side theme detection. Dashboard calls run under the dashboard zone, the install
 * records under the visitor zone, `runThemeDetect` under the ingest zone.
 */
import { createHash } from 'node:crypto';
import type {
  AllowedOrigin,
  DetectFailure,
  DetectedTheme,
  InstallCheck,
  ThemeDetectJob,
  ThemeOverrides,
  WidgetPosition,
  WidgetSettings,
  WidgetTheme,
} from '@kaki/contracts';
import {
  DetectedTheme as DetectedThemeShape,
  ThemeOverrides as ThemeOverridesShape,
  WIDGET_LOGO_MAX_BYTES,
  WIDGET_ORIGIN_LIMIT,
} from '@kaki/contracts';
import { eq, schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { audit, auditCode, auditHash } from '@kaki/governance';
import { websiteOrigins } from '@kaki/kb';
import { enqueue } from '@kaki/platform/outbox';
import { InvalidOriginError, normaliseOrigin } from './origin.js';
import type { LiveTheme } from './theme/index.js';

export interface WidgetContext {
  tx: Tx;
  tenantId: string;
  userId: string;
}

/** Public addresses the settings response is built from (api config). */
export interface WidgetUrls {
  loaderUrl: string;
  previewUrl: string;
  apiUrl: string;
}

export class OriginExistsError extends Error {}
export class TooManyOriginsError extends Error {}
export class OriginNotFoundError extends Error {}
export class NoSiteError extends Error {}
export class OriginNotAllowedError extends Error {}
export class DetectRunningError extends Error {}
export class LogoTooLargeError extends Error {}
export class LogoTypeError extends Error {}
export { InvalidOriginError };

/** A queued or running detection younger than this blocks another (409 `detect_running`). */
export const DETECT_RUNNING_MS = 2 * 60_000;
const ws = schema.widgetSettings;

const sha = (s: string) => auditHash(createHash('sha256').update(s).digest('hex'));
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function snippetOf(urls: WidgetUrls, widgetKey: string): string {
  return `<script src="${urls.loaderUrl}" data-key="${widgetKey}" data-api="${urls.apiUrl}" async></script>`;
}

export function logoUrlOf(apiUrl: string, widgetKey: string, version: number): string {
  return `${apiUrl}/widget/v1/logo/${encodeURIComponent(widgetKey)}?v=${version}`;
}

function themeOf(
  row: {
    position: WidgetPosition;
    themeOverrides: unknown;
    detectedTheme: unknown;
    logoVersion: number;
    hasLogo: boolean;
  },
  apiUrl: string,
  widgetKey: string,
): WidgetTheme {
  const overrides = ThemeOverridesShape.safeParse(row.themeOverrides);
  const detected = DetectedThemeShape.safeParse(row.detectedTheme);
  return {
    position: row.position,
    overrides: overrides.success ? overrides.data : {},
    detected: detected.success ? detected.data : null,
    logoUrl: row.hasLogo ? logoUrlOf(apiUrl, widgetKey, row.logoVersion) : null,
  };
}

/** The install check's state (FEAT-032 §3): detected, else wrong domain, else waiting. */
export function installCheckOf(
  row: {
    installSeenAt: Date | null;
    installSeenOrigin: string | null;
    lastSeenAt: Date | null;
    rejectedOrigin: string | null;
    rejectedAt: Date | null;
  },
  allowed: readonly string[],
): InstallCheck {
  const seen = row.installSeenAt !== null && allowed.includes(row.installSeenOrigin ?? '');
  const rejected =
    row.rejectedAt !== null && (row.installSeenAt === null || row.rejectedAt > row.installSeenAt);
  return {
    state: seen ? 'detected' : rejected ? 'wrong_domain' : 'waiting',
    origin: seen ? row.installSeenOrigin : null,
    seenAt: seen ? iso(row.installSeenAt) : null,
    lastSeenAt: seen ? iso(row.lastSeenAt) : null,
    rejectedOrigin: row.rejectedAt ? row.rejectedOrigin : null,
    rejectedAt: iso(row.rejectedAt),
  };
}

async function tenantOrigins(tx: Tx, tenantId: string) {
  const [t] = await tx
    .select({ widgetKey: schema.tenants.widgetKey, allowed: schema.tenants.allowedOrigins })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId));
  if (!t) throw new Error('widget: tenant not found');
  const site = await websiteOrigins(tx);
  const fromSite = new Set(site.origins);
  const origins: AllowedOrigin[] = t.allowed.map((origin) => ({
    origin,
    fromWebsite: fromSite.has(origin),
  }));
  // The first website source whose origin is still allowed, else the first allowed origin.
  const siteUrl =
    site.sites.find((u) => t.allowed.includes(new URL(u).origin)) ?? t.allowed[0] ?? null;
  return { widgetKey: t.widgetKey, allowed: t.allowed, origins, siteUrl };
}

/** Everything SCR-APP-037 and -011 show (`GET /api/v1/widget`). */
export async function getWidgetSettings(
  ctx: WidgetContext,
  urls: WidgetUrls,
): Promise<WidgetSettings> {
  const { widgetKey, allowed, origins, siteUrl } = await tenantOrigins(ctx.tx, ctx.tenantId);
  const [row] = await ctx.tx
    .select({
      position: ws.position,
      themeOverrides: ws.themeOverrides,
      detectedTheme: ws.detectedTheme,
      detectStatus: ws.detectStatus,
      detectFailure: ws.detectFailure,
      detectRequestedAt: ws.detectRequestedAt,
      logoVersion: ws.logoVersion,
      hasLogo: sql<boolean>`${ws.logo} is not null`,
      installSeenAt: ws.installSeenAt,
      installSeenOrigin: ws.installSeenOrigin,
      lastSeenAt: ws.lastSeenAt,
      rejectedOrigin: ws.rejectedOrigin,
      rejectedAt: ws.rejectedAt,
    })
    .from(ws)
    .where(eq(ws.tenantId, ctx.tenantId));
  if (!row) throw new Error('widget: settings row missing');
  return {
    widgetKey,
    snippet: snippetOf(urls, widgetKey),
    theme: themeOf(row, urls.apiUrl, widgetKey),
    detection: {
      status: row.detectStatus,
      failure: row.detectFailure,
      requestedAt: iso(row.detectRequestedAt),
    },
    siteUrl,
    allowedOrigins: origins,
    install: installCheckOf(row, allowed),
    previewUrl: urls.previewUrl,
  };
}

const actor = (ctx: WidgetContext) => ({
  actorType: 'user' as const,
  actorId: ctx.userId,
  subjectType: 'widget',
  subjectId: ctx.tenantId,
});

export async function setAppearance(
  ctx: WidgetContext,
  input: { position: WidgetPosition; overrides: ThemeOverrides },
): Promise<void> {
  await ctx.tx
    .update(ws)
    .set({ position: input.position, themeOverrides: input.overrides, updatedAt: new Date() })
    .where(eq(ws.tenantId, ctx.tenantId));
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'widget.appearance_changed',
    ...actor(ctx),
    payload: {
      position: auditCode(input.position),
      overrides: Object.keys(input.overrides).sort().map(auditCode),
    },
  });
}

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** PNG, JPEG or WebP ≤ 100 KB whose bytes match its type (D7; no SVG). */
export async function setLogo(
  ctx: WidgetContext,
  input: { bytes: Buffer; type: string },
): Promise<void> {
  if (input.bytes.length > WIDGET_LOGO_MAX_BYTES) throw new LogoTooLargeError();
  const type = input.type.split(';')[0]!.trim().toLowerCase();
  if (!MAGIC[type]?.(input.bytes)) throw new LogoTypeError();
  await ctx.tx
    .update(ws)
    .set({
      logo: input.bytes,
      logoType: type as 'image/png',
      logoVersion: sql`${ws.logoVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(ws.tenantId, ctx.tenantId));
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'widget.logo_changed',
    ...actor(ctx),
    payload: { type: auditCode(type.replace('image/', '')), bytes: input.bytes.length },
  });
}

export async function clearLogo(ctx: WidgetContext): Promise<void> {
  const done = await ctx.tx
    .update(ws)
    .set({
      logo: null,
      logoType: null,
      logoVersion: sql`${ws.logoVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(sql`${ws.tenantId} = ${ctx.tenantId} and ${ws.logo} is not null`)
    .returning({ v: ws.logoVersion });
  if (done.length) {
    await audit.append(ctx.tx, ctx.tenantId, {
      action: 'widget.logo_changed',
      ...actor(ctx),
      payload: { type: auditCode('removed') },
    });
  }
}

async function writeOrigins(ctx: WidgetContext, origins: string[]) {
  const sorted = [...new Set(origins)].sort();
  await ctx.tx
    .update(schema.tenants)
    .set({ allowedOrigins: sorted })
    .where(eq(schema.tenants.id, ctx.tenantId));
}

/** Adds an origin typed by the owner; at most 20 besides the website sources' ones. */
export async function addOrigin(ctx: WidgetContext, input: string): Promise<string> {
  const origin = normaliseOrigin(input);
  const { allowed, origins } = await tenantOrigins(ctx.tx, ctx.tenantId);
  if (allowed.includes(origin)) throw new OriginExistsError();
  if (origins.filter((o) => !o.fromWebsite).length >= WIDGET_ORIGIN_LIMIT) {
    throw new TooManyOriginsError();
  }
  await writeOrigins(ctx, [...allowed, origin]);
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'widget.origin_added',
    ...actor(ctx),
    payload: { originHash: sha(origin) },
  });
  return origin;
}

export async function removeOrigin(ctx: WidgetContext, origin: string): Promise<void> {
  const { allowed } = await tenantOrigins(ctx.tx, ctx.tenantId);
  if (!allowed.includes(origin)) throw new OriginNotFoundError();
  await writeOrigins(
    ctx,
    allowed.filter((o) => o !== origin),
  );
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'widget.origin_removed',
    ...actor(ctx),
    payload: { originHash: sha(origin) },
  });
}

/**
 * Queues a theme detection of the tenant's site (§5.4): one outbox job on the `ingest`
 * topic in the same transaction. Defaults to `siteUrl`; an origin must be allowed.
 */
export async function requestDetection(
  ctx: WidgetContext,
  input: { origin?: string },
  now = new Date(),
): Promise<{ url: string; requestedAt: Date }> {
  const { allowed, siteUrl } = await tenantOrigins(ctx.tx, ctx.tenantId);
  let url: string;
  if (input.origin !== undefined) {
    let origin: string;
    try {
      origin = normaliseOrigin(input.origin);
    } catch {
      throw new OriginNotAllowedError();
    }
    if (!allowed.includes(origin)) throw new OriginNotAllowedError();
    url = `${origin}/`;
  } else {
    if (!siteUrl) throw new NoSiteError();
    url = siteUrl.includes('/', 8) ? siteUrl : `${siteUrl}/`;
  }
  const [cur] = await ctx.tx
    .select({ status: ws.detectStatus, at: ws.detectRequestedAt })
    .from(ws)
    .where(eq(ws.tenantId, ctx.tenantId))
    .for('update');
  if (
    cur &&
    (cur.status === 'queued' || cur.status === 'running') &&
    cur.at &&
    now.getTime() - cur.at.getTime() < DETECT_RUNNING_MS
  ) {
    throw new DetectRunningError();
  }
  await ctx.tx
    .update(ws)
    .set({ detectStatus: 'queued', detectFailure: null, detectRequestedAt: now, updatedAt: now })
    .where(eq(ws.tenantId, ctx.tenantId));
  const job: ThemeDetectJob = {
    kind: 'theme_detect',
    tenantId: ctx.tenantId,
    url,
    requestedAt: now.toISOString(),
  };
  await enqueue(ctx.tx, {
    tenantId: ctx.tenantId,
    topic: 'ingest',
    groupKey: `theme:${ctx.tenantId}`,
    payload: job,
  });
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'widget.theme_detect_requested',
    ...actor(ctx),
    payload: { originHash: sha(new URL(url).origin) },
  });
  return { url, requestedAt: now };
}

/** Opens a URL in the guarded browser and runs the detection script there (§5.4). */
export type ThemeProbe = (
  url: string,
) => Promise<{ ok: true; theme: LiveTheme } | { ok: false; failure: DetectFailure }>;

/**
 * Runs one theme-detect job (ingest zone). A job whose `requestedAt` isn't the latest
 * request, or whose request is already done, is a stale redelivery and does nothing.
 */
export async function runThemeDetect(
  zdb: ZoneDb,
  job: ThemeDetectJob,
  probe: ThemeProbe,
  now: () => Date = () => new Date(),
): Promise<'done' | 'failed' | 'stale'> {
  const requestedAt = new Date(job.requestedAt);
  const current = sql`${ws.tenantId} = ${job.tenantId} and ${ws.detectRequestedAt} = ${requestedAt}`;
  const started = await withTenant(zdb, job.tenantId, (tx) =>
    tx
      .update(ws)
      .set({ detectStatus: 'running', updatedAt: now() })
      .where(sql`${current} and ${ws.detectStatus} in ('queued', 'running')`)
      .returning({ status: ws.detectStatus }),
  );
  if (!started.length) return 'stale';
  let outcome: Awaited<ReturnType<ThemeProbe>>;
  try {
    outcome = await probe(job.url);
  } catch {
    outcome = { ok: false, failure: 'unreachable' };
  }
  const at = now();
  const detected: DetectedTheme | null = outcome.ok
    ? DetectedThemeShape.parse({
        accent: outcome.theme.accent,
        font: outcome.theme.font?.slice(0, 200) ?? null,
        radius: outcome.theme.radius,
        scheme: outcome.theme.scheme,
        url: job.url,
        detectedAt: at.toISOString(),
      })
    : null;
  const stored = await withTenant(zdb, job.tenantId, (tx) =>
    tx
      .update(ws)
      .set(
        outcome.ok
          ? { detectedTheme: detected, detectStatus: 'done', detectFailure: null, updatedAt: at }
          : { detectStatus: 'failed', detectFailure: outcome.failure, updatedAt: at },
      )
      .where(sql`${current} and ${ws.detectStatus} = 'running'`)
      .returning({ status: ws.detectStatus }),
  );
  if (!stored.length) return 'stale';
  return outcome.ok ? 'done' : 'failed';
}

/** The look a visitor's widget gets (visitor zone, config route). */
export async function visitorWidgetTheme(
  tx: Tx,
  tenantId: string,
  widgetKey: string,
  apiUrl: string,
): Promise<WidgetTheme> {
  const [row] = await tx
    .select({
      position: ws.position,
      themeOverrides: ws.themeOverrides,
      detectedTheme: ws.detectedTheme,
      logoVersion: ws.logoVersion,
      hasLogo: sql<boolean>`${ws.logoType} is not null`,
    })
    .from(ws)
    .where(eq(ws.tenantId, tenantId));
  return row
    ? themeOf(row, apiUrl, widgetKey)
    : { position: 'right', overrides: {}, detected: null, logoUrl: null };
}

/** The tenant's logo for `GET /widget/v1/logo/:key` (visitor zone). */
export async function visitorLogo(
  tx: Tx,
  tenantId: string,
): Promise<{ bytes: Buffer; type: string; version: number } | null> {
  const [row] = await tx
    .select({ bytes: ws.logo, type: ws.logoType, version: ws.logoVersion })
    .from(ws)
    .where(eq(ws.tenantId, tenantId));
  return row?.bytes && row.type ? { bytes: row.bytes, type: row.type, version: row.version } : null;
}

/** Install seen, the first time per allowed origin set; `last_seen_at` at most hourly (D8). */
export async function recordInstallSeen(
  tx: Tx,
  tenantId: string,
  origin: string,
  allowed: readonly string[],
  now = new Date(),
): Promise<'first' | 'seen' | 'throttled'> {
  const list = sql`${`{${allowed.map((o) => `"${o.replace(/["\\]/g, '')}"`).join(',')}}`}::text[]`;
  const fresh = sql`(${ws.installSeenAt} is null or not (coalesce(${ws.installSeenOrigin}, '') = any(${list})))`;
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const rows = await tx
    .update(ws)
    .set({
      installSeenAt: sql`case when ${fresh} then ${now} else ${ws.installSeenAt} end`,
      installSeenOrigin: sql`case when ${fresh} then ${origin} else ${ws.installSeenOrigin} end`,
      lastSeenAt: now,
    })
    .where(
      sql`${ws.tenantId} = ${tenantId} and (${fresh} or ${ws.lastSeenAt} is null or ${ws.lastSeenAt} < ${hourAgo})`,
    )
    .returning({ seenAt: ws.installSeenAt });
  if (!rows.length) return 'throttled';
  return rows[0]!.seenAt?.getTime() === now.getTime() ? 'first' : 'seen';
}

/** A load on an unlisted origin, kept as the latest only, at most once a minute (UC-05 5a). */
export async function recordRejectedOrigin(
  tx: Tx,
  tenantId: string,
  origin: string,
  now = new Date(),
): Promise<boolean> {
  let clean: string;
  try {
    clean = new URL(origin).origin;
  } catch {
    return false;
  }
  if (clean === 'null' || clean.length > 300) return false;
  const minuteAgo = new Date(now.getTime() - 60_000);
  const rows = await tx
    .update(ws)
    .set({ rejectedOrigin: clean, rejectedAt: now })
    .where(
      sql`${ws.tenantId} = ${tenantId} and (${ws.rejectedAt} is null or ${ws.rejectedAt} < ${minuteAgo})`,
    )
    .returning({ at: ws.rejectedAt });
  return rows.length > 0;
}
