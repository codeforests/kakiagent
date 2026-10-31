import { schema, sql, type Tx, type ZoneDb } from '@kaki/db';
import type { RateLimiter } from '@kaki/platform';
import type { SecretSealer } from '@kaki/platform/secrets';
import { randomUUID } from 'node:crypto';
import { auditUserEvent } from './audit-user.js';
import { MfaCodeError, MfaLockedError, MfaRateLimitError, MfaStateError } from './errors.js';
import { requestMagicLink, type MagicLinkConfig } from './magic-link.js';
import { hashRecoveryCode, newRecoveryCodes } from './recovery.js';
import {
  REAUTH_WINDOW_MINUTES,
  reauthMethods,
  requireReauth,
  type ReauthMethod,
} from './reauth.js';
import type { AuthContext } from './sessions.js';
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

/**
 * Two-step verification (AUTH-03, UC-02 3/3a/3c; FEAT-006 §5.2): TOTP enrolment with
 * recovery codes, the sign-in challenge with its lockout, and re-authentication.
 */
export interface MfaDeps {
  idDb: ZoneDb;
  sealer: SecretSealer;
  limiter: RateLimiter;
  /** The issuer authenticator apps show (`APP_NAME`, D4 placeholder name). */
  issuer: string;
  now?: () => Date;
}

export const MFA_MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
/** Recovery codes and enrolment confirmations: 10 per 15 minutes per user (§5.2). */
const CODE_LIMIT = 10;
const CODE_WINDOW_MS = 15 * 60_000;

export interface MfaCodeInput {
  method: 'totp' | 'recovery';
  code: string;
}

export interface MfaStatusView {
  state: AuthContext['mfa'];
  enrolled: boolean;
  enrolledAt: Date | null;
  recoveryCodesLeft: number;
  requiredBy: { tenantId: string; name: string }[];
  lockedUntil: Date | null;
  email: string;
}

export interface ReauthStatusView {
  fresh: boolean;
  until: Date | null;
  methods: ReauthMethod[];
}

type Who = Pick<AuthContext, 'sessionId' | 'userId'>;

const aad = (factorId: string) => `mfa:${factorId}`;

async function requiredBy(tx: Tx | ZoneDb['db'], userId: string) {
  const { rows } = await tx.execute<{ tenant_id: string; name: string }>(
    sql`select tenant_id, name from user_mfa_required_by(${userId})`,
  );
  return rows.map((r) => ({ tenantId: r.tenant_id, name: r.name }));
}

async function storeRecoveryCodes(tx: Tx, userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await tx.execute(sql`delete from recovery_codes where user_id = ${userId}`);
  await tx
    .insert(schema.recoveryCodes)
    .values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })));
  return codes;
}

export async function mfaStatus(deps: MfaDeps, auth: AuthContext): Promise<MfaStatusView> {
  const { rows } = await deps.idDb.db.execute<{
    confirmed_at: Date | null;
    locked_until: Date | null;
    codes_left: number;
  }>(
    sql`select f.confirmed_at,
               case when f.locked_until > now() then f.locked_until end as locked_until,
               (select count(*)::int from recovery_codes
                 where user_id = ${auth.userId} and used_at is null) as codes_left
        from (select 1) one
        left join mfa_factors f on f.user_id = ${auth.userId} and f.confirmed_at is not null`,
  );
  const r = rows[0]!;
  const enrolled = r.confirmed_at !== null;
  return {
    state: auth.mfa,
    enrolled,
    enrolledAt: r.confirmed_at ? new Date(r.confirmed_at) : null,
    recoveryCodesLeft: enrolled ? r.codes_left : 0,
    requiredBy: await requiredBy(deps.idDb.db, auth.userId),
    lockedUntil: r.locked_until ? new Date(r.locked_until) : null,
    email: auth.email,
  };
}

export async function reauthStatus(idDb: ZoneDb, auth: AuthContext): Promise<ReauthStatusView> {
  const { rows } = await idDb.db.execute<{ until: Date }>(
    sql`select reauth_at + make_interval(mins => ${REAUTH_WINDOW_MINUTES}) as until
        from sessions where id = ${auth.sessionId}`,
  );
  const until = rows[0] ? new Date(rows[0].until) : null;
  const fresh = until !== null && until.getTime() > Date.now();
  return { fresh, until: fresh ? until : null, methods: reauthMethods(auth.mfaEnrolled) };
}

/**
 * Starts enrolment (needs a fresh re-auth): replaces any unconfirmed factor with a newly
 * sealed secret and returns it for the QR code and the manual key.
 */
export async function startEnrolment(
  deps: MfaDeps,
  auth: AuthContext,
): Promise<{ secret: string; otpauthUri: string }> {
  requireReauth(auth);
  if (auth.mfaEnrolled) throw new MfaStateError('mfa_already_enrolled');
  const secret = newTotpSecret();
  const id = randomUUID();
  const sealed = await deps.sealer.seal(secret, aad(id));
  await deps.idDb.db.transaction(async (tx) => {
    await tx.execute(
      sql`delete from mfa_factors where user_id = ${auth.userId} and confirmed_at is null`,
    );
    await tx.insert(schema.mfaFactors).values({
      id,
      userId: auth.userId,
      secretCiphertext: Buffer.from(sealed.ciphertext),
      keyRef: sealed.keyRef,
    });
  });
  return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, auth.email, deps.issuer) };
}

interface FactorRow extends Record<string, unknown> {
  id: string;
  secret_ciphertext: Buffer;
  key_ref: string;
  last_used_step: string | number | null;
  failed_attempts: number;
  locked: boolean;
  locked_until: Date | null;
}

async function openSecret(deps: MfaDeps, f: FactorRow): Promise<Uint8Array> {
  return deps.sealer.open(new Uint8Array(f.secret_ciphertext), f.key_ref, aad(f.id));
}

const stepOf = (v: string | number | null) => (v === null ? null : Number(v));
const now = (deps: MfaDeps) => (deps.now ?? (() => new Date()))();

/**
 * Confirms enrolment with one code from the app: the factor counts from now, ten recovery
 * codes replace any old ones (shown once), this session has passed the second factor, and
 * the user's other sessions must pass the challenge (D7).
 */
export async function confirmEnrolment(
  deps: MfaDeps,
  auth: AuthContext,
  code: string,
): Promise<string[]> {
  const limit = await deps.limiter.hit(`rl:mfa:en:${auth.userId}`, CODE_LIMIT, CODE_WINDOW_MS);
  if (!limit.allowed) throw new MfaRateLimitError();
  return deps.idDb.db.transaction(async (tx) => {
    const { rows } = await tx.execute<FactorRow>(
      sql`select id, secret_ciphertext, key_ref, last_used_step, failed_attempts,
                 false as locked, locked_until
          from mfa_factors where user_id = ${auth.userId} and confirmed_at is null for update`,
    );
    const f = rows[0];
    if (!f) throw new MfaStateError('no_enrolment');
    const check = verifyTotp(await openSecret(deps, f), code, now(deps), null);
    if (!check.ok) throw new MfaCodeError();
    await tx.execute(
      sql`update mfa_factors set confirmed_at = now(), last_used_step = ${check.step}
          where id = ${f.id}`,
    );
    const codes = await storeRecoveryCodes(tx, auth.userId);
    await tx.execute(
      sql`update sessions set mfa_at = now(), reauth_at = now() where id = ${auth.sessionId}`,
    );
    await tx.execute(
      sql`update sessions set mfa_at = null
          where user_id = ${auth.userId} and id <> ${auth.sessionId} and mfa_at is not null`,
    );
    await auditUserEvent(tx, auth.userId, 'mfa.enrolled');
    return codes;
  });
}

type Outcome =
  { ok: true } | { ok: false; error: MfaCodeError | MfaLockedError | MfaRateLimitError };

/**
 * One code against the confirmed factor (§5.2 "Challenge and lockout"). The factor row is
 * locked for the attempt; the counter and lock commit even when the code is wrong, so the
 * error is thrown after the transaction.
 */
async function checkSecondFactor(
  deps: MfaDeps,
  who: Who,
  input: MfaCodeInput,
  passesChallenge: boolean,
): Promise<void> {
  if (input.method === 'recovery') {
    const limit = await deps.limiter.hit(`rl:mfa:rc:${who.userId}`, CODE_LIMIT, CODE_WINDOW_MS);
    if (!limit.allowed) throw new MfaRateLimitError();
  }
  const outcome = await deps.idDb.db.transaction(async (tx): Promise<Outcome> => {
    const { rows } = await tx.execute<FactorRow>(
      sql`select id, secret_ciphertext, key_ref, last_used_step, failed_attempts,
                 coalesce(locked_until > now(), false) as locked, locked_until
          from mfa_factors where user_id = ${who.userId} and confirmed_at is not null
          for update`,
    );
    const f = rows[0];
    if (!f) throw new MfaStateError('mfa_not_enrolled');
    const passed = async () => {
      await tx.execute(
        passesChallenge
          ? sql`update sessions set mfa_at = now(), reauth_at = now() where id = ${who.sessionId}`
          : sql`update sessions set reauth_at = now() where id = ${who.sessionId}`,
      );
    };
    if (input.method === 'recovery') {
      const used = await tx.execute(
        sql`update recovery_codes set used_at = now()
            where user_id = ${who.userId} and code_hash = ${hashRecoveryCode(input.code)}
              and used_at is null
            returning id`,
      );
      if (!used.rows[0]) return { ok: false, error: new MfaCodeError() };
      // A recovery code works while locked, and clears the lock (UC-02 3c).
      await tx.execute(
        sql`update mfa_factors set failed_attempts = 0, locked_until = null where id = ${f.id}`,
      );
      await passed();
      await auditUserEvent(tx, who.userId, 'mfa.recovery_code_used');
      return { ok: true };
    }
    if (f.locked) return { ok: false, error: new MfaLockedError(new Date(f.locked_until!)) };
    const check = verifyTotp(
      await openSecret(deps, f),
      input.code,
      now(deps),
      stepOf(f.last_used_step),
    );
    if (!check.ok) {
      const failed = f.failed_attempts + 1;
      if (failed >= MFA_MAX_ATTEMPTS) {
        const { rows: locked } = await tx.execute<{ locked_until: Date }>(
          sql`update mfa_factors set failed_attempts = 0,
                locked_until = now() + make_interval(mins => ${LOCK_MINUTES})
              where id = ${f.id} returning locked_until`,
        );
        await auditUserEvent(tx, who.userId, 'mfa.locked');
        return { ok: false, error: new MfaLockedError(new Date(locked[0]!.locked_until)) };
      }
      await tx.execute(sql`update mfa_factors set failed_attempts = ${failed} where id = ${f.id}`);
      return { ok: false, error: new MfaCodeError(MFA_MAX_ATTEMPTS - failed) };
    }
    await tx.execute(
      sql`update mfa_factors set failed_attempts = 0, last_used_step = ${check.step}
          where id = ${f.id}`,
    );
    await passed();
    return { ok: true };
  });
  if (!outcome.ok) throw outcome.error;
}

/** The sign-in challenge (UC-02 step 3): opens the session for everything. */
export const passChallenge = (deps: MfaDeps, auth: AuthContext, input: MfaCodeInput) =>
  checkSecondFactor(deps, auth, input, true);

/** Re-authentication with the second factor (AUTH-03): refreshes the 10-minute window. */
export const reauthenticate = (deps: MfaDeps, auth: AuthContext, input: MfaCodeInput) =>
  checkSecondFactor(deps, auth, input, false);

/** New recovery codes (needs a fresh re-auth); every old one stops working. */
export async function regenerateRecoveryCodes(deps: MfaDeps, auth: AuthContext): Promise<string[]> {
  requireReauth(auth);
  if (!auth.mfaEnrolled) throw new MfaStateError('mfa_not_enrolled');
  return deps.idDb.db.transaction(async (tx) => {
    const codes = await storeRecoveryCodes(tx, auth.userId);
    await auditUserEvent(tx, auth.userId, 'mfa.recovery_codes_regenerated');
    return codes;
  });
}

/**
 * Turns two-step verification off (needs a fresh re-auth), unless a workspace of the user
 * requires it.
 */
export async function removeFactor(deps: MfaDeps, auth: AuthContext): Promise<void> {
  requireReauth(auth);
  if (!auth.mfaEnrolled) throw new MfaStateError('mfa_not_enrolled');
  await deps.idDb.db.transaction(async (tx) => {
    const required = await requiredBy(tx, auth.userId);
    if (required.length)
      throw new MfaStateError(
        'mfa_required_by_workspace',
        required.map((r) => r.name),
      );
    await tx.execute(sql`delete from recovery_codes where user_id = ${auth.userId}`);
    await tx.execute(sql`delete from mfa_factors where user_id = ${auth.userId}`);
    await auditUserEvent(tx, auth.userId, 'mfa.removed');
  });
}

/**
 * Records a re-auth link for a user without a factor (D4); the caller sends it like a
 * sign-in link. An enrolled user re-authenticates with the app instead.
 */
export async function requestReauthLink(
  idDb: ZoneDb,
  cfg: MagicLinkConfig,
  auth: AuthContext,
): Promise<{ id: string }> {
  if (auth.mfaEnrolled) throw new MfaStateError('use_authenticator');
  return requestMagicLink(idDb, cfg, auth.email, auth.sessionId);
}
