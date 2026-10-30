import type { ChannelItem, OnboardingProgress, ReadinessResponse } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import {
  finishedCount,
  goLiveBlocked,
  joinNames,
  missingItems,
  nextStep,
  notReadyMissing,
  prevStep,
  READINESS_TEXT,
  stepNumber,
  stepOf,
  stepState,
  STEPS,
} from './onboarding.ts';

const channel = (id: string, state: 'live' | 'offline'): ChannelItem => ({
  id,
  kind: 'widget',
  name: 'Website chat widget',
  state,
  stateChangedAt: null,
  health: 'unknown',
  healthReason: null,
  healthCheckedAt: null,
  degradedSince: null,
  checksHealth: false,
  offlineModes: ['message'],
  offline: { mode: 'message', message: { en: null, zh: null }, defaults: { en: 'x', zh: 'x' } },
  version: 1,
});

const ready: ReadinessResponse = {
  items: ReadinessKeys().map((key) => ({ key, ok: true })),
  warnings: { conflicts: 0, needsReview: 0 },
  ready: true,
  preLiveForm: true,
  firstLiveAt: null,
  channels: [channel('c1', 'offline')],
};

function ReadinessKeys() {
  return ['profile', 'approved_fact', 'disclosure', 'purpose', 'notice', 'terms', 'rules'] as const;
}

describe('steps', () => {
  it('lists the seven steps in wizard order, steps 2–6 skippable', () => {
    expect(STEPS.map((s) => s.key)).toEqual([
      'profile',
      'sources',
      'review',
      'rules',
      'test',
      'website',
      'go_live',
    ]);
    expect(STEPS.filter((s) => s.skippable).map((s) => stepNumber(s.key))).toEqual([2, 3, 4, 5, 6]);
  });

  it('finds the step of a path, with or without a trailing slash', () => {
    expect(stepOf('/setup')?.key).toBe('profile');
    expect(stepOf('/setup/')?.key).toBe('profile');
    expect(stepOf('/setup/go-live')?.key).toBe('go_live');
    expect(stepOf('/settings')).toBeNull();
  });

  it('moves forward and back, stopping at the ends', () => {
    expect(nextStep('profile')?.key).toBe('sources');
    expect(nextStep('website')?.key).toBe('go_live');
    expect(nextStep('go_live')).toBeNull();
    expect(prevStep('sources')?.key).toBe('profile');
    expect(prevStep('profile')).toBeNull();
  });

  it('counts done and skipped steps, and Go live once live', () => {
    const p: OnboardingProgress = {
      currentStep: 'review',
      steps: { profile: 'done', sources: 'skipped' },
      firstLiveAt: null,
    };
    expect(finishedCount(p)).toBe(2);
    expect(stepState(p, 'sources')).toBe('skipped');
    expect(stepState(p, 'go_live')).toBe('not_started');
    const live = { ...p, firstLiveAt: '2026-10-30T10:00:00.000Z' };
    expect(stepState(live, 'go_live')).toBe('done');
    expect(finishedCount(live)).toBe(3);
  });
});

describe('readiness', () => {
  it('lists failing items in contract order', () => {
    const r = {
      ...ready,
      ready: false,
      items: ready.items.map((i) => ({ ...i, ok: !['terms', 'profile'].includes(i.key) })),
    };
    expect(missingItems(r)).toEqual(['profile', 'terms']);
  });

  it('has text for every item; only terms has no fix link', () => {
    for (const key of ReadinessKeys()) expect(READINESS_TEXT[key].label).not.toBe('');
    expect(ReadinessKeys().filter((k) => READINESS_TEXT[k].fix === null)).toEqual(['terms']);
  });

  it('reads the missing keys of a 409 not_ready only', () => {
    const err = new ApiError(409, 'not_ready', 'x', { missing: ['notice', 'rules'] });
    expect(notReadyMissing(err)).toEqual(['notice', 'rules']);
    expect(notReadyMissing(new ApiError(409, 'version_conflict', 'x'))).toBeNull();
    expect(notReadyMissing(new Error('x'))).toBeNull();
  });

  it('blocks Go live for missing items, unacknowledged warnings or no offline channel', () => {
    expect(goLiveBlocked(ready, false, ['c1'])).toBeNull();
    expect(goLiveBlocked({ ...ready, ready: false }, true, ['c1'])).toBe(
      'Fix the missing items to go live.',
    );
    const warned = { ...ready, warnings: { conflicts: 1, needsReview: 0 } };
    expect(goLiveBlocked(warned, false, ['c1'])).toMatch(/I understand/);
    expect(goLiveBlocked(warned, true, ['c1'])).toBeNull();
    expect(goLiveBlocked(ready, false, [])).toBe('Choose a channel to go live on.');
    const live = { ...ready, channels: [channel('c1', 'live')] };
    expect(goLiveBlocked(live, false, ['c1'])).toBe('Choose a channel to go live on.');
  });

  it('joins channel names', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});
