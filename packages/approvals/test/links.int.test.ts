/**
 * Opening signed approval links on the real schema (APR-03; UC-22 5, 5b; ADR-013 §5; FEAT-056
 * §5.1; AC-3, AC-5, AC-6, AC-8): the nonce stored once, one code-only audit entry, the race,
 * wrong account, deactivated members, the workspace switch, and the lazy expiry sweep.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { createConversation } from '@kaki/inbox';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPROVAL_LINK_TTL_S,
  ApprovalLinkError,
  approvalLinkKey,
  openApprovalLink,
  signApprovalLink,
  type LinkOpener,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const key = approvalLinkKey('magic-link-secret-for-tests');
const RECIPIENT = '00000000-0000-4000-8000-0000000056a1';
const OTHER = '00000000-0000-4000-8000-0000000056a2';
const LEFT = '00000000-0000-4000-8000-0000000056a3';
const now = new Date();

async function addMember(id: string, tenants: string[], status = 'active') {
  await owner.query(`insert into users (id, email) values ($1, $2)`, [id, `${id}@test.test`]);
  for (const t of tenants)
    await owner.query(
      `insert into memberships (tenant_id, user_id, role, status) values ($1, $2, 'owner', $3)`,
      [t, id, status],
    );
}
async function sessionOf(userId: string, activeTenantId: string): Promise<LinkOpener> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into sessions (user_id, token_hash, auth_method, expires_at, active_tenant_id)
     values ($1, sha256(random()::text::bytea), 'magic_link', now() + interval '1 day', $2) returning id`,
    [userId, activeTenantId],
  );
  return { sessionId: rows[0]!.id, userId, activeTenantId };
}
async function approval(tenantId = TENANT_A): Promise<string> {
  const conv = await withTenant(tdb.zone('visitor'), tenantId, (tx) =>
    createConversation(tx, tenantId, randomUUID()),
  );
  const { rows } = await owner.query<{ id: string }>(
    `insert into approvals (tenant_id, conversation_id, kind, request, draft, prices, sla_due_at, expires_at)
     values ($1, $2, 'quote', '{}', '{}', '[]', now() + interval '2 hours', now() + interval '7 days') returning id`,
    [tenantId, conv.id],
  );
  return rows[0]!.id;
}
const deps = () => ({ dashboardDb: tdb.zone('dashboard'), idDb: tdb.zone('identity'), key });
const open = (who: LinkOpener, token: string, at = now) => openApprovalLink(deps(), who, token, at);
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof ApprovalLinkError ? e.code : String(e)),
  );
const nonces = async (approvalId: string) =>
  (
    await owner.query<{ user_id: string }>(
      `select user_id from used_link_nonces where approval_id = $1`,
      [approvalId],
    )
  ).rows;
const audits = async (approvalId: string) =>
  (
    await owner.query<{ event_type: string; actor_ref: string; payload: Record<string, unknown> }>(
      `select event_type, actor_ref, payload from audit_entries
       where event_type = 'approval.link_opened' and subject_refs @> array[$1]::text[]`,
      [`approval:${approvalId}`],
    )
  ).rows;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await addMember(RECIPIENT, [TENANT_A, TENANT_B]);
  await addMember(OTHER, [TENANT_A]);
  await addMember(LEFT, [TENANT_A], 'deactivated');
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('opening an approval link (AC-3, AC-5, AC-6, AC-8)', () => {
  it('the recipient opens it once: one nonce row, one code-only audit entry; again is used', async () => {
    const a = await approval();
    const token = signApprovalLink(
      key,
      { tenantId: TENANT_A, approvalId: a, userId: RECIPIENT },
      now,
    );
    const who = await sessionOf(RECIPIENT, TENANT_A);
    await expect(open(who, token)).resolves.toEqual({
      state: 'opened',
      approvalId: a,
      switched: false,
    });
    expect(await nonces(a)).toEqual([{ user_id: RECIPIENT }]);
    const entries = await audits(a);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.payload).toEqual({ approvalId: a });
    expect(JSON.stringify(entries[0])).not.toContain(token.split('.')[0]!.slice(0, 20));
    expect(await codeOf(open(who, token))).toBe('link_used');
    expect(await codeOf(open(null, token))).toBe('link_used');
    expect(await audits(a)).toHaveLength(1);
  });

  it('of two concurrent opens exactly one is opened', async () => {
    const a = await approval();
    const token = signApprovalLink(
      key,
      { tenantId: TENANT_A, approvalId: a, userId: RECIPIENT },
      now,
    );
    const who = await sessionOf(RECIPIENT, TENANT_A);
    const results = await Promise.all([codeOf(open(who, token)), codeOf(open(who, token))]);
    expect(results.sort()).toEqual(['link_used', 'resolved']);
    expect(await nonces(a)).toHaveLength(1);
    expect(await audits(a)).toHaveLength(1);
  });

  it('no session or a two-step owed answers a state and stores nothing', async () => {
    const a = await approval();
    const token = signApprovalLink(
      key,
      { tenantId: TENANT_A, approvalId: a, userId: RECIPIENT },
      now,
    );
    await expect(open(null, token)).resolves.toEqual({ state: 'sign_in' });
    await expect(open('two_step', token)).resolves.toEqual({ state: 'two_step' });
    await expect(open('two_step_setup', token)).resolves.toEqual({ state: 'two_step_setup' });
    expect(await nonces(a)).toEqual([]);
  });

  it('another member is wrong_account and consumes nothing; the recipient then opens it', async () => {
    const a = await approval();
    const token = signApprovalLink(
      key,
      { tenantId: TENANT_A, approvalId: a, userId: RECIPIENT },
      now,
    );
    expect(await codeOf(open(await sessionOf(OTHER, TENANT_A), token))).toBe('wrong_account');
    expect(await nonces(a)).toEqual([]);
    expect(await audits(a)).toEqual([]);
    await expect(open(await sessionOf(RECIPIENT, TENANT_A), token)).resolves.toMatchObject({
      state: 'opened',
    });
  });

  it('a deactivated recipient is not_member', async () => {
    const a = await approval();
    const token = signApprovalLink(key, { tenantId: TENANT_A, approvalId: a, userId: LEFT }, now);
    const who = { sessionId: randomUUID(), userId: LEFT, activeTenantId: null };
    expect(await codeOf(open(who, token))).toBe('not_member');
    expect(await nonces(a)).toEqual([]);
  });

  it('a recipient on another workspace is switched to the approval’s business', async () => {
    const a = await approval(TENANT_B);
    const token = signApprovalLink(
      key,
      { tenantId: TENANT_B, approvalId: a, userId: RECIPIENT },
      now,
    );
    const who = await sessionOf(RECIPIENT, TENANT_A);
    await expect(open(who, token)).resolves.toEqual({
      state: 'opened',
      approvalId: a,
      switched: true,
    });
    const { rows } = await owner.query(`select active_tenant_id from sessions where id = $1`, [
      (who as { sessionId: string }).sessionId,
    ]);
    expect(rows[0].active_tenant_id).toBe(TENANT_B);
  });

  it('expired and invalid tokens are refused before sign-in; expired nonce rows are swept', async () => {
    const a = await approval();
    const old = new Date(now.getTime() - (APPROVAL_LINK_TTL_S + 60) * 1000);
    const stale = signApprovalLink(
      key,
      { tenantId: TENANT_A, approvalId: a, userId: RECIPIENT },
      old,
    );
    expect(await codeOf(open(null, stale))).toBe('link_expired');
    expect(await codeOf(open(null, stale + 'x'))).toBe('link_invalid');
    const other = signApprovalLink(
      approvalLinkKey('another-secret'),
      { tenantId: TENANT_A, approvalId: a, userId: RECIPIENT },
      now,
    );
    expect(await codeOf(open(null, other))).toBe('link_invalid');

    // A nonce used by a link that has since expired is deleted by the next open in that tenant.
    await owner.query(
      `insert into used_link_nonces (tenant_id, nonce, approval_id, user_id, expires_at)
       values ($1, 'expired-nonce-0001', $2, $3, now() - interval '1 minute')`,
      [TENANT_A, a, RECIPIENT],
    );
    const fresh = signApprovalLink(
      key,
      { tenantId: TENANT_A, approvalId: a, userId: RECIPIENT },
      now,
    );
    await open(null, fresh);
    const { rows } = await owner.query(
      `select 1 from used_link_nonces where nonce = 'expired-nonce-0001'`,
    );
    expect(rows).toEqual([]);
  });
});
