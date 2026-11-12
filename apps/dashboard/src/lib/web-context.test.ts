import type { WebContext } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { formatDwell, sourceLine, webRows } from './inbox.ts';
import { trackingModeOf, trackingToggles } from './widget.ts';

describe('tracking toggles (FEAT-029 SCR-APP-037)', () => {
  it('maps the mode to the two toggles and back', () => {
    expect(trackingToggles('off')).toEqual({ track: false, consent: false });
    expect(trackingToggles('on')).toEqual({ track: true, consent: false });
    expect(trackingToggles('consent')).toEqual({ track: true, consent: true });
    for (const m of ['off', 'on', 'consent'] as const) {
      const t = trackingToggles(m);
      expect(trackingModeOf(t.track, t.consent)).toBe(m);
    }
  });
  it('needs tracking on for consent mode', () => {
    expect(trackingModeOf(false, true)).toBe('off');
    expect(trackingModeOf(true, true)).toBe('consent');
    // Turning tracking off from consent mode switches both off.
    expect(trackingModeOf(!trackingToggles('consent').track, true)).toBe('off');
  });
});

describe('formatDwell', () => {
  it('says minutes and hours', () => {
    expect(formatDwell(0)).toBe('under a minute');
    expect(formatDwell(59_000)).toBe('under a minute');
    expect(formatDwell(60_000)).toBe('1 min');
    expect(formatDwell(3 * 60_000 + 20_000)).toBe('3 min');
    expect(formatDwell(60 * 60_000)).toBe('1 h');
    expect(formatDwell(65 * 60_000)).toBe('1 h 5 min');
  });
});

describe('sourceLine', () => {
  it('prefers UTM, then the referrer, then Direct', () => {
    expect(
      sourceLine({ utm: { campaign: 'cny', source: 'google' }, referrer: 'www.google.com' }),
    ).toEqual({
      text: 'utm_source=google · utm_campaign=cny',
      mono: true,
    });
    expect(sourceLine({ utm: null, referrer: 'www.google.com' })).toEqual({
      text: 'From www.google.com',
      mono: false,
    });
    expect(sourceLine({ utm: {}, referrer: null })).toEqual({ text: 'Direct', mono: false });
    expect(sourceLine(null)).toEqual({ text: 'Direct', mono: false });
  });
});

describe('the Intent block by scope (D7)', () => {
  const full: WebContext = {
    scope: 'full',
    currentPage: '/catering',
    viewed: [
      { path: '/catering', dwellMs: 120_000, at: '2026-11-12T02:02:00.000Z' },
      { path: '/menu', dwellMs: 30_000, at: '2026-11-12T02:00:00.000Z' },
    ],
    source: { utm: { source: 'google' }, referrer: null },
    returning: true,
  };
  it('full: now on, viewed with dwell, source, returning', () => {
    expect(webRows(full)).toEqual({
      nowOn: '/catering',
      viewed: [
        { path: '/catering', dwell: '2 min' },
        { path: '/menu', dwell: 'under a minute' },
      ],
      source: { text: 'utm_source=google', mono: true },
      returning: true,
      pageOnly: false,
    });
  });
  it('full with only the current page: no Viewed row', () => {
    expect(webRows({ ...full, viewed: full.viewed.slice(0, 1) }).viewed).toEqual([]);
  });
  it('page_only: only now on, whatever else came', () => {
    expect(webRows({ ...full, scope: 'page_only' })).toEqual({
      nowOn: '/catering',
      viewed: [],
      source: null,
      returning: false,
      pageOnly: true,
    });
  });
  it('email or Telegram: nothing', () => {
    const r = webRows({
      scope: 'page_only',
      currentPage: null,
      viewed: [],
      source: null,
      returning: false,
    });
    expect(r.nowOn).toBeNull();
    expect(r.viewed).toEqual([]);
  });
});
