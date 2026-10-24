import type { Explainer, ProposedChange } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import {
  changeSubject,
  coachAskHref,
  confirmedLine,
  diffRows,
  explainerSummary,
  hoursLabel,
  prefillFor,
  reasonSentences,
  relativeTime,
  visitorsLine,
} from './coach.ts';

const explainer = (over: Partial<Explainer> = {}): Explainer => ({
  outcome: 'answered',
  facts: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      type: 'product',
      label: 'Chocolate fudge cake',
      status: 'approved',
      used: true,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      type: 'product',
      label: 'Lemon tart',
      status: 'needs_review',
      used: false,
    },
  ],
  usedFactIds: ['00000000-0000-4000-8000-000000000001'],
  reasons: ['matched_facts'],
  route: 'reply.simple',
  visitorsWouldGet: 'same',
  ...over,
});

describe('the answer explainer (FEAT-027 ui-design)', () => {
  it('summarises used facts and turns codes into sentences without repeats', () => {
    expect(explainerSummary(explainer())).toBe('Used 1 fact');
    expect(explainerSummary(explainer({ facts: [] }))).toBe('No facts used');
    expect(reasonSentences(explainer())).toEqual(['It matched Chocolate fudge cake.']);
    expect(reasonSentences(explainer({ reasons: ['advice', 'illegal'] }))).toEqual([
      "It doesn't give that kind of advice.",
    ]);
    expect(reasonSentences(explainer({ outcome: 'unavailable', reasons: [] }))[0]).toMatch(
      /couldn't reach its AI service/,
    );
  });

  it('says what customers get instead', () => {
    expect(visitorsLine(explainer())).toBeNull();
    expect(visitorsLine(explainer({ visitorsWouldGet: 'without_unreviewed' }))?.tone).toBe(
      'warning',
    );
    expect(visitorsLine(explainer({ visitorsWouldGet: 'fallback_paused' }))?.tone).toBe('info');
    expect(visitorsLine(explainer({ visitorsWouldGet: 'not_live' }))).toEqual({
      tone: 'caption',
      text: "Your assistant isn't live yet. This is what customers will get.",
    });
  });
});

describe('the proposal card', () => {
  const price: ProposedChange = {
    kind: 'edit_fact',
    factId: '00000000-0000-4000-8000-000000000001',
    factVersion: 1,
    factType: 'product',
    label: 'Chocolate fudge cake',
    before: {
      value: { name: 'Chocolate fudge cake', price: '55.00' },
      gstTreatment: 'inclusive',
      validFrom: null,
      validUntil: null,
    },
    after: {
      value: { name: 'Chocolate fudge cake', price: '58.00' },
      gstTreatment: 'inclusive',
      validFrom: null,
      validUntil: null,
    },
  };

  it('diffs only the changed price, with its GST label', () => {
    expect(diffRows(price)).toEqual([
      { label: 'Price', was: 'S$55.00 · GST incl.', now: 'S$58.00 · GST incl.' },
    ]);
    expect(changeSubject(price)).toBe('Product · Chocolate fudge cake');
    expect(confirmedLine(price)).toBe('Changed. Customers get the new price now.');
  });

  it('shows hours as "Sat 9:00 am – 5:00 pm", and a new FAQ with no "was"', () => {
    const hours: ProposedChange = {
      kind: 'edit_hours',
      profileVersion: 2,
      before: { sat: [{ open: '09:00', close: '13:00' }], sun: [] },
      after: { sat: [{ open: '09:00', close: '17:00' }], sun: [{ open: '09:00', close: '17:00' }] },
    };
    expect(diffRows(hours)).toEqual([
      { label: 'Saturday', was: 'Sat 9:00 am – 1:00 pm', now: 'Sat 9:00 am – 5:00 pm' },
      { label: 'Sunday', was: 'Sun closed', now: 'Sun 9:00 am – 5:00 pm' },
    ]);
    expect(hoursLabel('sun', [{ open: '18:00', close: '24:00' }])).toBe('Sun 6:00 pm – 12:00 am');
    expect(confirmedLine(hours)).toBe('Changed. Customers get the new hours now.');
    const faq: ProposedChange = { kind: 'add_faq', question: 'Gift cards?', answer: 'Yes.' };
    expect(diffRows(faq).every((r) => r.was === null)).toBe(true);
    expect(changeSubject(faq)).toBe('New FAQ');
  });
});

describe('the quick coach panel', () => {
  it('prefills a question for each fact type', () => {
    expect(prefillFor({ type: 'product', value: { name: 'Lemon tart', price: '9.00' } })).toBe(
      'How much is Lemon tart?',
    );
    expect(prefillFor({ type: 'faq', value: { question: 'Do you deliver?', answer: 'Yes' } })).toBe(
      'Do you deliver?',
    );
    expect(
      prefillFor({
        type: 'policy',
        value: { kind: 'refund', title: 'refund policy', details: 'x' },
      }),
    ).toBe("What's your refund policy?");
    expect(
      prefillFor({ type: 'promotion', value: { title: 'Deepavali bundle', details: 'x' } }),
    ).toBe('Is the Deepavali bundle still on?');
  });

  it('sends narrow screens to /coach with the prefill, unreviewed on for a fact under review', () => {
    expect(
      coachAskHref({
        type: 'faq',
        value: { question: 'Halal?', answer: 'No' },
        status: 'approved',
      }),
    ).toBe('/coach?ask=Halal%3F');
    expect(
      coachAskHref({
        type: 'product',
        value: { name: 'Lemon tart', price: '9.00' },
        status: 'needs_review',
      }),
    ).toBe('/coach?ask=How+much+is+Lemon+tart%3F&unreviewed=1');
  });
});

describe('relative time', () => {
  it('reads as minutes, hours, yesterday, then a date', () => {
    const now = new Date('2026-10-24T10:00:00Z');
    expect(relativeTime('2026-10-24T09:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-10-24T09:55:00Z', now)).toBe('5 minutes ago');
    expect(relativeTime('2026-10-24T07:00:00Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-10-23T07:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-10-20T07:00:00Z', now)).toBe('20 Oct');
  });
});
