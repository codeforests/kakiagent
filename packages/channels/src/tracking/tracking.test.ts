import { describe, expect, it } from 'vitest';
import {
  clampViewedAt,
  distinctViews,
  maskPath,
  maskUtm,
  referrerHost,
  trackingColumns,
  trackingMode,
} from './index.js';

describe('tracking helpers (FEAT-029 §5.1, §5.3, §5.5)', () => {
  it('maps the two booleans to a mode and back', () => {
    expect(trackingMode({ enabled: false, consentMode: true })).toBe('off');
    expect(trackingMode({ enabled: true, consentMode: false })).toBe('on');
    expect(trackingMode({ enabled: true, consentMode: true })).toBe('consent');
    for (const mode of ['off', 'on', 'consent'] as const) {
      const c = trackingColumns(mode);
      expect(trackingMode({ enabled: c.trackingEnabled, consentMode: c.trackingConsentMode })).toBe(
        mode,
      );
    }
  });

  it('clamps the client time to the last hour', () => {
    const now = new Date('2026-11-12T10:00:00Z');
    expect(clampViewedAt('2026-11-12T11:00:00Z', now)).toEqual(now);
    expect(clampViewedAt('2026-11-12T07:00:00Z', now)).toEqual(new Date('2026-11-12T09:00:00Z'));
    expect(clampViewedAt('2026-11-12T09:30:00Z', now)).toEqual(new Date('2026-11-12T09:30:00Z'));
  });

  it('masks NRIC and card numbers in paths and UTM values', () => {
    expect(maskPath('/u/S1234567D')).not.toContain('S1234567D');
    expect(maskPath('/u/S1234567D').startsWith('/')).toBe(true);
    const utm = maskUtm({ source: 'ig', campaign: 'S1234567D', term: '  ' });
    expect(utm).toEqual({ source: 'ig', campaign: expect.not.stringContaining('S1234567D') });
    expect(maskUtm({})).toBeNull();
    expect(maskUtm(undefined)).toBeNull();
  });

  it('keeps a referrer host only', () => {
    expect(referrerHost('Google.com')).toBe('google.com');
    expect(referrerHost('https://google.com/search?q=x')).toBeNull();
    expect(referrerHost(undefined)).toBeNull();
  });

  it('lists views newest first, distinct by path, summing dwell, at most 10', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 12, 10, m));
    const rows = [
      { path: '/a', dwellMs: 1, viewedAt: at(5) },
      { path: '/b', dwellMs: 2, viewedAt: at(4) },
      { path: '/a', dwellMs: 3, viewedAt: at(3) },
      ...Array.from({ length: 12 }, (_, i) => ({ path: `/p${i}`, dwellMs: 0, viewedAt: at(2) })),
    ];
    const v = distinctViews(rows);
    expect(v).toHaveLength(10);
    expect(v[0]).toEqual({ path: '/a', dwellMs: 4, at: at(5).toISOString() });
    expect(v[1]!.path).toBe('/b');
  });
});
