import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';

/** `prev_hash` of every tenant's first entry: the genesis head (seq 0). */
export const GENESIS_HASH = '0'.repeat(64);

/** The stored fields of an entry, as `append` writes them and `verify` reads them back. */
export interface ChainEntry {
  tenantId: string;
  seq: number;
  /** ISO 8601 with milliseconds and `Z` (the database clock, truncated to ms). */
  ts: string;
  actorType: string;
  actorRef: string | null;
  eventType: string;
  subjectRefs: string[];
  payload: unknown;
  piiRef: string | null;
  piiCommitment: string | null;
  prevHash: string;
  hash: string;
}

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Every field except `hash`, as one canonical object (ADR-014 decision 1). */
export function hashInput(e: Omit<ChainEntry, 'hash'>): string {
  return canonicalJson({
    tenantId: e.tenantId,
    seq: e.seq,
    ts: e.ts,
    actorType: e.actorType,
    actorRef: e.actorRef,
    eventType: e.eventType,
    subjectRefs: e.subjectRefs,
    payload: e.payload,
    piiRef: e.piiRef,
    piiCommitment: e.piiCommitment,
    prevHash: e.prevHash,
  });
}

/** `SHA-256(canonical_json(all fields except hash) ‖ prev_hash)`, lowercase hex. */
export function entryHash(e: Omit<ChainEntry, 'hash'>): string {
  return sha256hex(hashInput(e) + e.prevHash);
}

/** `SHA-256(salt ‖ canonical(data))`: binds the entry to its PII row without revealing it. */
export function piiCommitment(salt: Buffer, data: unknown): string {
  return sha256hex(Buffer.concat([salt, Buffer.from(canonicalJson(data), 'utf8')]));
}
