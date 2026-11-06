import { describe, expect, it } from 'vitest';
import { approvalNotice, autoQuoteFollowUp, withoutFlaggedCommitments } from './approval.js';

// Thu 5 Nov 2026, 12:30 SGT.
const now = new Date('2026-11-05T04:30:00Z');

describe('approvalNotice (APR-04, UC-22 3, 3a; FEAT-055 AC-3, AC-11)', () => {
  it('in hours names the SLA due time in SGT', () => {
    const dueAt = new Date('2026-11-05T06:30:00Z');
    const base = { status: 'drafted' as const, afterHours: false, dueAt, nextOpen: null, now };
    expect(approvalNotice('en', base)).toBe(
      'Thanks! Our team is checking this and will reply by 2:30 pm today.',
    );
    expect(approvalNotice('zh', base)).toContain('团队正在确认');
    expect(approvalNotice('zh', base)).toContain('今天');
  });

  it('after hours says the next business day with the opening time', () => {
    const nextOpen = new Date('2026-11-06T01:00:00Z'); // Fri 9:00 am
    const dueAt = new Date('2026-11-06T03:00:00Z'); // Fri 11:00 am
    const text = approvalNotice('en', {
      status: 'drafted',
      afterHours: true,
      dueAt,
      nextOpen,
      now,
    });
    expect(text).toContain('next business day');
    expect(text).toContain('we open tomorrow at 9:00 am');
    expect(text).toContain('by 11:00 am tomorrow');
    expect(
      approvalNotice('zh', { status: 'drafted', afterHours: true, dueAt, nextOpen, now }),
    ).toContain('下一个营业日');
  });

  it('a repeat while pending says the team is still checking', () => {
    const dueAt = new Date('2026-11-09T02:00:00Z'); // Mon 10:00 am
    expect(
      approvalNotice('en', {
        status: 'already_pending',
        afterHours: false,
        dueAt,
        nextOpen: null,
        now,
      }),
    ).toMatch(/^Our team is still checking your earlier request and will reply by 10:00 am on /);
  });

  it('never carries a price or a discount', () => {
    const dueAt = new Date('2026-11-05T06:30:00Z');
    for (const lang of ['en', 'zh'] as const) {
      const t = approvalNotice(lang, {
        status: 'drafted',
        afterHours: false,
        dueAt,
        nextOpen: null,
        now,
      });
      expect(t).not.toMatch(/S\$|%/);
      expect(autoQuoteFollowUp(lang)).not.toMatch(/S\$|%/);
    }
  });
});

describe('withoutFlaggedCommitments (AGT-07)', () => {
  const plan = (injection: boolean, impersonation: boolean) => ({
    flags: { injection, impersonation },
    tasks: [{ kind: 'answer' }, { kind: 'request_commitment' }],
  });
  it('drops the request on an injection or impersonation, else keeps the plan', () => {
    expect(withoutFlaggedCommitments(plan(true, false)).tasks).toEqual([{ kind: 'answer' }]);
    expect(withoutFlaggedCommitments(plan(false, true)).tasks).toEqual([{ kind: 'answer' }]);
    const clean = plan(false, false);
    expect(withoutFlaggedCommitments(clean)).toBe(clean);
  });
});
