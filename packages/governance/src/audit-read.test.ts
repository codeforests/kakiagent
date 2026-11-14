import { describe, expect, it } from 'vitest';
import { actorIdsOf, toAuditRow, type AuditRecord } from './audit-read.js';

const U = '8d0f6a3e-4b7a-4c1e-9f0a-2b3c4d5e6f70';
const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  tenantId: 't',
  seq: 7,
  ts: '2026-11-14T01:00:00.000Z',
  actorType: 'user',
  actorRef: U,
  eventType: 'ai.paused',
  subjectRefs: ['tenant:t', 'conversation:abc', 'url:https://x.test/a:b'],
  payload: { n: 1 },
  piiRef: null,
  piiCommitment: null,
  prevHash: 'a'.repeat(64),
  hash: 'b'.repeat(64),
  pii: 'none',
  ...over,
});

describe('toAuditRow (FEAT-060 §5.1)', () => {
  it('splits subjects at the first colon, groups the code and names current members', () => {
    const row = toAuditRow(rec(), new Map([[U, 'Mei']]));
    expect(row.subjects).toEqual([
      { type: 'tenant', id: 't' },
      { type: 'conversation', id: 'abc' },
      { type: 'url', id: 'https://x.test/a:b' },
    ]);
    expect(row.group).toBe('assistant');
    expect(row.actorName).toBe('Mei');
    expect(row.actorId).toBe(U);
    expect(row.pii).toBe('none');
  });
  it('a former member or a non-user actor has no name', () => {
    expect(toAuditRow(rec()).actorName).toBeNull();
    expect(
      toAuditRow(rec({ actorType: 'agent', actorRef: U }), new Map([[U, 'Mei']])).actorName,
    ).toBeNull();
  });
  it('keeps the pii state and lists user actors once', () => {
    expect(toAuditRow(rec({ pii: 'erased' })).pii).toBe('erased');
    expect(actorIdsOf([rec(), rec(), rec({ actorType: 'system', actorRef: null })])).toEqual([U]);
  });
});
