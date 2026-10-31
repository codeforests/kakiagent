import { describe, expect, it } from 'vitest';
import { GoLiveBody, NotReady, OnboardingProgress, StepOutcomeBody } from './index.js';

const ID = '7b2f0c7e-5a3c-4a8e-9a51-0d6f3b1f2a10';

describe('onboarding contracts (FEAT-035 §3)', () => {
  it('progress takes a partial step map and refuses unknown steps or outcomes', () => {
    const ok = { currentStep: 'review', steps: { profile: 'done' }, firstLiveAt: null };
    expect(OnboardingProgress.parse(ok)).toEqual(ok);
    expect(OnboardingProgress.safeParse({ ...ok, currentStep: 'billing' }).success).toBe(false);
    expect(OnboardingProgress.safeParse({ ...ok, steps: { profile: 'visited' } }).success).toBe(
      false,
    );
    expect(StepOutcomeBody.safeParse({ outcome: 'skipped' }).success).toBe(true);
    expect(StepOutcomeBody.safeParse({ outcome: 'later' }).success).toBe(false);
  });

  it('go-live needs one to ten channels and the acknowledgement flag', () => {
    const ch = { id: ID, version: 1 };
    expect(GoLiveBody.safeParse({ channels: [ch], acknowledgeWarnings: false }).success).toBe(true);
    expect(GoLiveBody.safeParse({ channels: [], acknowledgeWarnings: true }).success).toBe(false);
    expect(
      GoLiveBody.safeParse({ channels: Array(11).fill(ch), acknowledgeWarnings: true }).success,
    ).toBe(false);
    expect(GoLiveBody.safeParse({ channels: [ch] }).success).toBe(false);
    expect(
      GoLiveBody.safeParse({ channels: [{ id: 'nope', version: 1 }], acknowledgeWarnings: true })
        .success,
    ).toBe(false);
  });

  it('not ready names at least one known item', () => {
    expect(NotReady.safeParse({ error: 'not_ready', missing: ['terms'] }).success).toBe(true);
    expect(NotReady.safeParse({ error: 'not_ready', missing: [] }).success).toBe(false);
    expect(NotReady.safeParse({ error: 'not_ready', missing: ['uen'] }).success).toBe(false);
  });
});
