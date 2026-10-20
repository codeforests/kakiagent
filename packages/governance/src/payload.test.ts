import { describe, expect, it } from 'vitest';
import {
  assertAuditEntry,
  auditCode,
  auditHash,
  auditId,
  AuditPayloadError,
  masked,
  subjectRefs,
  type AuditEntry,
  type AuditPayload,
} from './payload.js';

const U = '7d2f1c4e-1b1a-4c3e-9f00-0a1b2c3d4e5f';
const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  action: 'fact.updated',
  actorType: 'user',
  actorId: U,
  subjectType: 'fact',
  subjectId: U,
  ...over,
});

describe('payload constructors', () => {
  it('accept IDs, codes, hashes and masked text', () => {
    const payload: AuditPayload = {
      factIds: [auditId(U.toUpperCase())],
      tool: auditCode('lookup_kb'),
      argsHash: auditHash('a'.repeat(64)),
      note: masked('customer asked about delivery'),
      count: 3,
      ok: true,
      none: null,
    };
    expect(payload.factIds).toEqual([U]);
    expect(() => assertAuditEntry(entry({ payload }))).not.toThrow();
  });

  it.each([
    () => auditId('not-a-uuid x'),
    () => auditCode('Has Space'),
    () => auditHash('abc'),
    () => masked('x'.repeat(501)),
  ])('reject invalid input', (fn) => {
    expect(fn).toThrow(AuditPayloadError);
  });

  it('a plain string is a type error in a payload', () => {
    // @ts-expect-error free text cannot be an AuditValue (ADR-014 decision 2)
    const p: AuditPayload = { name: 'Tan Ah Kow' };
    expect(() => assertAuditEntry(entry({ payload: p }))).toThrow(AuditPayloadError);
    // @ts-expect-error a hand-made { masked } object is not Masked either
    const q: AuditPayload = { note: { masked: 'x' } };
    expect(q).toBeDefined();
  });
});

describe('assertAuditEntry (AC-7)', () => {
  const bad = (payload: unknown) => entry({ payload: payload as AuditPayload });
  it.each([
    ['a name', bad({ name: 'Tan Ah Kow' })],
    ['an email', bad({ email: 'tan@example.com' })],
    ['an NRIC', bad({ id: 'S1234567D' })],
    ['a nested raw string', bad({ outer: { inner: ['ok', 'Hello there'] } })],
    ['an over-long masked value', bad({ note: { masked: 'x'.repeat(501) } })],
    ['a masked value that is not a string', bad({ note: { masked: 5 } })],
    ['an invalid key', bad({ 'bad key': 1 })],
    ['a non-finite number', bad({ n: Number.POSITIVE_INFINITY })],
    ['too deep nesting', bad({ a: { b: { c: { d: { e: 1 } } } } })],
    ['too many items', bad({ ids: Array.from({ length: 201 }, () => 1) })],
    [
      'an oversized payload',
      bad({ notes: Array.from({ length: 20 }, () => ({ masked: 'x'.repeat(490) })) }),
    ],
    ['an actor ID with a space', entry({ actorId: 'Tan Ah Kow' })],
    ['an actor ID with @', entry({ actorId: 'tan@example.com' })],
    ['a subject ID with free text', entry({ subjectId: 'Hello World' })],
    ['an invalid subject type', entry({ subjectType: 'Fact Type' })],
    ['an invalid related ref', entry({ related: [{ type: 'conversation', id: 'a b' }] })],
    ['an invalid action', entry({ action: 'Fact Updated' })],
    ['an invalid actor type', entry({ actorType: 'admin' as never })],
    ['a PII contact that is not a UUID', entry({ pii: { contactId: 'x', data: {} } })],
    ['a payload that is an array', entry({ payload: [] as never })],
    // FEAT-003 AC-8: lower-case identifiers pass the code shape, so the masker decides.
    ['a lower-case NRIC as actor ID', entry({ actorId: 's1234567d' })],
    ['a card number as actor ID', entry({ actorId: '4242-4242-4242-4242' })],
    ['a lower-case NRIC as subject ID', entry({ subjectId: 's1234567d' })],
    ['a card number as related ID', entry({ related: [{ type: 'card', id: '4242424242424242' }] })],
    ['a lower-case NRIC as payload code', bad({ ref: 's1234567d' })],
    ['a card number in an action', entry({ action: 'paid.4242424242424242' })],
  ])('rejects %s', (_n, e) => {
    expect(() => assertAuditEntry(e)).toThrow(AuditPayloadError);
  });

  it('rejects a PII code at construction', () => {
    expect(() => auditCode('s1234567d')).toThrow(AuditPayloadError);
    expect(() => auditCode('4242424242424242')).toThrow(AuditPayloadError);
  });

  it('accepts the shapes the existing callers write', () => {
    for (const e of [
      entry({ actorType: 'visitor', subjectType: 'conversation' }),
      entry({ actorType: 'agent', actorId: undefined, subjectType: 'message' }),
      entry({ actorId: 'u1', subjectId: 't1', subjectType: 'thing', action: 'test.done' }),
      entry({ pii: { contactId: null, data: { name: 'Tan Ah Kow' } } }),
    ])
      expect(() => assertAuditEntry(e)).not.toThrow();
  });

  it('builds subject refs with the primary subject first', () => {
    expect(subjectRefs(entry({ related: [{ type: 'conversation', id: 'c1' }] }))).toEqual([
      `fact:${U}`,
      'conversation:c1',
    ]);
  });
});
