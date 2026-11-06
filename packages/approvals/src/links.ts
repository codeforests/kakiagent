/**
 * Signed single-use approval links (APR-03; ADR-013 §5; FEAT-056 §5.1). The token is
 * stateless: `base64url(JSON claims) + "." + base64url(HMAC-SHA256(key, payloadPart))`, minted
 * per recipient at alert send time. Its nonce is stored in `used_link_nonces` only on first use,
 * and the primary key decides a race (D5). The link grants nothing: opening it only says which
 * approval to show; the decision still needs a signed-in session with approval rights.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, lt, schema, withTenant, type ZoneDb } from '@kaki/db';
import { audit, auditId } from '@kaki/governance';
import { listWorkspaces, switchWorkspace } from '@kaki/identity';
import type { ApprovalLinkError as ApprovalLinkCode, ApprovalLinkOpened } from '@kaki/contracts';

/** A link lasts 24 hours from the alert's send (APR-03). */
export const APPROVAL_LINK_TTL_S = 24 * 60 * 60;
const KEY_LABEL = 'kaki/approval-link/v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface ApprovalLinkSubject {
  tenantId: string;
  approvalId: string;
  userId: string;
}
export interface ApprovalLinkClaims extends ApprovalLinkSubject {
  /** Expiry, Unix seconds. */
  expiresAt: number;
  nonce: string;
}
export type ReadLink =
  { ok: true; claims: ApprovalLinkClaims } | { ok: false; error: 'link_invalid' | 'link_expired' };

/** A refusal of the open route; `code` maps to `APPROVAL_LINK_ERRORS`. */
export class ApprovalLinkError extends Error {
  constructor(readonly code: ApprovalLinkCode) {
    super(code);
    this.name = 'ApprovalLinkError';
  }
}

/** D2: a key derived from `MAGIC_LINK_SECRET` with a fixed label, so no new secret. */
export function approvalLinkKey(magicLinkSecret: string): Buffer {
  return createHmac('sha256', magicLinkSecret).update(KEY_LABEL).digest();
}

const mac = (key: Buffer, payloadPart: string) =>
  createHmac('sha256', key).update(payloadPart).digest();

export function signApprovalLink(key: Buffer, subject: ApprovalLinkSubject, now: Date): string {
  const claims = {
    v: 1,
    t: subject.tenantId,
    a: subject.approvalId,
    u: subject.userId,
    e: Math.floor(now.getTime() / 1000) + APPROVAL_LINK_TTL_S,
    n: randomBytes(16).toString('base64url'),
  };
  const payloadPart = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payloadPart}.${mac(key, payloadPart).toString('base64url')}`;
}

/**
 * Checks the signature (constant time) before anything else, so a forged expiry is
 * `link_invalid`, never `link_expired`; then the strict claim shape; then the expiry.
 */
export function readApprovalLink(key: Buffer, token: string, now: Date): ReadLink {
  const invalid = { ok: false, error: 'link_invalid' } as const;
  const parts = token.split('.');
  if (parts.length !== 2) return invalid;
  const [payloadPart, sigPart] = parts as [string, string];
  if (!B64URL_RE.test(payloadPart) || !B64URL_RE.test(sigPart)) return invalid;
  // Compare the canonical encodings, so a signature differing only in its padding bits fails.
  const expected = Buffer.from(mac(key, payloadPart).toString('base64url'));
  const given = Buffer.from(sigPart);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalid;
  let c: unknown;
  try {
    c = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return invalid;
  }
  if (!isClaims(c)) return invalid;
  if (now.getTime() / 1000 > c.e) return { ok: false, error: 'link_expired' };
  return {
    ok: true,
    claims: { tenantId: c.t, approvalId: c.a, userId: c.u, expiresAt: c.e, nonce: c.n },
  };
}

interface RawClaims {
  v: 1;
  t: string;
  a: string;
  u: string;
  e: number;
  n: string;
}
function isClaims(c: unknown): c is RawClaims {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return false;
  const o = c as Record<string, unknown>;
  if (Object.keys(o).sort().join() !== 'a,e,n,t,u,v') return false;
  return (
    o.v === 1 &&
    typeof o.t === 'string' &&
    UUID_RE.test(o.t) &&
    typeof o.a === 'string' &&
    UUID_RE.test(o.a) &&
    typeof o.u === 'string' &&
    UUID_RE.test(o.u) &&
    Number.isSafeInteger(o.e) &&
    typeof o.n === 'string' &&
    NONCE_RE.test(o.n)
  );
}

/** The alert's button: `${appUrl}/approve#token=…` (the fragment stays out of logs and Referers). */
export function approvalLinkUrl(
  key: Buffer,
  appUrl: string,
  subject: ApprovalLinkSubject,
  now: Date,
): string {
  return `${appUrl.replace(/\/+$/, '')}/approve#token=${signApprovalLink(key, subject, now)}`;
}

/** Who is opening: a full session, no session, or a session still owing two-step. */
export type LinkOpener =
  | { sessionId: string; userId: string; activeTenantId: string | null }
  | null
  | 'two_step'
  | 'two_step_setup';

/**
 * Opens a link (FEAT-056 §5.1). Order (D6, D7): signature → expiry → used → session → same
 * user → active member → consume + audit → switch workspace. Only the last two write; a wrong
 * account or a missing session consumes nothing. The approval's own state is not checked (D4).
 */
export async function openApprovalLink(
  deps: { dashboardDb: ZoneDb; idDb: ZoneDb; key: Buffer },
  who: LinkOpener,
  token: string,
  now: Date,
): Promise<ApprovalLinkOpened> {
  const read = readApprovalLink(deps.key, token, now);
  if (!read.ok) throw new ApprovalLinkError(read.error);
  const { tenantId, approvalId, userId, nonce, expiresAt } = read.claims;
  const t = schema.usedLinkNonces;

  const used = await withTenant(deps.dashboardDb, tenantId, async (tx) => {
    await tx.delete(t).where(and(eq(t.tenantId, tenantId), lt(t.expiresAt, now)));
    const [row] = await tx
      .select({ nonce: t.nonce })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.nonce, nonce)));
    return row !== undefined;
  });
  if (used) throw new ApprovalLinkError('link_used');

  if (who === null) return { state: 'sign_in' };
  if (who === 'two_step' || who === 'two_step_setup') return { state: who };
  if (who.userId !== userId) throw new ApprovalLinkError('wrong_account');
  const workspaces = await listWorkspaces(deps.idDb, userId, who.activeTenantId);
  if (!workspaces.some((w) => w.id === tenantId)) throw new ApprovalLinkError('not_member');

  const consumed = await withTenant(deps.dashboardDb, tenantId, async (tx) => {
    const ins = await tx
      .insert(t)
      .values({ tenantId, nonce, approvalId, userId, expiresAt: new Date(expiresAt * 1000) })
      .onConflictDoNothing()
      .returning({ nonce: t.nonce });
    if (ins.length === 0) return false;
    await audit.append(tx, tenantId, {
      action: 'approval.link_opened',
      actorType: 'user',
      actorId: userId,
      subjectType: 'approval',
      subjectId: approvalId,
      payload: { approvalId: auditId(approvalId) },
    });
    return true;
  });
  if (!consumed) throw new ApprovalLinkError('link_used');

  const switched = who.activeTenantId !== tenantId;
  if (switched) await switchWorkspace(deps.idDb, who, tenantId);
  return { state: 'opened', approvalId, switched };
}
