import { describe, expect, it } from 'vitest';
import { PrivacyNoticeBody, PrivacySettingsResponse, PurposeStatementBody } from './index.js';

const FIELDS = {
  contactName: ' Mei Lin ',
  contactEmail: 'dpo@kakibakery.test',
  contactPhone: null,
  address: null,
  extra: null,
};
const REF = { seq: 2, savedAt: '2026-10-27T03:00:00.000Z' };
const DOCS = {
  updatedOn: '2026-10-27',
  dpaVersion: '2026-10-20',
  subProcessors: [],
  transfers: [],
};

describe('privacy contracts (FEAT-058 §3)', () => {
  it('parses a link and a template notice, trimming fields', () => {
    expect(
      PrivacyNoticeBody.parse({ version: 0, mode: 'link', url: 'https://kakibakery.test/privacy' }),
    ).toMatchObject({ mode: 'link' });
    const t = PrivacyNoticeBody.parse({ version: 3, mode: 'template', fields: FIELDS });
    expect(t.mode === 'template' && t.fields.contactName).toBe('Mei Lin');
  });

  it('rejects http, javascript: and malformed links, and a template without contact', () => {
    for (const url of ['http://kakibakery.test/privacy', 'javascript:alert(1)', 'not a url'])
      expect(PrivacyNoticeBody.safeParse({ version: 0, mode: 'link', url }).success).toBe(false);
    expect(
      PrivacyNoticeBody.safeParse({
        version: 0,
        mode: 'template',
        fields: { ...FIELDS, contactName: '  ' },
      }).success,
    ).toBe(false);
    expect(
      PrivacyNoticeBody.safeParse({
        version: 0,
        mode: 'template',
        fields: { ...FIELDS, contactEmail: 'nope' },
      }).success,
    ).toBe(false);
  });

  it('parses a purpose statement and rejects an empty or long English text', () => {
    expect(
      PurposeStatementBody.parse({ version: 1, purpose: { en: 'To reply.', zh: null } }).purpose.en,
    ).toBe('To reply.');
    for (const en of ['  ', 'x'.repeat(601)])
      expect(
        PurposeStatementBody.safeParse({ version: 1, purpose: { en, zh: null } }).success,
      ).toBe(false);
  });

  it('parses each response notice variant', () => {
    const base = {
      version: 0,
      purpose: { text: { en: 'Default.', zh: null }, wording: null },
      defaults: {
        purpose: { en: 'Default.', zh: '默认。' },
        template: { organisationName: 'Kaki Bakery', uen: null, contactEmail: null },
      },
      readiness: { privacyNotice: false, purposeStatement: false },
      documents: DOCS,
      terms: [
        {
          document: 'dpa',
          title: 'Data Processing Agreement',
          currentVersion: '2026-10-20',
          acceptedVersion: null,
          acceptedAt: null,
        },
      ],
    };
    for (const notice of [
      { mode: 'none' },
      { mode: 'link', url: 'https://kakibakery.test/privacy', wording: REF },
      {
        mode: 'template',
        fields: FIELDS,
        templateVersion: '2026-10-27',
        publicUrl: 'https://api.test/privacy/wk_1',
        wording: REF,
      },
    ])
      expect(PrivacySettingsResponse.safeParse({ ...base, notice }).success).toBe(true);
  });
});
