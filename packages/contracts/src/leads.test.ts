import { describe, expect, it } from 'vitest';
import {
  checkLead,
  ConsentBody,
  ContactEmail,
  isEmail,
  LeadFields,
  LeadSubmitBody,
  leadOk,
  Message,
  MessageCard,
  normaliseSgPhone,
  SearchMatch,
  SgPhone,
  WidgetConfigResponse,
} from './index.js';

const FIELDS = [
  { key: 'name', mode: 'required' },
  { key: 'phone', mode: 'optional' },
  { key: 'email', mode: 'optional' },
  { key: 'need', mode: 'optional' },
  { key: 'budget', mode: 'off' },
  { key: 'preferredTime', mode: 'off' },
] as const;

describe('lead checks without Zod (FEAT-049 D7, AC-5)', () => {
  it('normalises SG phones in any common spelling', () => {
    for (const p of ['91234567', '9123 4567', '+65 9123-4567', '006591234567', '+6591234567'])
      expect(normaliseSgPhone(p)).toBe('+6591234567');
    expect(normaliseSgPhone('')).toBe('');
    for (const p of ['1234567', '71234567', '+6091234567', '912345678', 'abc'])
      expect(normaliseSgPhone(p)).toBeNull();
  });

  it('SgPhone and ContactEmail agree with the plain functions', () => {
    expect(SgPhone.parse('9123 4567')).toBe('+6591234567');
    expect(SgPhone.safeParse('7123 4567').success).toBe(false);
    for (const e of ['mei@example.com', 'a.b+c@kaki-bakery.com.sg', 'x@y', 'a..b@c.com', 'no at'])
      expect(ContactEmail.safeParse(e).success).toBe(isEmail(e));
  });

  it('flags required, invalid and missing phone-or-email, and clears off fields', () => {
    const bad = checkLead(FIELDS, { phone: '1234', email: 'nope', budget: '$500' });
    expect(bad.fields).toEqual({ name: 'required', phone: 'invalid', email: 'invalid' });
    expect(bad.needsContact).toBe(false);
    expect(leadOk(bad)).toBe(false);
    const none = checkLead(FIELDS, { name: 'Mei' });
    expect(none).toMatchObject({ fields: {}, needsContact: true });
    const ok = checkLead(FIELDS, {
      name: ' Mei ',
      phone: '9123 4567',
      email: 'Mei@Example.com',
      budget: 'x',
    });
    expect(leadOk(ok)).toBe(true);
    expect(ok.value).toEqual({
      name: 'Mei',
      phone: '+6591234567',
      email: 'mei@example.com',
      need: '',
      budget: '',
      preferredTime: '',
    });
    expect(checkLead(FIELDS, { name: 'x'.repeat(121), email: 'a@b.co' }).fields).toEqual({
      name: 'invalid',
    });
  });
});

describe('lead contracts (FEAT-049 §3)', () => {
  it('LeadFields needs every key in order and phone or email', () => {
    expect(LeadFields.safeParse(FIELDS).success).toBe(true);
    expect(LeadFields.safeParse([...FIELDS].reverse()).success).toBe(false);
    const noContact = FIELDS.map((f) =>
      f.key === 'phone' || f.key === 'email' ? { ...f, mode: 'off' } : f,
    );
    expect(LeadFields.safeParse(noContact).error?.issues[0]?.message).toBe('phone_or_email');
  });

  it('bodies are strict and cards are typed', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(
      ConsentBody.safeParse({ purposeWordingId: id, agreed: true, tenantId: id }).success,
    ).toBe(false);
    expect(LeadSubmitBody.parse({ consentId: id, fields: { name: 'Mei' } }).fields.phone).toBe('');
    expect(MessageCard.safeParse({ kind: 'lead_form', prefill: {} }).success).toBe(false);
    expect(MessageCard.parse({ kind: 'consent', prefill: { phone: '+6591234567' } }).kind).toBe(
      'consent',
    );
  });

  it('older payloads still parse: no card, no leadCapture, a message search match', () => {
    const m = Message.parse({
      id: '11111111-1111-4111-8111-111111111111',
      conversationId: '11111111-1111-4111-8111-111111111111',
      seq: 1,
      author: 'agent',
      body: 'Hi',
      inReplyTo: null,
      disclosure: null,
      notice: null,
      noticeKind: null,
      authorName: null,
      language: 'en',
      createdAt: '2026-11-04T00:00:00.000Z',
    });
    expect(m.card).toBeUndefined();
    const match = SearchMatch.parse({
      messageId: '11111111-1111-4111-8111-111111111111',
      author: 'visitor',
      at: '2026-11-04T00:00:00.000Z',
      excerpt: 'cake',
      ranges: [],
    });
    expect(match).toMatchObject({ source: 'message', field: null });
    expect(WidgetConfigResponse.shape.leadCapture.parse(undefined)).toBeNull();
  });
});
