import { sql, withTenant, type ZoneDb } from '@kaki/db';
import { entryHash, GENESIS_HASH, piiCommitment, type ChainEntry } from './chain.js';

export type BreakReason =
  | 'hash_mismatch'
  | 'link_mismatch'
  | 'seq_gap'
  | 'anchor_mismatch'
  | 'truncated'
  | 'pii_commitment_mismatch';

export interface VerifyResult {
  tenantId: string;
  ok: boolean;
  /** Entries recomputed. */
  checked: number;
  /** The last `seq` read (0 when the range is empty). */
  headSeq: number;
  anchorsChecked: number;
  /** PII commitments recomputed (rows still present; erased rows are skipped). */
  piiChecked: number;
  /** The first broken entry. A `link_mismatch` at n means entry n − 1 or n was altered. */
  broken?: { seq: number; reason: BreakReason };
}

export interface Anchor {
  seq: number;
  hash: string;
}

export interface PiiRow {
  salt: Buffer;
  data: unknown;
}

/**
 * The pure core of verification (ADR-014 decision 6): fed entries in `seq` order, page
 * by page, it recomputes each hash, checks `seq` continuity and the `prev_hash` link,
 * recomputes the commitment of PII rows that still exist, and finally compares anchors.
 */
export class ChainVerifier {
  private expectedSeq: number;
  private prevHash: string | null;
  private readonly anchorSeqs: Set<number>;
  private readonly hashAt = new Map<number, string>();
  private entryBreak: VerifyResult['broken'];
  private checked = 0;
  private piiChecked = 0;
  private lastSeq = 0;

  constructor(
    private readonly tenantId: string,
    private readonly anchors: Anchor[],
    opts: { fromSeq?: number | undefined; toSeq?: number | undefined } = {},
  ) {
    const from = opts.fromSeq ?? 1;
    this.expectedSeq = from;
    // A range that starts mid-chain takes its first link as given.
    this.prevHash = from === 1 ? GENESIS_HASH : null;
    this.lastSeq = from - 1;
    const to = opts.toSeq ?? Number.POSITIVE_INFINITY;
    this.anchors = anchors.filter((a) => a.seq >= from && a.seq <= to);
    this.anchorSeqs = new Set(this.anchors.map((a) => a.seq));
  }

  /** False once a break is found: later entries can't change the first broken `seq`. */
  feed(entries: readonly ChainEntry[], pii: ReadonlyMap<string, PiiRow> = new Map()): boolean {
    for (const e of entries) {
      if (this.entryBreak) return false;
      if (e.seq !== this.expectedSeq) {
        this.entryBreak = { seq: this.expectedSeq, reason: 'seq_gap' };
        return false;
      }
      if (this.prevHash !== null && e.prevHash !== this.prevHash) {
        this.entryBreak = { seq: e.seq, reason: 'link_mismatch' };
        return false;
      }
      if (entryHash(e) !== e.hash) {
        this.entryBreak = { seq: e.seq, reason: 'hash_mismatch' };
        return false;
      }
      if (e.piiRef) {
        const row = pii.get(e.piiRef);
        if (row) {
          this.piiChecked++;
          if (piiCommitment(row.salt, row.data) !== e.piiCommitment) {
            this.entryBreak = { seq: e.seq, reason: 'pii_commitment_mismatch' };
            return false;
          }
        }
      }
      if (this.anchorSeqs.has(e.seq)) this.hashAt.set(e.seq, e.hash);
      this.checked++;
      this.lastSeq = e.seq;
      this.prevHash = e.hash;
      this.expectedSeq = e.seq + 1;
    }
    return true;
  }

  result(): VerifyResult {
    const breaks: NonNullable<VerifyResult['broken']>[] = [];
    if (this.entryBreak) breaks.push(this.entryBreak);
    let anchorsChecked = 0;
    for (const a of this.anchors) {
      if (this.entryBreak && a.seq >= this.entryBreak.seq) continue;
      anchorsChecked++;
      if (a.seq > this.lastSeq) breaks.push({ seq: this.lastSeq + 1, reason: 'truncated' });
      else if (this.hashAt.get(a.seq) !== a.hash)
        breaks.push({ seq: a.seq, reason: 'anchor_mismatch' });
    }
    breaks.sort((x, y) => x.seq - y.seq);
    return {
      tenantId: this.tenantId,
      ok: breaks.length === 0,
      checked: this.checked,
      headSeq: this.lastSeq,
      anchorsChecked,
      piiChecked: this.piiChecked,
      ...(breaks[0] ? { broken: breaks[0] } : {}),
    };
  }
}

/** Where anchors are read from (`anchors.ts` has the S3 implementation). */
export interface AnchorSource {
  list(tenantId: string): Promise<Anchor[]>;
}

interface EntryRow extends Record<string, unknown> {
  tenant_id: string;
  seq: string | number;
  ts: Date | string;
  actor_type: string;
  actor_ref: string | null;
  event_type: string;
  subject_refs: string[];
  payload: unknown;
  pii_ref: string | null;
  pii_commitment: string | null;
  prev_hash: string;
  hash: string;
}

const PAGE = 1000;

/**
 * Verifies a tenant's chain from the database (dashboard trust zone, tenant context)
 * and, when given, its S3 anchors. Reads in one transaction, page by page.
 */
export async function verifyChain(
  zdb: ZoneDb,
  tenantId: string,
  opts: { anchors?: AnchorSource | undefined; fromSeq?: number; toSeq?: number } = {},
): Promise<VerifyResult> {
  const anchors = opts.anchors ? await opts.anchors.list(tenantId) : [];
  const v = new ChainVerifier(tenantId, anchors, opts);
  const to = opts.toSeq ?? Number.MAX_SAFE_INTEGER;
  await withTenant(zdb, tenantId, async (tx) => {
    let after = (opts.fromSeq ?? 1) - 1;
    for (;;) {
      const { rows } = await tx.execute<EntryRow>(sql`
        select tenant_id, seq, ts, actor_type, actor_ref, event_type, subject_refs, payload,
               pii_ref, pii_commitment, prev_hash, hash
        from audit_entries
        where tenant_id = ${tenantId} and seq > ${after} and seq <= ${to}
        order by seq limit ${PAGE}`);
      if (rows.length === 0) break;
      const refs = rows.map((r) => r.pii_ref).filter((r): r is string => r !== null);
      const pii = new Map<string, PiiRow>();
      if (refs.length) {
        const found = await tx.execute<{ id: string; salt: Buffer; data: unknown }>(sql`
          select id, salt, data from audit_pii
          where tenant_id = ${tenantId} and id in ${refs}`);
        for (const r of found.rows) pii.set(r.id, { salt: r.salt, data: r.data });
      }
      const more = v.feed(rows.map(toEntry), pii);
      after = Number(rows.at(-1)!.seq);
      if (!more || rows.length < PAGE) break;
    }
  });
  return v.result();
}

function toEntry(r: EntryRow): ChainEntry {
  return {
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    ts: new Date(r.ts).toISOString(),
    actorType: r.actor_type,
    actorRef: r.actor_ref,
    eventType: r.event_type,
    subjectRefs: r.subject_refs,
    payload: r.payload,
    piiRef: r.pii_ref,
    piiCommitment: r.pii_commitment,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}
