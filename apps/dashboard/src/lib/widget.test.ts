import type { InstallCheck, WidgetSettings, WidgetTheme } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import {
  adjustedNote,
  defaultAccent,
  detectionCopy,
  draftOf,
  installChip,
  installLine,
  isPreviewReady,
  matchLabel,
  originError,
  pollInterval,
  previewMessage,
  previewScheme,
  resetDraft,
  sameDraft,
  withOverride,
} from './widget.ts';

const NOW = new Date('2026-10-25T04:00:00.000Z');
const theme: WidgetTheme = {
  position: 'right',
  overrides: {},
  detected: {
    accent: '#c2410c',
    font: 'Lora',
    radius: 7.6,
    scheme: 'dark',
    url: 'https://kakibakery.sg/',
    detectedAt: '2026-10-24T03:00:00.000Z',
  },
  logoUrl: null,
};
const install: InstallCheck = {
  state: 'waiting',
  origin: null,
  seenAt: null,
  lastSeenAt: null,
  rejectedOrigin: null,
  rejectedAt: null,
};
const settings = (over: Partial<WidgetSettings> = {}): WidgetSettings => ({
  widgetKey: 'wk_1',
  snippet: '<script src="x"></script>',
  theme,
  detection: { status: 'done', failure: null, requestedAt: '2026-10-24T02:59:00.000Z' },
  siteUrl: 'https://kakibakery.sg',
  allowedOrigins: [],
  install,
  previewUrl: 'http://localhost:5175/w/v1/preview.html',
  ...over,
});

describe('install check', () => {
  it('labels each state with text, not colour alone', () => {
    expect(installChip(install)).toEqual({ tone: 'neutral', text: 'Waiting for your website' });
    expect(installChip({ ...install, state: 'detected', origin: 'https://kakibakery.sg' })).toEqual(
      { tone: 'success', text: 'Installed on kakibakery.sg' },
    );
    expect(
      installChip({ ...install, state: 'wrong_domain', rejectedOrigin: 'https://shop.other.sg' }),
    ).toEqual({ tone: 'warning', text: "Loaded on shop.other.sg, which isn't allowed" });
  });

  it('says when it was last seen', () => {
    expect(installLine(install, NOW)).toMatch(/turns green/);
    const seen = { ...install, state: 'detected' as const, lastSeenAt: '2026-10-25T03:55:00Z' };
    expect(installLine(seen, NOW)).toBe('Last seen 5 minutes ago.');
  });

  it('polls only while something is still moving (D8)', () => {
    expect(pollInterval(undefined)).toBe(false);
    expect(pollInterval(settings())).toBe(5000);
    const done = { ...install, state: 'detected' as const, origin: 'https://kakibakery.sg' };
    expect(pollInterval(settings({ install: done }))).toBe(false);
    expect(
      pollInterval(
        settings({
          install: done,
          detection: { status: 'running', failure: null, requestedAt: null },
        }),
      ),
    ).toBe(5000);
  });
});

describe('detection copy', () => {
  it('covers running, done, failed and never', () => {
    expect(
      detectionCopy(
        settings({ detection: { status: 'queued', failure: null, requestedAt: null } }),
      ),
    ).toBe('Matching your website…');
    expect(detectionCopy(settings())).toBe('Matched to kakibakery.sg on 24 Oct 2026');
    expect(
      detectionCopy(
        settings({ detection: { status: 'failed', failure: 'blocked', requestedAt: null } }),
      ),
    ).toBe("kakibakery.sg isn't a public website we can open.");
    expect(
      detectionCopy(
        settings({ detection: { status: 'failed', failure: 'timeout', requestedAt: null } }),
      ),
    ).toBe('kakibakery.sg took too long to load.');
    expect(
      detectionCopy(
        settings({
          theme: { ...theme, detected: null },
          detection: { status: 'none', failure: null, requestedAt: null },
        }),
      ),
    ).toBeNull();
  });

  it('labels the "Match my website" options', () => {
    expect(matchLabel(theme, 'accent')).toBe('Match my website (#c2410c)');
    expect(matchLabel(theme, 'font')).toBe('Match my website (Lora)');
    expect(matchLabel(theme, 'radius')).toBe('Match my website (8 px)');
    expect(matchLabel({ ...theme, detected: null }, 'font')).toBe(
      'Match my website (not checked yet)',
    );
  });
});

describe('adjusted for contrast (D5)', () => {
  it('names the clamped colour only when it changed', () => {
    expect(adjustedNote('#f6c453', 'light')).toMatch(
      /^Adjusted to #[0-9a-f]{6} so text stays readable\.$/,
    );
    expect(adjustedNote('#f6c453', 'light')).not.toContain('#f6c453');
    expect(adjustedNote('#c2410c', 'dark')).toBeNull();
    expect(defaultAccent('light')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('appearance draft', () => {
  it('sets, clears and resets overrides; compares regardless of key order', () => {
    const d = draftOf(theme);
    const red = withOverride(d, 'accent', '#ff0000');
    expect(red.overrides).toEqual({ accent: '#ff0000' });
    expect(sameDraft(d, red)).toBe(false);
    expect(withOverride(red, 'accent', undefined).overrides).toEqual({});
    const both = withOverride(withOverride(d, 'radius', 6), 'scheme', 'dark');
    const other = { position: 'right' as const, overrides: { scheme: 'dark' as const, radius: 6 } };
    expect(sameDraft(both, other)).toBe(true);
    expect(resetDraft({ position: 'left', overrides: { radius: 6 } })).toEqual({
      position: 'left',
      overrides: {},
    });
    expect(previewScheme(theme)).toBe('dark');
    expect(previewScheme({ overrides: { scheme: 'light' }, detected: theme.detected })).toBe(
      'light',
    );
  });
});

describe('preview message', () => {
  it('carries the draft, scheme and the site font', () => {
    const m = previewMessage(theme, { position: 'left', overrides: { radius: 0 } }, 'light', {
      botName: 'Kaki',
      greeting: 'Hi!',
    });
    expect(m).toEqual({
      type: 'kaki-preview',
      theme: { ...theme, position: 'left', overrides: { radius: 0 } },
      botName: 'Kaki',
      greeting: 'Hi!',
      scheme: 'light',
      site: { background: null, font: 'Lora' },
    });
    expect(isPreviewReady({ type: 'kaki-preview-ready' })).toBe(true);
    expect(isPreviewReady('kaki-preview-ready')).toBe(false);
  });
});

describe('origin errors', () => {
  it('maps each code', () => {
    expect(originError('origin_exists', 'shop.sg')).toBe('shop.sg is already on the list.');
    expect(originError('too_many_origins', '')).toBe('You can add up to 20 websites.');
    expect(originError('invalid_origin', '')).toMatch(/like shop\.example\.sg/);
  });
});
