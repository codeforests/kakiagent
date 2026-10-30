/**
 * Two-step verification and re-authentication on the real schema, as the identity zone
 * (FEAT-006 T3; AC-1–AC-3, AC-5–AC-7).
 */
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { verifyChain } from '@kaki/governance';
import { memoryRateLimiter, type Email, type Mailer } from '@kaki/platform';
import { localSealer } from '@kaki/platform/secrets';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authenticate,
  base32Decode,
  confirmEnrolment,
  consumeMagicLink,
  LinkError,
  MfaCodeError,
  MfaLockedError,
  MfaRateLimitError,
  MfaStateError,
  mfaStatus,
  passChallenge,
  reauthenticate,
  ReauthRequiredError,
  reauthStatus,
  regenerateRecoveryCodes,
  removeFactor,
  requestMagicLink,
  requestReauthLink,
  requireReauth,
  sendMagicLink,
  startEnrolment,
  totpAt,
  totpStep,
  type AuthContext,
  type MagicLinkConfig,
  type MfaDeps,
} from '../src/index.js';

const cfg: MagicLinkConfig = { secret: 'm'.repeat(32), appUrl: 'http://localhost:5173' };
const sealer = localSealer(randomBytes(32));

let tdb: TestDatabase;
let owner: pg.Client;
let clock = Date.now();
const id = () => tdb.zone('identity');
const deps = (): MfaDeps => ({
  idDb: id(),
  sealer,
  limiter: memoryRateLimiter(),
  issuer: 'KakiAgent',
  now: () => new Date(clock),
});
/** Each code below uses a new 30-second step, as a person would. */
const tick = () => (clock += 30_000);
const codeFor = (secret: string) => totpAt(base32Decode(secret), totpStep(new Date(clock)));
const wrongFor = (secret: string) => String((Number(codeFor(secret)) + 1) % 1e6).padStart(6, '0');

function fakeMailer() {
  const sent: Email[] = [];
  const mailer: Mailer & { sent: Email[] } = {
    sent,
    async send(e) {
      sent.push(e);
    },
    async close() {},
  };
  return mailer;
}
const tokenIn = (e: Email) => /#token=([A-Za-z0-9_-]{43})/.exec(e.text)![1]!;

async function signIn(email: string) {
  const mailer = fakeMailer();
  const link = await requestMagicLink(id(), cfg, email);
  await sendMagicLink(id(), mailer, cfg, link.id);
  const s = await consumeMagicLink(id(), tokenIn(mailer.sent[0]!));
  return { ...s, auth: () => authOf(s.token) };
}

async function authOf(token: string): Promise<AuthContext> {
  const r = await authenticate(id(), token);
  if (!r.ok) throw new Error(`not signed in: ${r.reason}`);
  return r.auth;
}

/** A new user with active memberships in the given tenants. */
async function member(email: string, tenants: string[]) {
  const u = await owner.query(`insert into users (email) values ($1) returning id`, [email]);
  for (const t of tenants)
    await owner.query(
      `insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`,
      [t, u.rows[0].id],
    );
  return u.rows[0].id as string;
}

/** Enrols a signed-in user; returns the base32 secret and the recovery codes. */
async function enrol(s: Awaited<ReturnType<typeof signIn>>) {
  const d = deps();
  const { secret } = await startEnrolment(d, await s.auth());
  tick();
  const codes = await confirmEnrolment(d, await s.auth(), codeFor(secret));
  return { secret, codes };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('enrolment (AC-1, AC-6)', () => {
  it('confirms one code, issues ten codes once, and stores only sealed and hashed values', async () => {
    const userId = await member('enrol@mfa.test', [TENANT_A]);
    const s = await signIn('enrol@mfa.test');
    expect(s.next).toBe('app');
    const d = deps();
    const start = await startEnrolment(d, await s.auth());
    expect(start.otpauthUri).toMatch(/^otpauth:\/\/totp\/KakiAgent:enrol%40mfa\.test\?secret=/);
    tick();
    await expect(confirmEnrolment(d, await s.auth(), wrongFor(start.secret))).rejects.toThrow(
      MfaCodeError,
    );
    const codes = await confirmEnrolment(d, await s.auth(), codeFor(start.secret));
    expect(new Set(codes).size).toBe(10);
    await expect(confirmEnrolment(d, await s.auth(), codeFor(start.secret))).rejects.toThrow(
      MfaStateError,
    );

    const f = await owner.query(`select * from mfa_factors where user_id = $1`, [userId]);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0].confirmed_at).not.toBeNull();
    const blob: Buffer = f.rows[0].secret_ciphertext;
    expect(blob.toString('latin1')).not.toContain(start.secret);
    expect(Buffer.from(blob).includes(base32Decode(start.secret))).toBe(false);
    const opened = await sealer.open(
      new Uint8Array(blob),
      f.rows[0].key_ref,
      `mfa:${f.rows[0].id}`,
    );
    expect(Buffer.from(opened)).toEqual(base32Decode(start.secret));
    const rc = await owner.query(`select code_hash from recovery_codes where user_id = $1`, [
      userId,
    ]);
    expect(rc.rows).toHaveLength(10);
    for (const r of rc.rows) expect(r.code_hash).toHaveLength(32);

    const auth = await s.auth();
    expect(auth).toMatchObject({ mfa: 'ok', mfaEnrolled: true, reauthFresh: true });
    await expect(startEnrolment(d, auth)).rejects.toMatchObject({ code: 'mfa_already_enrolled' });
    const status = await mfaStatus(d, auth);
    expect(status).toMatchObject({ enrolled: true, recoveryCodesLeft: 10, requiredBy: [] });
  });

  it('needs a fresh re-auth to start, and new codes invalidate the old ones', async () => {
    const userId = await member('regen@mfa.test', [TENANT_A]);
    const s = await signIn('regen@mfa.test');
    const { codes } = await enrol(s);
    const d = deps();
    const fresh = await regenerateRecoveryCodes(d, await s.auth());
    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => codes.includes(c))).toBe(false);
    await owner.query(
      `update sessions set reauth_at = now() - interval '11 minutes' where user_id = $1`,
      [userId],
    );
    await expect(regenerateRecoveryCodes(d, await s.auth())).rejects.toThrow(ReauthRequiredError);
    // An old code no longer re-authenticates; a new one does.
    await expect(
      reauthenticate(d, await s.auth(), { method: 'recovery', code: codes[0]! }),
    ).rejects.toThrow(MfaCodeError);
    await reauthenticate(d, await s.auth(), { method: 'recovery', code: fresh[0]! });
    expect((await s.auth()).reauthFresh).toBe(true);
  });

  it("sends the user's other sessions through the challenge (D7)", async () => {
    await member('other@mfa.test', [TENANT_A]);
    const a = await signIn('other@mfa.test');
    const b = await signIn('other@mfa.test');
    await enrol(a);
    expect((await a.auth()).mfa).toBe('ok');
    expect((await b.auth()).mfa).toBe('challenge');
  });
});

describe('the sign-in challenge (AC-2, AC-3)', () => {
  it('a new session must pass a code; the same code is refused the second time', async () => {
    await member('challenge@mfa.test', [TENANT_A]);
    const { secret } = await enrol(await signIn('challenge@mfa.test'));
    const s = await signIn('challenge@mfa.test');
    expect(s.next).toBe('mfa');
    expect((await s.auth()).mfa).toBe('challenge');
    tick();
    const code = codeFor(secret);
    const d = deps();
    await passChallenge(d, await s.auth(), { method: 'totp', code });
    expect((await s.auth()).mfa).toBe('ok');
    const again = await signIn('challenge@mfa.test');
    await expect(passChallenge(d, await again.auth(), { method: 'totp', code })).rejects.toThrow(
      MfaCodeError,
    );
  });

  it('five wrong codes lock it for 15 minutes across sign-ins; a recovery code passes once', async () => {
    const userId = await member('lock@mfa.test', [TENANT_A, TENANT_B]);
    const { secret, codes } = await enrol(await signIn('lock@mfa.test'));
    const s = await signIn('lock@mfa.test');
    const d = deps();
    tick();
    for (const left of [4, 3, 2, 1])
      await expect(
        passChallenge(d, await s.auth(), { method: 'totp', code: wrongFor(secret) }),
      ).rejects.toMatchObject({ attemptsLeft: left });
    const locked = passChallenge(d, await s.auth(), { method: 'totp', code: wrongFor(secret) });
    await expect(locked).rejects.toThrow(MfaLockedError);
    const until = ((await locked.catch((e: unknown) => e)) as MfaLockedError).until;
    expect(until.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    // The right code is refused while locked, on this session and a new one.
    await expect(
      passChallenge(d, await s.auth(), { method: 'totp', code: codeFor(secret) }),
    ).rejects.toThrow(MfaLockedError);
    const s2 = await signIn('lock@mfa.test');
    await expect(
      passChallenge(d, await s2.auth(), { method: 'totp', code: codeFor(secret) }),
    ).rejects.toThrow(MfaLockedError);
    expect((await mfaStatus(d, await s2.auth())).lockedUntil).not.toBeNull();
    // TOTP re-auth is locked too (AC-3), on a session that has passed the challenge.
    const opened = await signIn('lock@mfa.test');
    await owner.query(`update sessions set mfa_at = now() where id = $1`, [
      (await opened.auth()).sessionId,
    ]);
    await expect(
      reauthenticate(d, await opened.auth(), { method: 'totp', code: codeFor(secret) }),
    ).rejects.toThrow(MfaLockedError);

    await passChallenge(d, await s2.auth(), { method: 'recovery', code: codes[0]!.toUpperCase() });
    expect((await s2.auth()).mfa).toBe('ok');
    await expect(
      passChallenge(d, await s.auth(), { method: 'recovery', code: codes[0]! }),
    ).rejects.toThrow(MfaCodeError);

    // Audited once per workspace, IDs only; both chains hold (AC-7).
    for (const t of [TENANT_A, TENANT_B]) {
      const { rows } = await owner.query(
        `select event_type, payload from audit_entries
         where tenant_id = $1 and actor_ref = $2 order by seq`,
        [t, userId],
      );
      expect(rows.map((r) => r.event_type)).toEqual([
        'mfa.enrolled',
        'mfa.locked',
        'mfa.recovery_code_used',
      ]);
      for (const r of rows) expect(r.payload).toEqual({});
      expect((await verifyChain(tdb.zone('dashboard'), t)).ok).toBe(true);
    }
  });

  it('ten recovery codes in 15 minutes are refused with too_many_attempts', async () => {
    await member('rc@mfa.test', [TENANT_A]);
    await enrol(await signIn('rc@mfa.test'));
    const s = await signIn('rc@mfa.test');
    const d = deps();
    for (let i = 0; i < 10; i++)
      await expect(
        passChallenge(d, await s.auth(), { method: 'recovery', code: 'aaaaa-aaaaa' }),
      ).rejects.toThrow(MfaCodeError);
    await expect(
      passChallenge(d, await s.auth(), { method: 'recovery', code: 'aaaaa-aaaaa' }),
    ).rejects.toThrow(MfaRateLimitError);
  });
});

describe('workspace requirement (AC-4, AC-6)', () => {
  it("puts members without a factor into enrolment, and keeps the factor while it's required", async () => {
    const tenant = (
      await owner.query(
        `insert into tenants (slug, name, widget_key) values ('mfa-ws', 'Strict Shop', 'wk_mfa_ws')
         returning id`,
      )
    ).rows[0].id as string;
    await member('forced@mfa.test', [tenant]);
    const s = await signIn('forced@mfa.test');
    expect((await s.auth()).mfa).toBe('ok');
    await owner.query(`update tenants set mfa_required = true where id = $1`, [tenant]);
    expect((await s.auth()).mfa).toBe('enrol');
    expect((await signIn('forced@mfa.test')).next).toBe('mfa-enrol');

    await enrol(s);
    const auth = await s.auth();
    expect(auth.mfa).toBe('ok');
    const d = deps();
    expect((await mfaStatus(d, auth)).requiredBy).toEqual([
      { tenantId: tenant, name: 'Strict Shop' },
    ]);
    await expect(removeFactor(d, auth)).rejects.toMatchObject({
      code: 'mfa_required_by_workspace',
      workspaces: ['Strict Shop'],
    });

    await owner.query(`update tenants set mfa_required = false where id = $1`, [tenant]);
    await removeFactor(d, await s.auth());
    expect(await s.auth()).toMatchObject({ mfa: 'ok', mfaEnrolled: false });
    const { rows } = await owner.query(
      `select (select count(*)::int from mfa_factors where user_id = u.id) as f,
              (select count(*)::int from recovery_codes where user_id = u.id) as c
       from users u where email = 'forced@mfa.test'`,
    );
    expect(rows[0]).toEqual({ f: 0, c: 0 });
  });
});

describe('re-authentication (AC-5)', () => {
  it('refuses a stale session with the methods, and TOTP re-auth makes it fresh', async () => {
    const userId = await member('reauth@mfa.test', [TENANT_A]);
    const s = await signIn('reauth@mfa.test');
    const plain = await s.auth();
    expect(() => requireReauth(plain)).not.toThrow();
    await owner.query(
      `update sessions set reauth_at = now() - interval '11 minutes' where user_id = $1`,
      [userId],
    );
    let auth = await s.auth();
    expect(() => requireReauth(auth)).toThrow(expect.objectContaining({ methods: ['email'] }));
    expect(await reauthStatus(id(), auth)).toMatchObject({ fresh: false, until: null });

    await owner.query(`update sessions set reauth_at = now() where user_id = $1`, [userId]);
    const { secret } = await enrol(s);
    await owner.query(
      `update sessions set reauth_at = now() - interval '11 minutes' where user_id = $1`,
      [userId],
    );
    auth = await s.auth();
    expect(() => requireReauth(auth)).toThrow(
      expect.objectContaining({ methods: ['totp', 'recovery'] }),
    );
    tick();
    await reauthenticate(deps(), auth, { method: 'totp', code: codeFor(secret) });
    auth = await s.auth();
    expect(() => requireReauth(auth)).not.toThrow();
    expect((await reauthStatus(id(), auth)).fresh).toBe(true);
    await expect(requestReauthLink(id(), cfg, auth)).rejects.toMatchObject({
      code: 'use_authenticator',
    });
  });

  it('an emailed link counts only with its own session, and stays usable until then', async () => {
    const userId = await member('link@mfa.test', [TENANT_A]);
    const s = await signIn('link@mfa.test');
    const other = await signIn('link@mfa.test');
    await owner.query(
      `update sessions set reauth_at = now() - interval '11 minutes' where user_id = $1`,
      [userId],
    );
    const auth = await s.auth();
    const mailer = fakeMailer();
    const link = await requestReauthLink(id(), cfg, auth);
    await sendMagicLink(id(), mailer, cfg, link.id);
    expect(mailer.sent[0]!.subject).toBe('Confirm it’s you');
    const token = tokenIn(mailer.sent[0]!);

    for (const sessionId of [(await other.auth()).sessionId, null])
      await expect(consumeMagicLink(id(), token, sessionId)).rejects.toMatchObject({
        code: 'link_other_session',
      });
    await expect(consumeMagicLink(id(), token)).rejects.toThrow(LinkError);
    expect((await s.auth()).reauthFresh).toBe(false);

    expect(await consumeMagicLink(id(), token, auth.sessionId)).toEqual({
      next: 'reauthed',
      userId,
    });
    expect((await s.auth()).reauthFresh).toBe(true);
    expect((await other.auth()).reauthFresh).toBe(false);
    await expect(consumeMagicLink(id(), token, auth.sessionId)).rejects.toMatchObject({
      code: 'link_used',
    });
  });
});
