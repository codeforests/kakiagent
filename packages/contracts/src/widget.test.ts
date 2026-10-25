import { describe, expect, it } from 'vitest';
import {
  ThemeOverrides,
  WidgetAppearanceBody,
  WidgetConfigResponse,
  WidgetSettings,
} from './index.js';

const theme = {
  position: 'left',
  overrides: {
    accent: '#C2410C',
    radius: 8,
    font: { kind: 'custom', family: 'Inter, sans-serif' },
  },
  detected: {
    accent: '#1d4ed8',
    font: 'Lora',
    radius: 6,
    scheme: 'light',
    url: 'https://kakibakery.test/',
    detectedAt: '2026-10-25T01:00:00.000Z',
  },
  logoUrl: 'https://api.kaki.test/widget/v1/logo/wk_x?v=2',
};

describe('website widget contracts (FEAT-032 §3)', () => {
  it('parses a settings response and lower-cases hex colours', () => {
    const s = WidgetSettings.parse({
      widgetKey: 'wk_x',
      snippet: '<script src="https://cdn.kaki.test/w/v1/loader.js" data-key="wk_x" async></script>',
      theme,
      detection: { status: 'done', failure: null, requestedAt: '2026-10-25T01:00:00.000Z' },
      siteUrl: 'https://kakibakery.test',
      allowedOrigins: [{ origin: 'https://kakibakery.test', fromWebsite: true }],
      install: {
        state: 'waiting',
        origin: null,
        seenAt: null,
        lastSeenAt: null,
        rejectedOrigin: null,
        rejectedAt: null,
      },
      previewUrl: 'https://cdn.kaki.test/w/v1/preview.html',
    });
    expect(s.theme.overrides.accent).toBe('#c2410c');
  });

  it('parses a config response with its theme', () => {
    const c = WidgetConfigResponse.parse({
      token: 't',
      visitorId: '7d3c1f9e-0b1a-4c2d-9e8f-0a1b2c3d4e5f',
      realtimeUrl: 'http://localhost:3001',
      panelUrl: 'http://localhost:5175/w/v1/panel.js',
      botName: 'Assistant',
      greeting: { en: 'Hi', zh: '你好' },
      theme: { ...theme, detected: null, logoUrl: null },
    });
    expect(c.theme.position).toBe('left');
  });

  it('rejects a radius of 21, an unsafe custom font and an unknown position', () => {
    expect(ThemeOverrides.safeParse({ radius: 21 }).success).toBe(false);
    expect(ThemeOverrides.safeParse({ radius: 20 }).success).toBe(true);
    for (const family of ['Inter;color:red', 'x{y}', '']) {
      expect(ThemeOverrides.safeParse({ font: { kind: 'custom', family } }).success).toBe(false);
    }
    expect(WidgetAppearanceBody.safeParse({ position: 'top', overrides: {} }).success).toBe(false);
    expect(ThemeOverrides.safeParse({ accent: '#c2410' }).success).toBe(false);
    expect(ThemeOverrides.safeParse({ colour: '#c2410c' }).success).toBe(false);
  });
});
