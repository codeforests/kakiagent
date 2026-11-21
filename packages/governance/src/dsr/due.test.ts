import { describe, expect, it } from 'vitest';
import { addDays, dsrRef, dueState, initials, maskedRequester, requesterLabel } from './due.js';

describe('dueState (FEAT-061 §5.1)', () => {
  const due = '2026-12-20';
  const open = { status: 'open' as const, dueOn: due };
  it('is ok before due − 7, due soon from due − 7 to due, overdue after', () => {
    expect(dueState(open, addDays(due, -8))).toBe('ok');
    expect(dueState(open, addDays(due, -7))).toBe('due_soon');
    expect(dueState(open, due)).toBe('due_soon');
    expect(dueState(open, addDays(due, 1))).toBe('overdue');
  });
  it('is closed for every closed status, whatever the date', () => {
    for (const status of ['completed', 'unverified', 'closed'] as const)
      expect(dueState({ status, dueOn: due }, addDays(due, 9))).toBe('closed');
    expect(dueState({ status: 'verified', dueOn: due }, addDays(due, 9))).toBe('overdue');
  });
  it('adds days across months and leap years', () => {
    expect(addDays('2026-11-20', 30)).toBe('2026-12-20');
    expect(addDays('2028-02-15', 30)).toBe('2028-03-16');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('requester masking (D3)', () => {
  it('labels with initials and the first identifier, masked', () => {
    expect(
      requesterLabel({
        name: 'Tan Mei Ling',
        email: 'mei@gmail.com',
        phone: null,
        telegramId: null,
      }),
    ).toBe('T.M.L. · m•••@gmail.com');
    expect(
      requesterLabel({ name: null, email: null, phone: '+6591234567', telegramId: null }),
    ).toBe('+65 ••••4567');
    expect(requesterLabel({ name: null, email: null, phone: null, telegramId: '123456789' })).toBe(
      'Telegram ••••6789',
    );
    expect(requesterLabel({ name: null, email: null, phone: null, telegramId: null })).toBe(
      'From a conversation',
    );
  });
  it('masks every stored value and keeps none whole', () => {
    const m = maskedRequester({
      name: 'Mei Tan',
      email: 'mei@example.com',
      phone: '+6591234567',
      telegramId: '123456789',
    });
    expect(m).toEqual({
      name: 'M.T.',
      email: 'm•••@example.com',
      phone: '+65 ••••4567',
      telegramId: '••••6789',
    });
    expect(initials('  ')).toBe('');
  });
  it('refs are the first eight hex digits', () => {
    expect(dsrRef('1a2b3c4d-0000-4000-8000-000000000000')).toBe('DSR-1A2B3C4D');
  });
});
