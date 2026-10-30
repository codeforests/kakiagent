import { SAFE_DEFAULTS } from '@kaki/approvals';
import { describe, expect, it } from 'vitest';
import { applyBoundary, blockedTopicHit, boundaryGuard, triageTail } from './boundary.js';
import { ruleText } from './guard.js';
import type { TurnPlan } from './plan.js';
import { buildVisitorPrompt, rulesLines } from './prompt.js';
import { assignRefs } from './slots.js';

const rules = (blockedTopics: string[], allowedTopics: string[] = []) => ({
  ...SAFE_DEFAULTS,
  blockedTopics,
  allowedTopics,
});

describe('blockedTopicHit (FEAT-054 §5.3, AC-6)', () => {
  it.each([
    ['Politics', 'What do you think about politics?', true],
    ['politics', 'POLITICS lah', true],
    ['Competitor price', 'Is your competitor prices lower?', true],
    ["Competitors' prices", 'how about competitor prices', true],
    ['Weight-loss claims', 'any weight loss claims for this cake?', true],
    ['Box', 'do you sell boxes', true],
    // NFKC: full-width letters fold to ASCII.
    ['Politics', 'ｐｏｌｉｔｉｃｓ', true],
    ['政治', '你们怎么看 政治 问题', true],
    ['政治', '请问政治', true],
    // No partial-word hit.
    ['cake', 'pancakes please', false],
    ['art', 'party cake', false],
    ['Politics', 'What time do you open?', false],
  ])('%s in %j → %s', (topic, text, hit) => {
    expect(blockedTopicHit(rules([topic]), text)).toBe(hit);
  });

  it('no topics, no hit', () => {
    expect(blockedTopicHit(SAFE_DEFAULTS, 'anything')).toBe(false);
  });
});

const planOf = (...tasks: TurnPlan['tasks']): TurnPlan => ({
  language: 'en',
  register: 'standard',
  complexity: 0.2,
  confidence: 0.9,
  flags: { complaint: false, injection: false, impersonation: false },
  tasks,
  fallback: false,
});

describe('applyBoundary', () => {
  it('turns answer tasks into one blocked out_of_scope and keeps the others in order', () => {
    const plan = planOf(
      { kind: 'answer', args: {} },
      { kind: 'escalate', args: {} },
      { kind: 'answer', args: {} },
    );
    const out = applyBoundary(plan, rules(['politics']), 'politics and a person please');
    expect(out.blocked).toBe(true);
    expect(out.plan.tasks).toEqual([
      { kind: 'out_of_scope', args: { topic: 'blocked' } },
      { kind: 'escalate', args: {} },
    ]);
  });

  it("follows triage's blocked topic when the phrase doesn't match", () => {
    const plan = planOf(
      { kind: 'answer', args: {} },
      { kind: 'out_of_scope', args: { topic: 'blocked' } },
    );
    const out = applyBoundary(plan, rules(['competitor prices']), 'is brand x cheaper?');
    expect(out.blocked).toBe(true);
    expect(out.plan.tasks).toEqual([{ kind: 'out_of_scope', args: { topic: 'blocked' } }]);
  });

  it('leaves the plan alone when nothing is blocked', () => {
    const plan = planOf({ kind: 'answer', args: {} });
    expect(applyBoundary(plan, rules(['politics']), 'opening hours?')).toEqual({
      plan,
      blocked: false,
    });
  });
});

describe('triageTail', () => {
  it('is absent without topics, so the triage request is unchanged', () => {
    expect(triageTail(SAFE_DEFAULTS)).toBeUndefined();
  });

  it('lists the topics as data', () => {
    expect(triageTail(rules(['<b>Politics</b>'], ['Menu']))).toBe(
      'Topics this business handles: ["Menu"]\nTopics it doesn\'t discuss: ["‹b›Politics‹/b›"]',
    );
  });
});

describe('boundaryGuard (FEAT-054 §5.3, AC-7)', () => {
  const all = boundaryGuard({ ...SAFE_DEFAULTS, customCommitments: ['same-day delivery'] });
  const kinds = (
    g: ReturnType<typeof boundaryGuard>,
    text: string,
    spans: [number, number][] = [],
  ) => g.check(text, spans).map((v) => v.kind);

  it.each([
    ['Sure, we can give you a special price!', 'discount_offer'],
    ["I'll offer you a small discount on that.", 'discount_offer'],
    ['A discount for you is possible.', 'discount_offer'],
    ['可以给您打折！', 'discount_offer'],
    ['Yes, we guarantee it will arrive on time.', 'commitment'],
    ['It will definitely arrive by then.', 'commitment'],
    ['Delivery is guaranteed.', 'commitment'],
    ['We will give you a full refund.', 'commitment'],
    ['There is a money-back promise.', 'commitment'],
    ['我们保证准时送达！', 'commitment'],
    ['一定会准时送达！', 'commitment'],
    ['我们可以退款。', 'commitment'],
    ['We can do Same-Day Delivery for you.', 'commitment'],
  ])('%j → %s', (text, kind) => {
    expect(kinds(all, text)).toEqual([kind]);
  });

  it.each([
    "We don't offer discounts, sorry.",
    'We cannot give discounts.',
    "We can't guarantee delivery times; the team will confirm.",
    'Our delivery fee is S$10.',
    'Our refund policy is on the website.',
    'The team will confirm any special price with you.',
    '我们不打折。',
    '我们不退款。',
    '不一定能准时送达，团队会跟您确认。',
  ])('%j passes', (text) => {
    expect(all.check(text, [])).toEqual([]);
  });

  it('never scans slot renderings (the business’s own policy text)', () => {
    const text = 'Our policy: Cancel 2 days ahead for a full refund, money-back guaranteed.';
    const start = text.indexOf('Cancel');
    expect(all.check(text, [[start, text.length]])).toEqual([]);
  });

  it('checks only the commitments still forbidden; discount offers always (D4)', () => {
    const open = boundaryGuard({
      forbiddenCommitments: ['legal_advice', 'medical_advice'],
      customCommitments: [],
    });
    expect(kinds(open, 'Yes, we guarantee it will arrive on time.')).toEqual([]);
    expect(kinds(open, 'We will give you a full refund.')).toEqual([]);
    expect(kinds(open, 'Sure, we can give you a special price!')).toEqual(['discount_offer']);
  });
});

describe('rulesLines in the reply prompt', () => {
  const req = (rules?: Parameters<typeof rulesLines>[0]) =>
    buildVisitorPrompt({
      businessName: 'Kaki Bakery',
      gstRegistered: true,
      facts: assignRefs([]),
      ordered: [],
      history: [{ role: 'user', content: 'hi' }],
      now: new Date('2026-10-30T04:00:00Z'),
      meta: { tenantId: '11111111-1111-4111-8111-111111111111' },
      model: 'reply.simple',
      rules,
    });

  it('sits after <business>, so the leak guard treats it as tenant data', () => {
    const r = req({ ...rules(['Politics'], ['Cakes']), customCommitments: ['same-day delivery'] });
    expect(r.system.indexOf('<rules>')).toBeGreaterThan(r.system.indexOf('<business>'));
    expect(ruleText(r)).not.toContain('Never offer or hint at a discount');
    expect(r.system).toContain('Topics you help with: Cakes');
    expect(r.system).toContain("Topics you never discuss; say you can't help with that: Politics");
    expect(r.system).toContain(
      'Never promise: delivery dates or guaranteed delivery; refunds or money back; same-day delivery.',
    );
    expect(r.system).toContain('Never quote a total or accept a custom order');
  });

  it('is byte-stable for the same rules, and absent without rules', () => {
    expect(req(SAFE_DEFAULTS).system).toBe(req(SAFE_DEFAULTS).system);
    expect(req().system).not.toContain('<rules>');
    expect(rulesLines({ ...SAFE_DEFAULTS, quotesNeedApproval: false })).not.toContain(
      'Never quote a total or accept a custom order; say the team will confirm it.',
    );
  });
});
