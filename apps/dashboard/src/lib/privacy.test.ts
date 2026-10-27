import type { PrivacySettingsResponse } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import {
  formatDay,
  formatSaved,
  noticeBodyOf,
  noticeDraftOf,
  purposeBodyOf,
  purposeDraftOf,
  sameNotice,
  samePurpose,
  validateNotice,
  validatePurpose,
  type NoticeDraft,
} from './privacy.ts';

const DEFAULT_PURPOSE = { en: 'We use your details to reply.', zh: '我们会回复您。' };
const base: PrivacySettingsResponse = {
  version: 0,
  notice: { mode: 'none' },
  purpose: { text: { en: DEFAULT_PURPOSE.en, zh: DEFAULT_PURPOSE.zh }, wording: null },
  defaults: {
    purpose: DEFAULT_PURPOSE,
    template: { organisationName: 'Kaki Bakery', uen: '201912345K', contactEmail: 'hi@kaki.sg' },
  },
  readiness: { privacyNotice: false, purposeStatement: false },
  documents: { updatedOn: '2026-10-27', dpaVersion: '1.0', subProcessors: [], transfers: [] },
  terms: [],
};
const saved = { seq: 3, savedAt: '2026-10-27T02:00:00.000Z' };
const fields = {
  contactName: 'Mei Ling',
  contactEmail: 'dpo@kaki.sg',
  contactPhone: null,
  address: '1 Bakery Lane',
  extra: null,
};
const link: NoticeDraft = {
  mode: 'link',
  url: 'https://kakibakery.sg/privacy',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  address: '',
  extra: '',
};
const template: NoticeDraft = {
  ...link,
  mode: 'template',
  url: '',
  ...fields,
  contactPhone: '',
  extra: '',
};

describe('noticeDraftOf', () => {
  it('starts a never-saved notice on the link, with the profile email for the template', () => {
    expect(noticeDraftOf(base)).toEqual({ ...link, url: '', contactEmail: 'hi@kaki.sg' });
  });
  it('reads a saved link', () => {
    const res = { ...base, notice: { mode: 'link' as const, url: link.url, wording: saved } };
    expect(noticeDraftOf(res)).toMatchObject({ mode: 'link', url: link.url });
  });
  it('reads a saved template, nulls as empty text', () => {
    const res = {
      ...base,
      notice: {
        mode: 'template' as const,
        fields,
        templateVersion: '1',
        publicUrl: 'https://api.kaki.test/privacy/k',
        wording: saved,
      },
    };
    expect(noticeDraftOf(res)).toEqual(template);
  });
});

describe('validateNotice', () => {
  const url = (u: string) => validateNotice({ ...link, url: u }).url;
  it('accepts an https link', () => expect(validateNotice(link)).toEqual({}));
  it('rejects an empty link', () => expect(url('  ')).toBe('Add the link to your privacy notice.'));
  it('rejects http, javascript: and a bare host', () => {
    for (const u of ['http://kakibakery.sg/privacy', 'javascript:alert(1)', 'kakibakery.sg/p'])
      expect(url(u)).toBe('The link must start with https://');
  });
  it('rejects malformed addresses', () => {
    for (const u of ['https://', 'https://kaki bakery.sg', 'https://localhost'])
      expect(url(u)).toMatch(/^That doesn't look like a web address/);
  });
  it('needs a contact name and email for the template', () => {
    expect(validateNotice({ ...template, contactName: ' ', contactEmail: 'nope' })).toEqual({
      contactName: 'Add a contact person.',
      contactEmail: 'Add a contact email, like hello@kakibakery.sg',
    });
    expect(validateNotice(template)).toEqual({});
  });
});

describe('notice bodies', () => {
  it('trims and nulls empty optional fields', () => {
    expect(noticeBodyOf({ ...template, address: '  ' }, 4)).toEqual({
      version: 4,
      mode: 'template',
      fields: { ...fields, address: null },
    });
    expect(noticeBodyOf({ ...link, url: ` ${link.url} ` }, 0)).toEqual({
      version: 0,
      mode: 'link',
      url: link.url,
    });
  });
  it('compares only the chosen mode', () => {
    expect(sameNotice(link, { ...link, contactName: 'x' })).toBe(true);
    expect(sameNotice(link, { ...link, mode: 'template' })).toBe(false);
    expect(sameNotice(template, { ...template, extra: 'More' })).toBe(false);
  });
});

describe('purpose', () => {
  it('shows the default until saved, then the saved text', () => {
    expect(purposeDraftOf(base)).toEqual(DEFAULT_PURPOSE);
    const res = { ...base, purpose: { text: { en: 'Ours', zh: null }, wording: saved } };
    expect(purposeDraftOf(res)).toEqual({ en: 'Ours', zh: '' });
  });
  it('validates length and the English text', () => {
    expect(validatePurpose({ en: ' ', zh: '' })).toEqual({
      en: 'Add the English purpose statement.',
    });
    expect(validatePurpose({ en: 'a'.repeat(601), zh: '字'.repeat(602) })).toEqual({
      en: 'Keep it under 600 characters (601 now).',
      zh: 'Keep it under 600 characters (602 now).',
    });
  });
  it('compares trimmed text and sends empty Chinese as null', () => {
    expect(samePurpose({ en: 'A ', zh: '' }, { en: 'A', zh: ' ' })).toBe(true);
    expect(purposeBodyOf({ en: ' A ', zh: ' ' }, 2)).toEqual({
      version: 2,
      purpose: { en: 'A', zh: null },
    });
  });
});

describe('dates', () => {
  it('formats the saved marker and registry dates', () => {
    expect(formatSaved(saved)).toBe('Version 3 · saved 27 Oct 2026');
    expect(formatDay('2026-10-27')).toBe('27 Oct 2026');
    expect(formatSaved({ seq: 1, savedAt: '2026-10-26T17:00:00.000Z' })).toBe(
      'Version 1 · saved 27 Oct 2026',
    );
  });
});
