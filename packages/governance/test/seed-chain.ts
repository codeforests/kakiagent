import pg from 'pg';
import { entryHash, GENESIS_HASH } from '../src/index.js';

/** One entry to seed; anything left out gets a plain default. */
export interface SeedEntry {
  eventType: string;
  actorType?: 'agent' | 'user' | 'operator' | 'system' | 'visitor';
  actorRef?: string | null;
  subjectRefs?: string[];
  payload?: Record<string, unknown>;
  ts?: Date;
}

const COLS = [
  'tenant_id',
  'seq',
  'ts',
  'actor_type',
  'actor_ref',
  'event_type',
  'subject_refs',
  'payload',
  'pii_ref',
  'pii_commitment',
  'prev_hash',
  'hash',
] as const;
const BATCH = 1000;

/**
 * Extends a tenant's chain with valid entries built in JS (`entryHash`), inserted with
 * multi-row `INSERT`s as the test superuser (FEAT-060 §5.8). The link trigger checks each
 * row and moves `audit_heads`, so the result verifies like appended entries do.
 * Returns the seq of each seeded entry.
 */
export async function seedChain(
  owner: pg.Client,
  tenantId: string,
  entries: readonly SeedEntry[],
): Promise<number[]> {
  await owner.query(
    `insert into audit_heads (tenant_id, seq, hash) values ($1, 0, $2) on conflict (tenant_id) do nothing`,
    [tenantId, GENESIS_HASH],
  );
  const head = (
    await owner.query<{ seq: string; hash: string }>(
      `select seq, hash from audit_heads where tenant_id = $1`,
      [tenantId],
    )
  ).rows[0]!;
  let seq = Number(head.seq);
  let prevHash = head.hash;
  const seqs: number[] = [];
  const now = Date.now();
  for (let i = 0; i < entries.length; i += BATCH) {
    const values: unknown[] = [];
    const rows: string[] = [];
    for (const e of entries.slice(i, i + BATCH)) {
      seq += 1;
      const fields = {
        tenantId,
        seq,
        ts: (e.ts ?? new Date(now)).toISOString(),
        actorType: e.actorType ?? 'system',
        actorRef: e.actorRef ?? null,
        eventType: e.eventType,
        subjectRefs: e.subjectRefs ?? [`tenant:${tenantId}`],
        payload: e.payload ?? {},
        piiRef: null,
        piiCommitment: null,
        prevHash,
      };
      const hash = entryHash(fields);
      const base = values.length;
      rows.push(`(${COLS.map((_, k) => `$${base + k + 1}`).join(', ')})`);
      values.push(
        fields.tenantId,
        fields.seq,
        fields.ts,
        fields.actorType,
        fields.actorRef,
        fields.eventType,
        fields.subjectRefs,
        JSON.stringify(fields.payload),
        null,
        null,
        prevHash,
        hash,
      );
      prevHash = hash;
      seqs.push(seq);
    }
    // The link trigger reads `audit_heads` under RLS, so the batch needs the tenant context.
    await owner.query('begin');
    try {
      await owner.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      await owner.query(
        `insert into audit_entries (${COLS.join(', ')}) values ${rows.join(', ')}`,
        values,
      );
      await owner.query('commit');
    } catch (e) {
      await owner.query('rollback');
      throw e;
    }
  }
  return seqs;
}
