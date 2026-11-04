import type { LeadSettings } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import {
  diffLeadSettings,
  fieldsError,
  leadBodyOf,
  leadDraftOf,
  leadServerErrors,
  validateLeadDraft,
} from './leads.ts';

const settings = (over: Partial<LeadSettings> = {}): LeadSettings => ({
  version: 0,
  fields: [
    { key: 'name', mode: 'required' },
    { key: 'phone', mode: 'optional' },
    { key: 'email', mode: 'optional' },
    { key: 'need', mode: 'optional' },
    { key: 'budget', mode: 'off' },
    { key: 'preferredTime', mode: 'off' },
  ],
  marketing: { enabled: false, text: { en: '', zh: null }, wording: null },
  purpose: { text: { en: 'We use your details to reply.', zh: null }, saved: true },
  ...over,
});

describe('Leads and consent helpers (SCR-APP-043; FEAT-049 AC-12)', () => {
  it('starts the opt-in wording on the default and builds the body', () => {
    const d = leadDraftOf(settings(), 'Kaki Bakery');
    expect(d.marketing.en).toBe(
      'Also send me offers and news from Kaki Bakery. I can unsubscribe at any time.',
    );
    d.marketing.enabled = true;
    d.marketing.zh = '  ';
    expect(leadBodyOf(d, 3)).toMatchObject({
      version: 3,
      marketing: { enabled: true, text: { zh: null } },
    });
  });

  it('refuses phone and email both off, and an empty wording while on', () => {
    const d = leadDraftOf(settings(), 'K');
    expect(validateLeadDraft(d)).toEqual({});
    d.fields = d.fields.map((f) =>
      f.key === 'phone' || f.key === 'email' ? { ...f, mode: 'off' } : f,
    );
    expect(fieldsError(d.fields)).toBe('Keep phone or email on, so the team can reply.');
    d.marketing = { enabled: true, en: ' ', zh: '' };
    expect(Object.keys(validateLeadDraft(d))).toEqual(['email', 'marketingEn']);
  });

  it('maps the server codes to the same field errors', () => {
    expect(leadServerErrors('phone_or_email')).toHaveProperty('email');
    expect(leadServerErrors('marketing_text')).toHaveProperty('marketingEn');
    expect(leadServerErrors('invalid')).toEqual({});
  });

  it('lists what changed, ignoring the wording while the opt-in is off', () => {
    const before = leadDraftOf(settings(), 'K');
    expect(diffLeadSettings(before, before)).toEqual([]);
    const after = leadDraftOf(settings(), 'K');
    after.fields[4] = { key: 'budget', mode: 'required' };
    after.marketing.en = 'changed';
    expect(diffLeadSettings(before, after)).toEqual(['Budget: Off → Required']);
    after.marketing.enabled = true;
    expect(diffLeadSettings(before, after)).toEqual([
      'Budget: Off → Required',
      'Marketing opt-in: on',
      'Opt-in wording changed',
    ]);
  });
});
