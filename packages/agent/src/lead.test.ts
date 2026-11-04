import { describe, expect, it } from 'vitest';
import { cardForReply, prefillOf, type LeadState } from './lead.js';

// FEAT-049 acceptance (AC-8): the offer rule for every reply kind the criterion names, not only
// the out-of-scope turn the integration test drives.
const fresh: LeadState = { enquiry: null, offered: false, captured: false };
const OFFER = { kind: 'consent', prefill: {} };
const reply = (over: Partial<Parameters<typeof cardForReply>[0]> = {}) =>
  cardForReply({
    card: null,
    outcome: 'answered',
    safety: false,
    capturing: true,
    afterHoursNotice: false,
    escalatedAfterHours: false,
    state: fresh,
    ...over,
  });

describe('cardForReply (AC-8)', () => {
  it.each(['unavailable', 'unsure', 'out_of_scope'])('offers consent on an %s reply', (outcome) => {
    expect(reply({ outcome })).toEqual(OFFER);
  });

  it('offers after hours and on an after-hours escalation, not on a plain answer', () => {
    expect(reply({ afterHoursNotice: true })).toEqual(OFFER);
    expect(reply({ outcome: 'escalated', escalatedAfterHours: true })).toEqual(OFFER);
    expect(reply({ outcome: 'escalated' })).toBeNull();
    expect(reply()).toBeNull();
  });

  it('never after an answer, an earlier offer or a capture', () => {
    for (const state of [
      { ...fresh, enquiry: 'declined' as const },
      { ...fresh, enquiry: 'agreed' as const },
      { ...fresh, offered: true },
      { ...fresh, captured: true },
    ])
      expect(reply({ outcome: 'unsure', state })).toBeNull();
  });

  it('never on a safety, paused, not-live or gated reply, nor without a purpose statement', () => {
    expect(reply({ outcome: 'unsure', safety: true })).toBeNull();
    for (const outcome of ['paused', 'not_live', 'ended', 'gate_closed'])
      expect(reply({ outcome, afterHoursNotice: true })).toBeNull();
    expect(reply({ outcome: 'unsure', capturing: false })).toBeNull();
    const form = {
      kind: 'lead_form',
      consentId: '00000000-0000-4000-8000-000000000001',
      prefill: {},
    } as const;
    expect(reply({ card: form, capturing: false })).toBeNull();
  });
});

describe('prefillOf (AC-5)', () => {
  it('keeps valid args normalised and drops invalid ones', () => {
    expect(prefillOf({ name: ' Mei ', phone: '9123 4567', email: 'Mei@Example.com' })).toEqual({
      name: 'Mei',
      phone: '+6591234567',
      email: 'mei@example.com',
    });
    expect(prefillOf({ phone: '1234 5678', email: 'not-an-email' })).toEqual({});
    expect(prefillOf('junk')).toEqual({});
  });
});
