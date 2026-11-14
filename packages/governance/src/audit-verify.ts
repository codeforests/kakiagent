import type { AuditVerifyResult } from '@kaki/contracts';
import { sql, withTenant, type ZoneDb } from '@kaki/db';
import { audit } from './audit.js';
import { auditCode } from './payload.js';
import { verifyChain, type Anchor, type AnchorSource } from './verify.js';

/** Within this many seconds of the last verify, another one is refused (D4). */
export const VERIFY_COOLDOWN_S = 30;

/** Another verify of this tenant holds the lock (409 `verify_running`, D4). */
export class VerifyRunning extends Error {
  override name = 'VerifyRunning';
}

/** The last verify finished less than `VERIFY_COOLDOWN_S` ago (429 `verify_cooldown`, D4). */
export class VerifyCooldown extends Error {
  override name = 'VerifyCooldown';
  constructor(readonly retryAfterS: number) {
    super(`verify cooldown: retry in ${retryAfterS} s`);
  }
}

/** The text of one tenant's verify lock: `pg_*_advisory_lock(hashtextextended(key, 0))` (D4). */
export const verifyLockKey = (tenantId: string) => `audit-verify:${tenantId}`;

export interface LastVerification {
  ok: boolean;
  headSeq: number;
  verifiedAt: string;
  byUserId: string | null;
}

interface VerifiedRow extends Record<string, unknown> {
  ts: Date | string;
  actor_ref: string | null;
  payload: { ok?: boolean; head_seq?: number };
}

/** The latest `audit.verified` entry, under the caller's tenant context. */
export async function lastVerification(
  zdb: ZoneDb,
  tenantId: string,
): Promise<LastVerification | null> {
  const { rows } = await withTenant(zdb, tenantId, (tx) =>
    tx.execute<VerifiedRow>(sql`
      select ts, actor_ref, payload from audit_entries
      where tenant_id = ${tenantId} and event_type = 'audit.verified'
      order by seq desc limit 1`),
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ok: r.payload.ok === true,
    headSeq: Number(r.payload.head_seq ?? 0),
    verifiedAt: new Date(r.ts).toISOString(),
    byUserId: r.actor_ref,
  };
}

/**
 * "Verify audit chain" from the dashboard (FEAT-060 §5.2; GOV-01, ADR-014 decision 6): the
 * whole chain (D3) against the S3 anchors, one run per tenant at a time with a cooldown
 * (D4), then one PII-free `audit.verified` entry in its own transaction, above the head it
 * verified. An S3 failure still reports the database check, with `anchors: 'unavailable'`.
 */
export async function verifyForDashboard(
  zdb: ZoneDb,
  tenantId: string,
  opts: {
    anchors: AnchorSource;
    userId: string;
    now?: () => Date;
    log?: { error(obj: object, msg: string): void };
  },
): Promise<AuditVerifyResult> {
  const now = opts.now ?? (() => new Date());
  const key = [verifyLockKey(tenantId)];
  // A session lock on one checked-out connection: a transaction lock would end before
  // `verifyChain`'s own transaction runs.
  const client = await zdb.pool.connect();
  try {
    const got = await client.query<{ ok: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as ok',
      key,
    );
    if (!got.rows[0]?.ok) throw new VerifyRunning('another verify is running');
    try {
      // Checked under the lock, so a run queued behind another sees its entry.
      const last = await lastVerification(zdb, tenantId);
      if (last) {
        const ageS = (now().getTime() - new Date(last.verifiedAt).getTime()) / 1000;
        if (ageS < VERIFY_COOLDOWN_S)
          throw new VerifyCooldown(Math.max(1, Math.ceil(VERIFY_COOLDOWN_S - ageS)));
      }
      const started = Date.now();
      let anchors: AuditVerifyResult['anchors'] = 'checked';
      let list: Anchor[] = [];
      try {
        list = await opts.anchors.list(tenantId);
        if (list.length === 0) anchors = 'none_yet';
      } catch (e) {
        anchors = 'unavailable';
        opts.log?.error({ err: e, tenantId }, 'audit verify: anchors unavailable');
      }
      const r = await verifyChain(zdb, tenantId, { anchors: { list: async () => list } });
      const durationMs = Date.now() - started;
      if (r.broken)
        opts.log?.error(
          { tenantId, seq: r.broken.seq, reason: r.broken.reason },
          'audit chain broken',
        );
      await withTenant(zdb, tenantId, (tx) =>
        audit.append(tx, tenantId, {
          action: 'audit.verified',
          actorType: 'user',
          actorId: opts.userId,
          subjectType: 'tenant',
          subjectId: tenantId,
          payload: {
            ok: r.ok,
            checked: r.checked,
            head_seq: r.headSeq,
            anchors: auditCode(anchors),
            anchors_checked: r.anchorsChecked,
            ...(r.broken ? { broken_seq: r.broken.seq, reason: auditCode(r.broken.reason) } : {}),
          },
        }),
      );
      return {
        ok: r.ok,
        checked: r.checked,
        headSeq: r.headSeq,
        anchors,
        anchorsChecked: r.anchorsChecked,
        piiChecked: r.piiChecked,
        broken: r.broken ?? null,
        verifiedAt: now().toISOString(),
        durationMs,
      };
    } finally {
      await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', key);
    }
  } finally {
    client.release();
  }
}
