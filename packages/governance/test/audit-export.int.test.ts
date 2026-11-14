import type { AuditFilter } from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCsv,
  auditExported,
  auditJson,
  entryHash,
  exportAudit,
  TooManyAuditEntries,
  verifyChain,
} from '../src/index.js';
import { seedChain, type SeedEntry } from './seed-chain.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = '00000000-0000-4000-8000-0000000000a1';
const C1 = '00000000-0000-4000-8000-0000000000c1';

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await seedChain(owner, TENANT_A, [
    {
      eventType: 'message.sent',
      subjectRefs: ['message:m1', `conversation:${C1}`],
      ts: new Date('2026-11-01T02:00:00Z'),
    },
    { eventType: 'fact.updated', subjectRefs: ['fact:f1'], ts: new Date('2026-11-02T02:00:00Z') },
    {
      eventType: 'agent.decision',
      subjectRefs: ['turn:t1', `conversation:${C1}`],
      ts: new Date('2026-11-03T02:00:00Z'),
    },
    {
      eventType: 'fact.updated',
      actorRef: '+cmd',
      subjectRefs: ['fact:f2'],
      ts: new Date('2026-11-04T02:00:00Z'),
    },
  ]);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const inA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tdb.zone('dashboard'), TENANT_A, fn);
const exported = (filter: AuditFilter, max?: number) =>
  inA((tx) => exportAudit(tx, TENANT_A, filter, max === undefined ? {} : { max }));

describe('exportAudit (FEAT-060 AC-4)', () => {
  it('holds exactly the filtered entries, oldest first: conversation and date range', async () => {
    const conv = await exported({ conversation: C1 });
    expect(conv.records.map((r) => r.eventType)).toEqual(['message.sent', 'agent.decision']);
    const days = await exported({ from: '2026-11-02', to: '2026-11-03' });
    expect(days.records.map((r) => r.eventType)).toEqual(['fact.updated', 'agent.decision']);
    expect(days.count).toBe(2);
    const json = JSON.parse(
      auditJson(days.records, {
        tenantId: TENANT_A,
        exportedAt: new Date().toISOString(),
        filters: {},
      }),
    );
    for (const e of json.entries)
      expect(
        entryHash({
          tenantId: e.tenant_id,
          seq: e.seq,
          ts: e.ts,
          actorType: e.actor_type,
          actorRef: e.actor_ref,
          eventType: e.event_type,
          subjectRefs: e.subject_refs,
          payload: e.payload,
          piiRef: e.pii_ref,
          piiCommitment: e.pii_commitment,
          prevHash: e.prev_hash,
        }),
      ).toBe(e.hash);
    // A cell a spreadsheet would run as a formula is prefixed.
    expect(auditCsv((await exported({})).records)).toContain(`,'+cmd,`);
  });

  it('leaves out entries appended while the export runs', async () => {
    let appended = false;
    const res = await inA(async (tx) => {
      const spy = new Proxy(tx, {
        get(t, p, r) {
          if (p !== 'execute') return Reflect.get(t, p, r);
          return async (...args: Parameters<Tx['execute']>) => {
            const out = await t.execute(...args);
            if (!appended) {
              appended = true;
              await seedChain(owner, TENANT_A, [{ eventType: 'late.entry' }]);
            }
            return out;
          };
        },
      });
      return exportAudit(spy, TENANT_A, {});
    });
    expect(appended).toBe(true);
    expect(res.records.some((r) => r.eventType === 'late.entry')).toBe(false);
    expect(res.count).toBe(res.records.length);
    expect((await exported({})).records.some((r) => r.eventType === 'late.entry')).toBe(true);
  });

  it('refuses above the cap with the count', async () => {
    await expect(exported({}, 2)).rejects.toBeInstanceOf(TooManyAuditEntries);
    await expect(exported({ conversation: C1 }, 2)).resolves.toMatchObject({ count: 2 });
  });

  it('records one audit.exported with IDs and codes only, after the snapshot', async () => {
    const res = await inA(async (tx) => {
      const r = await exportAudit(tx, TENANT_A, { conversation: C1, from: '2026-11-01' });
      await auditExported(tx, TENANT_A, {
        userId: USER,
        format: 'csv',
        count: r.count,
        filter: { conversation: C1, from: '2026-11-01' },
      });
      return r;
    });
    expect(res.records.some((r) => r.eventType === 'audit.exported')).toBe(false);
    const rows = (
      await owner.query(
        `select actor_ref, payload, pii_ref from audit_entries where tenant_id = $1 and event_type = 'audit.exported'`,
        [TENANT_A],
      )
    ).rows;
    expect(rows).toEqual([
      {
        actor_ref: USER,
        pii_ref: null,
        payload: { format: 'csv', count: 2, from: '2026-11-01', conversation_id: C1 },
      },
    ]);
  });
});

describe('30 days at launch volume (FEAT-060 AC-5, GOV-02)', () => {
  it('75,000 entries export as CSV and JSON in under a minute each and verify', async () => {
    const N = 75_000;
    const start = Date.parse('2026-10-01T00:00:00Z');
    const step = (30 * 24 * 3600 * 1000) / N;
    const types = ['message.sent', 'agent.decision', 'fact.updated', 'conversation.closed'];
    const entries: SeedEntry[] = Array.from({ length: N }, (_, i) => ({
      eventType: types[i % types.length]!,
      actorType: 'agent',
      subjectRefs: [`message:${i}`, `conversation:${C1}`],
      payload: { outcome: 'answered', facts: [i, i + 1], model: 'haiku', tokens: 812 },
      ts: new Date(start + i * step),
    }));
    const t0 = Date.now();
    await seedChain(owner, TENANT_B, entries);
    const seedMs = Date.now() - t0;
    const filter = { from: '2026-10-01', to: '2026-10-30' };
    const inB = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tdb.zone('dashboard'), TENANT_B, fn);

    const t1 = Date.now();
    const csv = await inB(async (tx) =>
      auditCsv((await exportAudit(tx, TENANT_B, filter)).records),
    );
    const csvMs = Date.now() - t1;
    const t2 = Date.now();
    const json = await inB(async (tx) =>
      auditJson((await exportAudit(tx, TENANT_B, filter)).records, {
        tenantId: TENANT_B,
        exportedAt: new Date().toISOString(),
        filters: filter,
      }),
    );
    const jsonMs = Date.now() - t2;
    const t3 = Date.now();
    const v = await verifyChain(tdb.zone('dashboard'), TENANT_B);
    const verifyMs = Date.now() - t3;
    console.warn(
      `FEAT-060 perf: seed ${seedMs} ms, csv ${csvMs} ms (${(csv.length / 1e6).toFixed(1)} MB), json ${jsonMs} ms (${(json.length / 1e6).toFixed(1)} MB), verify ${verifyMs} ms`,
    );
    expect(csv.split('\r\n').length - 2).toBeGreaterThan(70_000);
    expect(JSON.parse(json).count).toBeGreaterThan(70_000);
    expect(v).toMatchObject({ ok: true, checked: N });
    expect(csvMs).toBeLessThan(60_000);
    expect(jsonMs).toBeLessThan(60_000);
    expect(verifyMs).toBeLessThan(60_000);
  }, 600_000);
});
