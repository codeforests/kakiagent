import { createHash } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit, AuditPayloadError, auditId, GENESIS_HASH, type AuditEntry } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = (action: string, over: Partial<AuditEntry> = {}): AuditEntry => ({
  action,
  actorType: 'user',
  actorId: U(9),
  subjectType: 'thing',
  subjectId: U(1),
  ...over,
});

/** An independent recomputation: sorted-key JSON, no shared code with the module. */
function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

async function rows(tenantId: string) {
  return (
    await owner.query(
      `select tenant_id, seq::int, ts, actor_type, actor_ref, event_type, subject_refs, payload,
              pii_ref, pii_commitment, prev_hash, hash
       from audit_entries where tenant_id = $1 order by seq`,
      [tenantId],
    )
  ).rows;
}

function recompute(r: Awaited<ReturnType<typeof rows>>[number]) {
  const input = sortedJson({
    tenantId: r.tenant_id,
    seq: r.seq,
    ts: (r.ts as Date).toISOString(),
    actorType: r.actor_type,
    actorRef: r.actor_ref,
    eventType: r.event_type,
    subjectRefs: r.subject_refs,
    payload: r.payload,
    piiRef: r.pii_ref,
    piiCommitment: r.pii_commitment,
    prevHash: r.prev_hash,
  });
  return createHash('sha256')
    .update(input + r.prev_hash)
    .digest('hex');
}

function expectChain(list: Awaited<ReturnType<typeof rows>>) {
  list.forEach((r, i) => {
    expect(r.seq).toBe(i + 1);
    expect(r.prev_hash).toBe(i === 0 ? GENESIS_HASH : list[i - 1]!.hash);
    expect(r.hash).toBe(recompute(r));
  });
}

describe('audit.append (AC-1, AC-2, AC-9)', () => {
  it('builds one gap-free, linked chain per tenant across interleaved transactions', async () => {
    const dash = tdb.zone('dashboard');
    const vis = tdb.zone('visitor');
    for (let i = 0; i < 3; i++) {
      await withTenant(dash, TENANT_A, (tx) =>
        audit.append(tx, TENANT_A, entry('fact.updated', { payload: { version: i + 1 } })),
      );
      await withTenant(vis, TENANT_B, (tx) =>
        audit.append(tx, TENANT_B, {
          action: 'message.received',
          actorType: 'visitor',
          actorId: U(7),
          subjectType: 'message',
          subjectId: U(10 + i),
          related: [{ type: 'conversation', id: U(5) }],
          payload: { factIds: [auditId(U(3))] },
        }),
      );
    }
    const a = await rows(TENANT_A);
    const b = await rows(TENANT_B);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    expectChain(a);
    expectChain(b);
    expect(b[0]!.subject_refs).toEqual([`message:${U(10)}`, `conversation:${U(5)}`]);
    expect(b[0]!.actor_type).toBe('visitor');
    expect(a[2]!.payload).toEqual({ version: 3 });
    const heads = (await owner.query(`select tenant_id, seq::int, hash from audit_heads`)).rows;
    expect(heads).toEqual(
      expect.arrayContaining([
        { tenant_id: TENANT_A, seq: 3, hash: a[2]!.hash },
        { tenant_id: TENANT_B, seq: 3, hash: b[2]!.hash },
      ]),
    );
  });

  it('serialises 20 concurrent appends to one tenant with no gap', async () => {
    const dash = tdb.zone('dashboard');
    const before = (await rows(TENANT_A)).length;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withTenant(dash, TENANT_A, (tx) =>
          audit.append(tx, TENANT_A, entry('test.concurrent', { payload: { i } })),
        ),
      ),
    );
    const a = await rows(TENANT_A);
    expect(a).toHaveLength(before + 20);
    expectChain(a);
  });

  it('a rolled-back transaction leaves no entry and no gap', async () => {
    const dash = tdb.zone('dashboard');
    const before = await rows(TENANT_A);
    await expect(
      withTenant(dash, TENANT_A, async (tx) => {
        await audit.append(tx, TENANT_A, entry('test.rolled_back'));
        throw new Error('the recorded action failed');
      }),
    ).rejects.toThrow('the recorded action failed');
    await withTenant(dash, TENANT_A, (tx) => audit.append(tx, TENANT_A, entry('test.after')));
    const a = await rows(TENANT_A);
    expect(a).toHaveLength(before.length + 1);
    expect(a.map((r) => r.event_type)).not.toContain('test.rolled_back');
    expectChain(a);
  });

  it("cannot append into another tenant's chain", async () => {
    await expect(
      withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
        audit.append(tx, TENANT_B, entry('test.cross', { actorType: 'system' })),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/row-level security|no chain head/) },
    });
  });

  it('rejects free text before writing anything (AC-7)', async () => {
    const before = (await rows(TENANT_A)).length;
    await expect(
      withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
        audit.append(tx, TENANT_A, entry('test.bad', { actorId: 'tan@example.com' })),
      ),
    ).rejects.toThrow(AuditPayloadError);
    expect(await rows(TENANT_A)).toHaveLength(before);
  });
});

describe('audit PII (AC-6)', () => {
  const contact = U(42);

  it('keeps personal data only in audit_pii, bound by a salted commitment', async () => {
    const vis = tdb.zone('visitor');
    await withTenant(vis, TENANT_B, (tx) =>
      audit.append(tx, TENANT_B, {
        action: 'consent.recorded',
        actorType: 'visitor',
        actorId: U(7),
        subjectType: 'contact',
        subjectId: contact,
        pii: {
          contactId: contact,
          data: { name: 'Tan Ah Kow', wording: 'I agree to be contacted' },
        },
      }),
    );
    const last = (await rows(TENANT_B)).at(-1)!;
    expect(last.pii_ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(last.pii_commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(last)).not.toMatch(/Tan Ah Kow|agree/);
    const pii = (
      await owner.query(`select contact_id, salt, data from audit_pii where id = $1`, [
        last.pii_ref,
      ])
    ).rows[0];
    expect(pii.contact_id).toBe(contact);
    expect(pii.data).toEqual({ name: 'Tan Ah Kow', wording: 'I agree to be contacted' });
    expect((pii.salt as Buffer).length).toBe(32);
    expect(JSON.stringify(last)).not.toContain((pii.salt as Buffer).toString('hex'));
  });

  it('erasure deletes the rows and salts and records the count', async () => {
    const dash = tdb.zone('dashboard');
    const out = await withTenant(dash, TENANT_B, (tx) =>
      audit.erasePii(tx, TENANT_B, { contactId: contact, actor: { type: 'user', id: U(9) } }),
    );
    expect(out).toEqual({ erased: 1 });
    const left = await owner.query(`select 1 from audit_pii where contact_id = $1`, [contact]);
    expect(left.rows).toEqual([]);
    const b = await rows(TENANT_B);
    expect(b.at(-1)).toMatchObject({
      event_type: 'audit.pii_erased',
      subject_refs: [`contact:${contact}`],
      payload: { count: 1 },
    });
    expectChain(b);
  });
});
