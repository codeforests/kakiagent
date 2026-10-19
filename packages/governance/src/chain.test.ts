import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { entryHash, GENESIS_HASH, hashInput, piiCommitment, type ChainEntry } from './chain.js';

const base: Omit<ChainEntry, 'hash'> = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  seq: 1,
  ts: '2026-10-19T08:00:00.123Z',
  actorType: 'user',
  actorRef: 'u1',
  eventType: 'fact.created',
  subjectRefs: ['fact:f1'],
  payload: { version: 1 },
  piiRef: null,
  piiCommitment: null,
  prevHash: GENESIS_HASH,
};

describe('entry hash (ADR-014 decision 1)', () => {
  it('is SHA-256 of the canonical fields followed by prev_hash', () => {
    const expected = createHash('sha256')
      .update(
        '{"actorRef":"u1","actorType":"user","eventType":"fact.created","payload":{"version":1},' +
          '"piiCommitment":null,"piiRef":null,"prevHash":"' +
          GENESIS_HASH +
          '","seq":1,"subjectRefs":["fact:f1"],"tenantId":"00000000-0000-4000-8000-000000000001",' +
          '"ts":"2026-10-19T08:00:00.123Z"}' +
          GENESIS_HASH,
      )
      .digest('hex');
    expect(entryHash(base)).toBe(expected);
  });

  it('is deterministic and ignores payload key order', () => {
    const a = { ...base, payload: { a: 1, b: [2, 3] } };
    const b = { ...base, payload: { b: [2, 3], a: 1 } };
    expect(entryHash(a)).toBe(entryHash(b));
    expect(hashInput(a)).toBe(hashInput(b));
  });

  it.each([
    ['seq', { seq: 2 }],
    ['ts', { ts: '2026-10-19T08:00:00.124Z' }],
    ['actor', { actorRef: 'u2' }],
    ['event', { eventType: 'fact.updated' }],
    ['subject', { subjectRefs: ['fact:f2'] }],
    ['payload', { payload: { version: 2 } }],
    ['prev hash', { prevHash: 'f'.repeat(64) }],
    ['tenant', { tenantId: '00000000-0000-4000-8000-000000000002' }],
  ])('changes when the %s changes', (_n, change) => {
    expect(entryHash({ ...base, ...change })).not.toBe(entryHash(base));
  });
});

describe('PII commitment', () => {
  it('depends on the salt and the data', () => {
    const s1 = Buffer.alloc(32, 1);
    const s2 = Buffer.alloc(32, 2);
    const c = piiCommitment(s1, { name: 'Tan' });
    expect(c).toMatch(/^[0-9a-f]{64}$/);
    expect(piiCommitment(s1, { name: 'Tan' })).toBe(c);
    expect(piiCommitment(s2, { name: 'Tan' })).not.toBe(c);
    expect(piiCommitment(s1, { name: 'Lim' })).not.toBe(c);
  });
});
