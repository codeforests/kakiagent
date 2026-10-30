import { SAFE_DEFAULTS } from '@kaki/approvals';
import { describe, expect, it } from 'vitest';
import { applyBoundary, blockedTopicHit, triageTail } from './boundary.js';
import type { TurnPlan } from './plan.js';

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
