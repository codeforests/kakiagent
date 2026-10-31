import { describe, expect, it } from 'vitest';
import { nextStep, ONBOARDING_STEPS } from './onboarding.js';
import { profileComplete } from './readiness.js';
import type { BusinessProfile } from './profile.js';

describe('wizard steps (FEAT-035 §3)', () => {
  it('runs profile → go-live, and go-live stays last', () => {
    expect(ONBOARDING_STEPS).toEqual([
      'profile',
      'sources',
      'review',
      'rules',
      'test',
      'website',
      'go_live',
    ]);
    expect(nextStep('profile')).toBe('sources');
    expect(nextStep('website')).toBe('go_live');
    expect(nextStep('go_live')).toBe('go_live');
  });
});

describe('profileComplete (D2)', () => {
  const complete: BusinessProfile = {
    version: 1,
    updatedAt: new Date(),
    name: 'Kaki Bakery',
    uen: null,
    industry: 'fnb',
    contactEmail: 'hi@kaki.test',
    contactPhone: null,
    languages: ['en'],
    gstRegistered: false,
    hours: {} as BusinessProfile['hours'],
    openOnPublicHolidays: false,
    exceptions: [],
  };

  it('is complete without a UEN, with an email or a phone', () => {
    expect(profileComplete(complete)).toBe(true);
    expect(profileComplete({ ...complete, contactEmail: null, contactPhone: '+6561234567' })).toBe(
      true,
    );
  });

  it.each([
    ['name', { name: '  ' }],
    ['industry', { industry: null }],
    ['hours', { hours: null }],
    ['contact', { contactEmail: null, contactPhone: null }],
    ['language', { languages: [] }],
  ] as const)('is incomplete without %s', (_, patch) => {
    expect(profileComplete({ ...complete, ...patch } as BusinessProfile)).toBe(false);
  });
});
