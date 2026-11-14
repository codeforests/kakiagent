import type { AuditQuery } from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit, auditCount, auditEntry, listAudit, verifyChain } from '../src/index.js';
import { seedChain, type SeedEntry } from './seed-chain.js';

let tdb: TestDatabase;
let owner: pg.Client;
const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000a2';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const CONTACT = '00000000-0000-4000-8000-000000000043';
const seqOf: Record<string, number> = {};

const NAMED: [string, SeedEntry][] = [
  // 23:59 SGT on 2026-11-09
  [
    'lastMinute',
    {
      eventType: 'conversation.closed',
      actorType: 'user',
      actorRef: U1,
      subjectRefs: [`conversation:${C1}`],
      ts: new Date('2026-11-09T15:59:00Z'),
    },
  ],
  // 00:00 SGT on 2026-11-10
  [
    'midnight',
    {
      eventType: 'fact.updated',
      actorType: 'user',
      actorRef: U2,
      subjectRefs: ['fact:f1'],
      ts: new Date('2026-11-09T16:00:00Z'),
    },
  ],
  [
    'agentTurn',
    {
      eventType: 'agent.decision',
      actorType: 'agent',
      subjectRefs: ['turn:t1', `conversation:${C2}`],
      ts: new Date('2026-11-08T03:00:00Z'),
    },
  ],
  ['mystery', { eventType: 'mystery.event', ts: new Date('2026-11-08T04:00:00Z') }],
  [
    'source',
    {
      eventType: 'kb_source.added',
      actorType: 'user',
      actorRef: U1,
      ts: new Date('2026-11-08T05:00:00Z'),
    },
  ],
  // `_` in a like pattern must not match any character.
  ['lookalike', { eventType: 'kbxsource.added', ts: new Date('2026-11-08T06:00:00Z') }],
];

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await owner.query(`insert into contacts (tenant_id, id, name) values ($1, $2, 'Tan Ah Kow')`, [
    TENANT_A,
    CONTACT,
  ]);
  const seqs = await seedChain(
    owner,
    TENANT_A,
    NAMED.map(([, e]) => e),
  );
  NAMED.forEach(([k], i) => (seqOf[k] = seqs[i]!));
  seqOf.withPii = (
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      audit.append(tx, TENANT_A, {
        action: 'consent.recorded',
        actorType: 'visitor',
        subjectType: 'contact',
        subjectId: CONTACT,
        pii: { contactId: CONTACT, data: { name: 'Tan Ah Kow' } },
      }),
    )
  ).seq;
  await seedChain(owner, TENANT_B, [
    { eventType: 'conversation.closed', subjectRefs: [`conversation:${C1}`] },
  ]);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const q = (over: Partial<AuditQuery> = {}): AuditQuery => ({ limit: 50, ...over });
const inA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tdb.zone('dashboard'), TENANT_A, fn);
const seqsFor = (over: Partial<AuditQuery>) =>
  inA(async (tx) => {
    const { records } = await listAudit(tx, TENANT_A, q(over));
    expect(await auditCount(tx, TENANT_A, q(over))).toBe(records.length);
    return records.map((r) => r.seq);
  });

describe('listAudit (FEAT-060 AC-1)', () => {
  it('is newest first and pages by seq', async () => {
    const all = await seqsFor({});
    expect(all).toEqual([...all].sort((a, b) => b - a));
    expect(all.length).toBe(7);
    const p1 = await inA((tx) => listAudit(tx, TENANT_A, q({ limit: 3 })));
    expect(p1.records.map((r) => r.seq)).toEqual(all.slice(0, 3));
    expect(p1.next).toBe(all[2]);
    const last = await inA((tx) => listAudit(tx, TENANT_A, q({ limit: 3, before: all[5]! })));
    expect(last.records.map((r) => r.seq)).toEqual(all.slice(6));
    expect(last.next).toBeNull();
  });

  it('date bounds are SGT days, inclusive', async () => {
    expect(await seqsFor({ from: '2026-11-09', to: '2026-11-09' })).toEqual([seqOf.lastMinute]);
    expect(await seqsFor({ from: '2026-11-10', to: '2026-11-10' })).toEqual([seqOf.midnight]);
    expect(await seqsFor({ to: '2026-11-08' })).toEqual([
      seqOf.lookalike,
      seqOf.source,
      seqOf.mystery,
      seqOf.agentTurn,
    ]);
  });

  it('filters by conversation, actor type, member and group, and they combine', async () => {
    expect(await seqsFor({ conversation: C1 })).toEqual([seqOf.lastMinute]);
    expect(await seqsFor({ conversation: C2 })).toEqual([seqOf.agentTurn]);
    expect(await seqsFor({ actorType: 'agent' })).toEqual([seqOf.agentTurn]);
    expect(await seqsFor({ actorType: 'user', actor: U1 })).toEqual([
      seqOf.source,
      seqOf.lastMinute,
    ]);
    expect(await seqsFor({ actor: U2 })).toEqual([seqOf.midnight]);
    expect(await seqsFor({ group: 'knowledge' })).toEqual([seqOf.source, seqOf.midnight]);
    expect(await seqsFor({ group: 'other' })).toEqual([seqOf.lookalike, seqOf.mystery]);
    expect(await seqsFor({ group: 'contacts' })).toEqual([seqOf.withPii]);
    expect(await seqsFor({ group: 'knowledge', actor: U1, to: '2026-11-08' })).toEqual([
      seqOf.source,
    ]);
    expect(await seqsFor({ group: 'conversations', from: '2026-11-10' })).toEqual([]);
  });
});

describe('personal data state (FEAT-060 AC-2, D5)', () => {
  it('is none, kept, then erased after erasePii; the data itself is never read', async () => {
    const at = (seq: number) => inA((tx) => auditEntry(tx, TENANT_A, seq));
    expect((await at(seqOf.mystery!))!.pii).toBe('none');
    const kept = (await at(seqOf.withPii!))!;
    expect(kept.pii).toBe('kept');
    expect(JSON.stringify(kept)).not.toContain('Tan Ah Kow');
    await inA((tx) =>
      audit.erasePii(tx, TENANT_A, { contactId: CONTACT, actor: { type: 'system' } }),
    );
    expect((await at(seqOf.withPii!))!.pii).toBe('erased');
    expect(await at(9999)).toBeNull();
  });

  it('seeded entries form a valid chain', async () => {
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
  });
});

describe('tenant isolation (FEAT-060 AC-1)', () => {
  it("tenant B's context sees none of tenant A's entries", async () => {
    const leaked = await withTenant(tdb.zone('dashboard'), TENANT_B, async (tx) => ({
      list: (await listAudit(tx, TENANT_A, q())).records.length,
      one: await auditEntry(tx, TENANT_A, seqOf.lastMinute!),
      count: await auditCount(tx, TENANT_A, q()),
    }));
    expect(leaked).toEqual({ list: 0, one: null, count: 0 });
    const own = await withTenant(tdb.zone('dashboard'), TENANT_B, (tx) =>
      listAudit(tx, TENANT_B, q()),
    );
    expect(own.records.map((r) => r.tenantId)).toEqual([TENANT_B]);
  });
});
