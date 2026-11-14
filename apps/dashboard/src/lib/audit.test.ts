import type { AuditVerifyResult } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import {
  actorText,
  auditApiFilter,
  auditExportErrorText,
  auditFileName,
  auditQueryOf,
  auditSearchOf,
  dateRangeError,
  EVENT_TEXT,
  eventText,
  filterCount,
  filterSummary,
  fullTime,
  lastVerifiedText,
  listTime,
  quickRangeOf,
  sgDate,
  showSeqOf,
  subjectLink,
  valueText,
  verifyBusy,
  verifyText,
} from './audit.ts';

const ID = '0b6f4c1e-5a7d-4e8b-9c3a-1f2e3d4c5b6a';
const ID2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
// 18 Nov 2026, 2:14:07 pm in Singapore.
const NOW = new Date('2026-11-18T06:14:07Z');

const result = (over: Partial<AuditVerifyResult> = {}): AuditVerifyResult => ({
  ok: true,
  checked: 12345,
  headSeq: 12345,
  anchors: 'checked',
  anchorsChecked: 48,
  piiChecked: 3,
  broken: null,
  verifiedAt: NOW.toISOString(),
  durationMs: 900,
  ...over,
});

describe('audit filters in the URL', () => {
  it('round-trips every filter', () => {
    const f = {
      from: '2026-11-01',
      to: '2026-11-18',
      group: 'knowledge' as const,
      actorType: 'user' as const,
      actor: ID,
      conversation: ID2,
    };
    expect(auditQueryOf(new URLSearchParams(auditSearchOf(f)))).toEqual(f);
    expect(auditSearchOf({})).toBe('');
  });

  it('drops malformed values so the API never refuses the query', () => {
    const f = auditQueryOf(
      new URLSearchParams(
        'from=2026-11-18&to=2026-11-01&group=nope&actorType=robot&conversation=abc&extra=1',
      ),
    );
    expect(f).toEqual({ from: '2026-11-18' });
  });

  it('a member implies actor type user; a member with another type is dropped', () => {
    expect(auditQueryOf(new URLSearchParams(`actor=${ID}`))).toEqual({
      actor: ID,
      actorType: 'user',
    });
    expect(auditQueryOf(new URLSearchParams(`actor=${ID}&actorType=agent`))).toEqual({
      actorType: 'agent',
    });
  });

  it('maps to the API filter without empty keys and counts set filters', () => {
    expect(auditApiFilter({ group: 'other' })).toEqual({ group: 'other' });
    expect(filterCount({ from: '2026-11-01', to: '2026-11-02', group: 'audit' })).toBe(2);
    expect(filterCount({})).toBe(0);
  });

  it('refuses an end date before the start date', () => {
    expect(dateRangeError('2026-11-02', '2026-11-01')).toBe(
      'End date must be on or after the start date',
    );
    expect(dateRangeError('2026-11-01', '2026-11-01')).toBeUndefined();
  });

  it('quick ranges are Singapore days ending today', () => {
    expect(sgDate(NOW)).toBe('2026-11-18');
    expect(quickRangeOf({ from: '2026-11-12', to: '2026-11-18' }, NOW)?.label).toBe('Last 7 days');
    expect(quickRangeOf({ from: '2026-11-18', to: '2026-11-18' }, NOW)?.label).toBe('Today');
    expect(quickRangeOf({ from: '2026-11-13', to: '2026-11-18' }, NOW)).toBeNull();
  });
});

describe('audit words', () => {
  it('has sentence-case text for the named codes and humanises the rest', () => {
    expect(eventText('message.ai_sent')).toBe('Reply sent by the assistant');
    expect(eventText('audit.verified')).toBe('Audit chain verified');
    expect(eventText('audit.exported')).toBe('Audit log exported');
    expect(eventText('something_new.happened')).toBe('Something new happened');
    for (const t of Object.values(EVENT_TEXT)) expect(t[0]).toBe(t[0]!.toUpperCase());
  });

  it('names actors', () => {
    expect(actorText({ actorType: 'user', actorName: 'Mei Ling' })).toBe('Mei Ling');
    expect(actorText({ actorType: 'user', actorName: null })).toBe('Former member');
    expect(actorText({ actorType: 'agent', actorName: null })).toBe('Assistant');
    expect(actorText({ actorType: 'operator', actorName: null })).toBe('KakiAgent support');
  });

  it('links subjects that have a screen', () => {
    expect(subjectLink({ type: 'conversation', id: ID })).toBe(`/inbox/${ID}`);
    expect(subjectLink({ type: 'fact', id: ID })).toBe(`/knowledge/facts/${ID}`);
    expect(subjectLink({ type: 'member', id: ID })).toBeNull();
  });

  it('formats times in Singapore', () => {
    expect(fullTime(NOW.toISOString())).toBe('18 Nov 2026, 2:14:07 pm');
    expect(listTime(NOW.toISOString(), NOW)).toBe('2:14 pm');
    expect(listTime('2026-11-17T06:14:07Z', NOW)).toBe('Yesterday 2:14 pm');
    expect(listTime('2026-11-10T06:14:07Z', NOW)).toBe('10 Nov, 2:14 pm');
  });

  it('shows payload values as text, objects as JSON', () => {
    expect(valueText('abc')).toEqual({ text: 'abc', mono: false });
    expect(valueText(true).text).toBe('Yes');
    expect(valueText({ a: 1 })).toEqual({ text: '{\n  "a": 1\n}', mono: true });
  });
});

describe('verification texts', () => {
  it('intact with anchors, none yet, and unavailable', () => {
    expect(verifyText(result())).toEqual({
      tone: 'success',
      text: 'Chain intact. 12,345 entries checked against 48 stored checkpoints.',
    });
    expect(verifyText(result({ anchors: 'none_yet', anchorsChecked: 0 })).text).toBe(
      'Chain intact. 12,345 entries checked. The first outside checkpoint is stored within 15 minutes.',
    );
    expect(verifyText(result({ anchors: 'unavailable' })).tone).toBe('warning');
  });

  it('tamper names the entry and the reason in words', () => {
    const r = result({ ok: false, broken: { seq: 4512, reason: 'hash_mismatch' } });
    expect(verifyText(r)).toEqual({
      tone: 'danger',
      text: 'Problem found at entry #4,512. This entry was changed after it was written.',
    });
    expect(showSeqOf(r)).toBe(4512);
    expect(
      showSeqOf(result({ ok: false, headSeq: 90, broken: { seq: 100, reason: 'truncated' } })),
    ).toBe(90);
  });

  it('cooldown and running are states, not errors', () => {
    expect(verifyBusy(new ApiError(429, 'verify_cooldown', 'x', { retryAfterS: 12 }))).toEqual({
      kind: 'cooldown',
      seconds: 12,
    });
    expect(verifyBusy(new ApiError(409, 'verify_running', 'x'))).toEqual({ kind: 'running' });
    expect(verifyBusy(new ApiError(500, 'error', 'x'))).toBeNull();
  });

  it('last verified line', () => {
    expect(
      lastVerifiedText(
        { ok: true, headSeq: 12345, verifiedAt: '2026-11-10T06:14:07Z', by: 'Mei Ling' },
        NOW,
      ),
    ).toBe('Last verified 10 Nov, 2:14 pm by Mei Ling · 12,345 entries');
  });
});

describe('export', () => {
  it('summarises the filters', () => {
    expect(filterSummary({}, [], NOW)).toBe('All entries');
    expect(
      filterSummary({ from: '2026-10-20', to: '2026-11-18', group: 'knowledge' }, [], NOW),
    ).toBe('Filters: Last 30 days · Knowledge');
    expect(
      filterSummary({ actorType: 'user', actor: ID }, [{ id: ID, name: 'Mei Ling' }], NOW),
    ).toBe('Filters: Mei Ling');
  });

  it('names the file and the too-many error', () => {
    expect(auditFileName(NOW, 'json')).toBe('audit-log-2026-11-18.json');
    expect(
      auditExportErrorText(new ApiError(413, 'too_many', 'x', { count: 120000, max: 100000 })),
    ).toBe("That's more than 100,000 entries (120,000). Choose a shorter date range.");
    expect(auditExportErrorText(new Error('x'))).toBe("Couldn't export. Try again.");
  });
});
