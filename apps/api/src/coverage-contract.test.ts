import { CorrectionAccept, CorrectionItem, CoverageReport, CoverageTopic } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';

const ITEM = '6f1c5a52-6b4e-4d8e-9f7a-0c2b1f6d1a01';
const FACT = '6f1c5a52-6b4e-4d8e-9f7a-0c2b1f6d1a02';
const report = {
  stage: 'live',
  template: {
    industry: 'fnb',
    checked: 'meaning',
    topics: [
      {
        id: 'delivery',
        question: 'Do you deliver?',
        hint: 'Areas, fees, minimum order',
        state: 'covered',
        coveredBy: { factId: FACT, type: 'policy', label: 'Delivery' },
      },
      { id: 'halal', question: 'Are you halal?', hint: 'h', state: 'missing', coveredBy: null },
      { id: 'dine_in', question: 'Can I dine in?', hint: 'h', state: 'skipped', coveredBy: null },
    ],
  },
  gaps: [
    {
      correctionId: ITEM,
      question: 'Can I pay by PayNow?',
      asks30d: 3,
      asksTotal: 4,
      firstAskedAt: '2026-09-01T00:00:00.000Z',
      lastAskedAt: '2026-10-24T00:00:00.000Z',
      reasons: ['unavailable', 'escalated'],
    },
  ],
  summary: { topicsTotal: 3, topicsMissing: 1, openGaps: 1 },
};

describe('coverage contracts (FEAT-019 §3)', () => {
  it('parses a report and a coverage_gap correction item', () => {
    expect(CoverageReport.parse(report)).toEqual(report);
    expect(
      CoverageReport.parse({ ...report, stage: 'pre_live', template: null, gaps: [] }),
    ).toBeTruthy();
    const item = {
      id: ITEM,
      status: 'open',
      source: 'coverage_gap',
      proposedBy: 'system',
      change: { kind: 'answer_gap' },
      acceptedChange: null,
      facts: [],
      coachingSessionId: null,
      conversationId: null,
      createdAt: '2026-10-24T00:00:00.000Z',
      decidedAt: null,
      closedBySystem: false,
    };
    expect(CorrectionItem.parse(item)).toEqual(item);
    expect(
      CorrectionAccept.safeParse({ edit: { kind: 'add_faq', question: 'PayNow?', answer: 'Yes' } })
        .success,
    ).toBe(true);
  });

  it('rejects an unknown topic state, a covered topic without its fact, and an unknown gap reason', () => {
    const topic = report.template.topics[1]!;
    expect(CoverageTopic.safeParse({ ...topic, state: 'partial' }).success).toBe(false);
    expect(CoverageTopic.safeParse({ ...topic, state: 'covered' }).success).toBe(false);
    expect(
      CoverageReport.safeParse({ ...report, gaps: [{ ...report.gaps[0], reasons: ['answered'] }] })
        .success,
    ).toBe(false);
  });
});
