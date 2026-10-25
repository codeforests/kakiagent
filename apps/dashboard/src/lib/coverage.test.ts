import type { CoverageGap, CoverageReport, CoverageTopic } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import {
  allClear,
  allTopicsLine,
  askedLine,
  GAP_REASON,
  gapCaption,
  gapCountsLine,
  sectionOrder,
  summaryLines,
  tabCount,
  timesLabel,
  TOPIC_STATE,
  topicsDone,
  topicsLine,
} from './coverage.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-10-24T04:00:00.000Z');

const topic = (n: number, state: CoverageTopic['state']): CoverageTopic => ({
  id: `fnb.t${n}`,
  question: `Question ${n}?`,
  hint: 'Hint',
  state,
  coveredBy: state === 'covered' ? { factId: id(n), type: 'faq', label: `FAQ ${n}` } : null,
});
const gap = (over: Partial<CoverageGap> = {}): CoverageGap => ({
  correctionId: id(90),
  question: 'Do you deliver to Jurong?',
  asks30d: 3,
  asksTotal: 5,
  firstAskedAt: '2026-10-01T04:00:00.000Z',
  lastAskedAt: '2026-10-24T02:00:00.000Z',
  reasons: ['unavailable'],
  ...over,
});
const report = (over: Partial<CoverageReport> = {}, topics?: CoverageTopic[]): CoverageReport => {
  const ts = topics ?? [topic(1, 'covered'), topic(2, 'missing'), topic(3, 'skipped')];
  const gaps = over.gaps ?? [];
  return {
    stage: 'pre_live',
    template: { industry: 'fnb', topics: ts, checked: 'meaning' },
    gaps,
    summary: {
      topicsTotal: ts.length,
      topicsMissing: ts.filter((t) => t.state === 'missing').length,
      openGaps: gaps.length,
    },
    ...over,
  };
};

describe('section order per stage (D4)', () => {
  it('pre-live leads with the template topics', () => {
    expect(sectionOrder(report())).toEqual(['topics', 'gaps']);
  });
  it('live leads with customers’ questions', () => {
    expect(sectionOrder(report({ stage: 'live' }))).toEqual(['gaps', 'topics']);
  });
});

describe('counts copy', () => {
  it('counts answered topics out of those that apply', () => {
    expect(topicsLine(report().template!.topics)).toBe('1 of 2 common questions answered');
    expect(topicsLine([topic(1, 'covered')])).toBe('1 of 1 common question answered');
  });
  it('pre-live shows the topics line only', () => {
    expect(summaryLines(report())).toEqual(['1 of 2 common questions answered']);
    expect(summaryLines(report({ template: null }))).toEqual([]);
  });
  it('live shows the gaps, then the topics while one is missing', () => {
    expect(
      summaryLines(report({ stage: 'live', gaps: [gap(), gap({ correctionId: id(91) })] })),
    ).toEqual([
      "2 questions customers asked that your assistant couldn't answer",
      '1 of 2 common questions answered',
    ]);
    const done = report({ stage: 'live', gaps: [gap()] }, [topic(1, 'covered')]);
    expect(summaryLines(done)).toEqual([
      "1 question customers asked that your assistant couldn't answer",
    ]);
  });
  it('collapses topics when all are covered or skipped', () => {
    const done = report({ stage: 'live' }, [topic(1, 'covered'), topic(2, 'skipped')]);
    expect(topicsDone(done)).toBe(true);
    expect(topicsDone(report())).toBe(false);
    expect(topicsDone(report({ template: null }))).toBe(false);
    expect(allTopicsLine([topic(1, 'covered'), topic(2, 'covered')])).toBe(
      'All 2 common questions are answered.',
    );
    expect(allTopicsLine([topic(1, 'skipped')])).toMatch(/None of the common questions apply/);
  });
  it('all clear only live, with no gaps and nothing missing', () => {
    expect(allClear(report({ stage: 'live' }, [topic(1, 'covered')]))).toBe(true);
    expect(allClear(report({ stage: 'live' }))).toBe(false);
    expect(allClear(report({ stage: 'live', gaps: [gap()] }, [topic(1, 'covered')]))).toBe(false);
    expect(allClear(report({}, [topic(1, 'covered')]))).toBe(false);
  });
  it('the tab pill adds missing topics and open gaps', () => {
    expect(tabCount(report({ gaps: [gap()] }))).toBe(2);
    expect(tabCount(undefined)).toBe(0);
  });
});

describe('topic state chips and gap reasons', () => {
  it('every chip has text and a tone', () => {
    expect(TOPIC_STATE.missing).toEqual({ label: 'Not answered yet', tone: 'warning' });
    expect(TOPIC_STATE.covered).toEqual({ label: 'Answered', tone: 'success' });
    expect(TOPIC_STATE.skipped).toEqual({ label: "Doesn't apply", tone: 'neutral' });
  });
  it('names the three reasons', () => {
    expect(GAP_REASON).toEqual({
      unavailable: "Couldn't answer",
      unsure: "Wasn't sure",
      escalated: 'Handed to staff',
    });
  });
});

describe('"{n} times" plurals', () => {
  it('says once for one', () => {
    expect(timesLabel(1)).toBe('once');
    expect(timesLabel(4)).toBe('4 times');
  });
  it('the asked line counts the last 30 days, else all time', () => {
    expect(askedLine(gap(), NOW)).toBe('Asked 3 times in the last 30 days · last 2 hours ago');
    expect(askedLine(gap({ asks30d: 1 }), NOW)).toMatch(/^Asked once in the last 30 days/);
    expect(askedLine(gap({ asks30d: 0, asksTotal: 2 }), NOW)).toMatch(/^Asked 2 times · last/);
  });
  it('the dialog caption and the detail counts', () => {
    expect(gapCaption(1)).toBe(
      "Customers asked this once. Write the question the way you'd like it to read.",
    );
    expect(gapCaption(5)).toMatch(/^Customers asked this 5 times\./);
    expect(gapCountsLine(3, 5)).toBe('Asked 3 times in the last 30 days, 5 in all.');
  });
});
