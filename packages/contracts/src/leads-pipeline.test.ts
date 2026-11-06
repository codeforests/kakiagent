import { describe, expect, it } from 'vitest';
import {
  LeadDetail,
  LeadExportBody,
  LeadList,
  LeadSettingsBody,
  LeadsQuery,
  LeadStatusBody,
  LeadSummary,
  Qualification,
} from './index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const AT = '2026-11-18T06:05:00.000Z';
const scoring = {
  score: 'hot',
  points: 7,
  reasons: [
    { code: 'keyword', points: 2, detail: 'wedding' },
    { code: 'budget_met', points: 2, detail: '300' },
    { code: 'both_contacts', points: 1, detail: null },
  ],
  at: AT,
} as const;
const row = {
  id: ID,
  version: 1,
  name: 'Mei',
  email: 'mei@example.com',
  phone: '+65 9123 4567',
  need: 'Wedding cake',
  status: 'new',
  scoring,
  source: 'contact_form',
  marketing: { agreed: true, at: AT },
  createdAt: AT,
  updatedAt: AT,
} as const;

describe('leads contracts (FEAT-050 §3)', () => {
  it('round-trips a list, a detail and the sidebar summary with scoring', () => {
    const list = {
      items: [row, { ...row, scoring: null, marketing: null }],
      nextCursor: null,
      counts: { new: 1, contacted: 0, won: 0, lost: 0 },
    };
    expect(LeadList.parse(list)).toEqual(list);
    const detail = {
      ...row,
      budget: 'S$500',
      preferredTime: 'Sat',
      captures: 2,
      contactId: ID,
      consents: [
        {
          id: ID,
          purpose: 'enquiry',
          decision: 'agreed',
          at: AT,
          channel: 'widget',
          conversationId: null,
          wording: { id: ID, version: 1, text: 'To reply to you.' },
        },
      ],
      conversations: [{ id: ID, status: 'ai', startedAt: AT, lastMessageAt: AT }],
      canManage: true,
      canExport: false,
    };
    expect(LeadDetail.parse(detail)).toEqual(detail);
    const summary = {
      id: ID,
      status: 'new',
      updatedAt: AT,
      consent: { enquiryAt: AT, marketing: null },
      scoring: null,
    };
    expect(LeadSummary.parse(summary)).toEqual(summary);
    expect(LeadSummary.safeParse({ ...summary, scoring: undefined }).success).toBe(false);
  });

  it('Qualification refuses a 21st keyword, a 41-char keyword, a duplicate and minBudget 0', () => {
    const ok = { keywords: ['wedding', ' 婚礼 '], minBudget: 300 };
    expect(Qualification.parse(ok)).toEqual({ keywords: ['wedding', '婚礼'], minBudget: 300 });
    const kws = Array.from({ length: 20 }, (_, i) => `kw${i}`);
    expect(Qualification.safeParse({ keywords: kws, minBudget: null }).success).toBe(true);
    for (const bad of [
      { keywords: [...kws, 'one more'], minBudget: null },
      { keywords: ['x'.repeat(41)], minBudget: null },
      { keywords: ['   '], minBudget: null },
      { keywords: ['Wedding', 'wedding'], minBudget: null },
      { keywords: [], minBudget: 0 },
      { keywords: [], minBudget: 10_000_001 },
      { keywords: [], minBudget: 2.5 },
    ])
      expect(Qualification.safeParse(bad).success).toBe(false);
  });

  it('LeadsQuery defaults to open and 50; limits and filters are checked', () => {
    expect(LeadsQuery.parse({})).toEqual({ status: 'open', limit: 50 });
    expect(LeadsQuery.parse({ status: 'won', score: 'hot', limit: '10' })).toEqual({
      status: 'won',
      score: 'hot',
      limit: 10,
    });
    for (const bad of [{ limit: '0' }, { limit: '101' }, { status: 'closed' }, { score: 'tepid' }])
      expect(LeadsQuery.safeParse(bad).success).toBe(false);
  });

  it('status, export and settings bodies are strict', () => {
    expect(LeadStatusBody.parse({ status: 'contacted', version: 1 })).toEqual({
      status: 'contacted',
      version: 1,
    });
    expect(LeadStatusBody.safeParse({ status: 'contacted', version: 1, note: 'x' }).success).toBe(
      false,
    );
    expect(LeadStatusBody.safeParse({ status: 'contacted', version: 0 }).success).toBe(false);
    expect(LeadExportBody.parse({})).toEqual({ status: 'open' });
    expect(LeadExportBody.safeParse({ status: 'all', email: 'x@y.z' }).success).toBe(false);
    const settings = {
      version: 1,
      fields: [
        { key: 'name', mode: 'required' },
        { key: 'phone', mode: 'optional' },
        { key: 'email', mode: 'optional' },
        { key: 'need', mode: 'optional' },
        { key: 'budget', mode: 'off' },
        { key: 'preferredTime', mode: 'off' },
      ],
      marketing: { enabled: false, text: { en: '', zh: null } },
      qualification: { keywords: ['wedding'], minBudget: null },
    };
    expect(LeadSettingsBody.safeParse(settings).success).toBe(true);
    expect(
      LeadSettingsBody.safeParse({
        ...settings,
        qualification: { keywords: [], minBudget: null, x: 1 },
      }).success,
    ).toBe(false);
  });
});
