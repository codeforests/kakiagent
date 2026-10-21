import { describe, expect, it } from 'vitest';
import { renderSegment } from './render.js';
import { Segmenter } from './segment.js';
import { assignRefs } from './slots.js';
import { FUDGE } from './testing/facts.js';
import { verifySegment } from './verify.js';

const facts = assignRefs([FUDGE]);
const ref = facts.refOf.get(FUDGE.id)!;
const EN = new Map([
  ['hours.sat', '9:00 am – 5:00 pm'],
  ['hours.sun', '9:00 am – 1:00 pm'],
  ['next_open', 'tomorrow at 8:00 am'],
]);
const ZH = new Map([
  ['hours.sat', '上午9:00至下午5:00'],
  ['hours.sun', '上午9:00至中午1:00'],
]);

function check(raw: string, system: Map<string, string>, visitor: string[] = []) {
  const r = renderSegment(raw, facts, true, system);
  if (!r.ok) return { text: null, ok: false, kinds: r.violations.map((v) => v.kind) };
  const v = verifySegment(r.text, r.spans, visitor);
  return { text: r.text, ok: v.ok, kinds: v.ok ? [] : v.violations.map((x) => x.kind), r };
}

describe('system slots (FEAT-023 AC-8; ADR-025 decision 5)', () => {
  it('renders hours and the next opening as protected spans', () => {
    const out = check('On Saturday we open [[s:hours.sat]]. We reopen [[s:next_open]].', EN);
    expect(out).toMatchObject({
      ok: true,
      text: 'On Saturday we open 9:00 am – 5:00 pm. We reopen tomorrow at 8:00 am.',
    });
    expect(out.r && out.r.ok && out.r.slots).toEqual(['hours.sat', 'next_open']);
  });

  it('answers J7 in Chinese from the hours slots only', () => {
    const out = check('周六营业时间是[[s:hours.sat]]，周日是[[s:hours.sun]]。', ZH, [
      '请问周末营业时间？',
    ]);
    expect(out).toMatchObject({
      ok: true,
      text: '周六营业时间是上午9:00至下午5:00，周日是上午9:00至中午1:00。',
    });
  });

  it('blocks hours the model typed itself', () => {
    expect(check('周六9点到5点营业。', ZH).kinds).toContain('time');
    expect(check('We open at 9am on Saturday.', EN).kinds).toContain('time');
    expect(check('Saturday 9:00 to 17:00.', EN).ok).toBe(false);
  });

  it('fails an unknown or unavailable system slot', () => {
    expect(check('[[s:hours.xyz]]', EN).kinds).toEqual(['unknown_field']);
    expect(check('We reopen [[s:next_open]].', ZH).kinds).toEqual(['unknown_field']);
  });

  it('mixes fact and system slots, and never cuts a system slot', () => {
    expect(
      check(`The [[f:${ref}.name]] is [[f:${ref}.price]]; Sunday [[s:hours.sun]].`, EN).ok,
    ).toBe(true);
    const seg = new Segmenter();
    expect(seg.push('We open [[s:hou')).toEqual([]);
    expect(seg.push('rs.sat]]. Next.')).toEqual(['We open [[s:hours.sat]].']);
  });
});

describe('the number rule in Chinese and Singlish (FEAT-023 AC-2, AC-3, D7)', () => {
  const none = new Map<string, string>();
  it('lets Chinese weekday names and 三明治 through', () => {
    for (const text of [
      '星期六有营业。',
      '周日也可以。',
      '礼拜天休息。',
      '我们有三明治。',
      '週一見。',
    ])
      expect(check(text, none)).toMatchObject({ ok: true });
  });

  it('still blocks typed Chinese times, dates and durations', () => {
    expect(check('九点开门。', none).kinds).toContain('time');
    expect(check('9点半取货。', none).kinds).toContain('time');
    expect(check('10月24日有优惠。', none).kinds).toContain('date');
    expect(check('需要三天。', none).kinds).toContain('duration');
    expect(check('周六三点见。', none).ok).toBe(false);
  });

  it('lets Singlish emphatic "one" before a particle through, and nothing else', () => {
    expect(check(`This one nice one lah, the [[f:${ref}.name]].`, none)).toMatchObject({
      ok: true,
    });
    expect(check(`Can, very popular one ah.`, none).ok).toBe(true);
    expect(check('We have one.', none).kinds).toContain('number');
    expect(check('$55 only lah.', none).kinds).toContain('currency');
    expect(check('Can collect 3pm.', none).kinds).toContain('time');
  });
});
