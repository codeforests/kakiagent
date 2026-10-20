import { describe, expect, it } from 'vitest';
import { entryHash, GENESIS_HASH, piiCommitment, type ChainEntry } from './chain.js';
import { ChainVerifier, type Anchor } from './verify.js';

const T = '00000000-0000-4000-8000-000000000001';

function chain(n: number): ChainEntry[] {
  const out: ChainEntry[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const e = {
      tenantId: T,
      seq,
      ts: new Date(Date.UTC(2026, 9, 19, 8, 0, seq)).toISOString(),
      actorType: 'user',
      actorRef: 'u1',
      eventType: 'test.event',
      subjectRefs: [`thing:t${seq}`],
      payload: { n: seq },
      piiRef: null,
      piiCommitment: null,
      prevHash: prev,
    };
    const hash = entryHash(e);
    out.push({ ...e, hash });
    prev = hash;
  }
  return out;
}

const rehash = (e: ChainEntry): ChainEntry => ({ ...e, hash: entryHash(e) });
const run = (entries: ChainEntry[], anchors: Anchor[] = [], opts = {}) => {
  const v = new ChainVerifier(T, anchors, opts);
  v.feed(entries.slice(0, 5));
  v.feed(entries.slice(5));
  return v.result();
};

describe('ChainVerifier (AC-4)', () => {
  it('accepts an intact chain, fed in pages', () => {
    const c = chain(12);
    expect(run(c, [{ seq: 6, hash: c[5]!.hash }])).toEqual({
      tenantId: T,
      ok: true,
      checked: 12,
      headSeq: 12,
      anchorsChecked: 1,
      piiChecked: 0,
    });
  });

  it('accepts an empty chain', () => {
    expect(run([])).toMatchObject({ ok: true, checked: 0, headSeq: 0 });
  });

  it.each([
    ['payload', (e: ChainEntry) => ({ ...e, payload: { n: 99 } })],
    ['actor', (e: ChainEntry) => ({ ...e, actorRef: 'u2' })],
    ['time', (e: ChainEntry) => ({ ...e, ts: '2020-01-01T00:00:00.000Z' })],
    ['event type', (e: ChainEntry) => ({ ...e, eventType: 'test.other' })],
  ])('reports the first entry whose %s changed', (_n, tamper) => {
    const c = chain(12);
    c[6] = tamper(c[6]!);
    c[9] = tamper(c[9]!);
    expect(run(c).broken).toEqual({ seq: 7, reason: 'hash_mismatch' });
  });

  it('reports a deleted middle entry at its seq', () => {
    const c = chain(12);
    c.splice(4, 1);
    expect(run(c).broken).toEqual({ seq: 5, reason: 'seq_gap' });
  });

  it('reports a swapped pair at the first of the two', () => {
    const c = chain(12);
    const a = c[3]!;
    const b = c[4]!;
    c[3] = { ...b, seq: 4 };
    c[4] = { ...a, seq: 5 };
    expect(run(c).broken).toEqual({ seq: 4, reason: 'link_mismatch' });
  });

  it('reports a re-hashed entry at the next link', () => {
    const c = chain(12);
    c[6] = rehash({ ...c[6]!, payload: { n: 99 } });
    expect(run(c).broken).toEqual({ seq: 8, reason: 'link_mismatch' });
  });

  it('reports a consistently rewritten chain at the anchored seq (AC-5)', () => {
    const original = chain(12);
    const anchors = [{ seq: 10, hash: original[9]!.hash }];
    const forged = chain(12).map((e) => e);
    // Rewrite from entry 3 on, re-hashing and re-linking every entry.
    for (let i = 2; i < forged.length; i++)
      forged[i] = rehash({
        ...forged[i]!,
        payload: { n: -i },
        prevHash: i === 0 ? GENESIS_HASH : forged[i - 1]!.hash,
      });
    expect(run(forged).ok).toBe(true);
    expect(run(forged, anchors).broken).toEqual({ seq: 10, reason: 'anchor_mismatch' });
  });

  it('reports a deleted tail through its anchor', () => {
    const c = chain(12);
    const anchors = [{ seq: 12, hash: c[11]!.hash }];
    expect(run(c.slice(0, 10), anchors).broken).toEqual({ seq: 11, reason: 'truncated' });
  });

  it('checks a range, taking its first link as given', () => {
    const c = chain(12);
    const v = new ChainVerifier(T, [{ seq: 2, hash: 'x' }], { fromSeq: 5, toSeq: 8 });
    v.feed(c.slice(4, 8));
    expect(v.result()).toMatchObject({ ok: true, checked: 4, headSeq: 8, anchorsChecked: 0 });
  });

  it('checks PII commitments while the rows exist (AC-6)', () => {
    const salt = Buffer.alloc(32, 7);
    const data = { name: 'Tan' };
    const c = chain(3);
    c[1] = rehash({ ...c[1]!, piiRef: 'p1', piiCommitment: piiCommitment(salt, data) });
    c[2] = rehash({ ...c[2]!, prevHash: c[1]!.hash });
    const ok = new ChainVerifier(T, []);
    ok.feed(c, new Map([['p1', { salt, data }]]));
    expect(ok.result()).toMatchObject({ ok: true, piiChecked: 1 });
    const erased = new ChainVerifier(T, []);
    erased.feed(c);
    expect(erased.result()).toMatchObject({ ok: true, piiChecked: 0 });
    const altered = new ChainVerifier(T, []);
    altered.feed(c, new Map([['p1', { salt, data: { name: 'Lim' } }]]));
    expect(altered.result().broken).toEqual({ seq: 2, reason: 'pii_commitment_mismatch' });
  });
});
