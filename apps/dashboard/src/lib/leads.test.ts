import type { LeadSettings } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import {
  diffLeadSettings,
  fieldsError,
  leadBodyOf,
  leadDraftOf,
  leadServerErrors,
  validateLeadDraft,
  csvLeadCount,
  exportFileName,
  exportTitle,
  filterNote,
  leadsQueryOf,
  leadsSearchOf,
  marketingText,
  pointsText,
  reasonText,
  scoreLabel,
  tabCount,
  budgetError,
  keywordError,
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
  qualification: { keywords: [], minBudget: null },
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

describe('Leads list and lead page helpers (SCR-APP-032, -033; FEAT-050 AC-2, AC-4, AC-6)', () => {
  const counts = { new: 2, contacted: 1, won: 1, lost: 0 };

  it('reads the filters from the URL and writes them back without the defaults', () => {
    expect(leadsQueryOf(new URLSearchParams(''))).toEqual({ status: 'open', score: undefined });
    expect(leadsQueryOf(new URLSearchParams('status=won&score=hot'))).toEqual({
      status: 'won',
      score: 'hot',
    });
    expect(leadsQueryOf(new URLSearchParams('status=bogus&score=lukewarm'))).toEqual({
      status: 'open',
      score: undefined,
    });
    expect(leadsSearchOf({ status: 'open', score: undefined })).toBe('');
    expect(leadsSearchOf({ status: 'all', score: 'cold' })).toBe('?status=all&score=cold');
  });

  it('counts the open and all tabs from the four statuses', () => {
    expect(tabCount(counts, 'open')).toBe(3);
    expect(tabCount(counts, 'all')).toBe(4);
    expect(tabCount(counts, 'won')).toBe(1);
    expect(tabCount(counts, 'lost')).toBe(0);
  });

  it('words scores and reasons as the ui-design table and the CSV do', () => {
    expect(scoreLabel(null)).toBe('Not scored');
    expect(scoreLabel({ score: 'hot', points: 7, reasons: [], at: '2026-11-18T06:30:00Z' })).toBe(
      'Hot',
    );
    expect(reasonText({ code: 'keyword', points: 3, detail: 'wedding' })).toBe(
      'Mentions "wedding"',
    );
    expect(reasonText({ code: 'budget_met', points: 2, detail: '300' })).toBe(
      'Budget meets your S$300 minimum',
    );
    expect(reasonText({ code: 'budget_below', points: -1, detail: '300' })).toBe(
      'Budget below your S$300 minimum',
    );
    expect(reasonText({ code: 'returning', points: 1, detail: null })).toBe('Came back');
    expect(pointsText(2)).toBe('+2');
    expect(pointsText(-1)).toBe('−1');
  });

  it('shows the marketing flag with its time (LED-08)', () => {
    expect(marketingText(null)).toBe('Offers: Not asked');
    expect(marketingText({ agreed: false, at: '2026-11-18T06:30:00Z', withdrawn: false })).toBe(
      'Offers: No',
    );
    expect(marketingText({ agreed: true, at: '2026-11-18T06:30:00Z', withdrawn: false })).toBe(
      'Offers: Yes · 18 Nov 2026, 2:30 pm',
    );
  });

  it('titles the export from the tab count, or the loaded rows under a score filter', () => {
    expect(exportTitle({ status: 'open', score: undefined }, counts, 0, false)).toBe(
      'Export 3 leads?',
    );
    expect(exportTitle({ status: 'won', score: undefined }, counts, 0, false)).toBe(
      'Export 1 lead?',
    );
    expect(exportTitle({ status: 'open', score: 'hot' }, counts, 1, true)).toBe('Export 1 lead?');
    expect(exportTitle({ status: 'open', score: 'hot' }, counts, 50, false)).toBe(
      'Export these leads?',
    );
    expect(filterNote({ status: 'open', score: undefined })).toBeNull();
    expect(filterNote({ status: 'open', score: 'hot' })).toBe('Filters: Open · Hot');
    expect(filterNote({ status: 'won', score: undefined })).toBe('Filters: Won');
  });

  it('counts the CSV rows, quoted line breaks included, and names the file in SGT', () => {
    const csv =
      '\uFEFFThe Do Not Call Registry applies\r\nCreated,Name,Need\r\n' +
      '18 Nov 2026 14:05,Rachel,"Wedding cake\nfor 80"\r\n18 Nov 2026 14:06,"Lim, D",Cake\r\n';
    expect(csvLeadCount(csv)).toBe(2);
    expect(csvLeadCount('\uFEFFReminder\r\nCreated,Name\r\n')).toBe(0);
    expect(exportFileName(new Date('2026-11-17T16:30:00Z'))).toBe('leads-2026-11-18.csv');
  });
});

describe('Qualification card helpers (SCR-APP-043; FEAT-050 AC-1)', () => {
  it('checks a keyword before it is added', () => {
    expect(keywordError([], '  ')).toBe('Enter a keyword');
    expect(keywordError([], 'x'.repeat(41))).toBe('Keep keywords to 40 characters');
    expect(keywordError(['Wedding'], ' wedding ')).toBe('You already added Wedding');
    const twenty = Array.from({ length: 20 }, (_, i) => `k${i}`);
    expect(keywordError(twenty, 'one more')).toBe('You can add up to 20 keywords');
    expect(keywordError(['wedding'], '婚礼')).toBeUndefined();
  });

  it('checks the minimum budget and sends it as whole dollars or null', () => {
    expect(budgetError('')).toBeUndefined();
    expect(budgetError('1,000')).toBeUndefined();
    expect(budgetError('12.50')).toBe('Enter a whole number of dollars');
    expect(budgetError('abc')).toBe('Enter a whole number of dollars');
    expect(budgetError('0')).toBe('Enter an amount from S$1 to S$10,000,000');
    expect(budgetError('10000001')).toBe('Enter an amount from S$1 to S$10,000,000');
    const d = leadDraftOf(
      settings({ qualification: { keywords: ['wedding'], minBudget: 300 } }),
      'K',
    );
    expect(d.qualification).toEqual({ keywords: ['wedding'], minBudget: '300' });
    expect(leadBodyOf(d, 1).qualification).toEqual({ keywords: ['wedding'], minBudget: 300 });
    d.qualification.minBudget = 'S$1,500';
    expect(leadBodyOf(d, 1).qualification?.minBudget).toBe(1500);
    d.qualification.minBudget = ' ';
    expect(leadBodyOf(d, 1).qualification?.minBudget).toBeNull();
    d.qualification.minBudget = 'abc';
    expect(validateLeadDraft(d)).toEqual({ minBudget: 'Enter a whole number of dollars' });
  });

  it('lists keyword and budget changes in the diff', () => {
    const before = leadDraftOf(
      settings({ qualification: { keywords: ['wedding'], minBudget: 300 } }),
      'K',
    );
    const after = leadDraftOf(
      settings({ qualification: { keywords: ['bread'], minBudget: null } }),
      'K',
    );
    expect(diffLeadSettings(before, after)).toEqual([
      'Keywords added: bread',
      'Keywords removed: wedding',
      'Minimum budget removed',
    ]);
    expect(diffLeadSettings(before, before)).toEqual([]);
  });
});
