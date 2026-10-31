import { describe, expect, it } from 'vitest';
import {
  Message,
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
      privacyNoticeUrl: null,
      controls: { talkToPerson: false },
      availability: { live: true },
      aiPaused: null,
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

describe('visitor controls contracts (FEAT-033 §3)', () => {
  const config = {
    token: 't',
    visitorId: '7d3c1f9e-0b1a-4c2d-9e8f-0a1b2c3d4e5f',
    realtimeUrl: 'http://localhost:3001',
    panelUrl: 'http://localhost:5175/w/v1/panel.js',
    botName: 'Assistant',
    greeting: { en: 'Hi', zh: '你好' },
    theme: { ...theme, detected: null, logoUrl: null },
    controls: { talkToPerson: false },
    availability: { live: true },
    aiPaused: null,
  };

  it('parses a config with a null and a set privacy URL, and rejects a non-URL', () => {
    expect(WidgetConfigResponse.parse({ ...config, privacyNoticeUrl: null }).privacyNoticeUrl).toBe(
      null,
    );
    const set = WidgetConfigResponse.parse({
      ...config,
      privacyNoticeUrl: 'https://kakibakery.test/privacy',
    });
    expect(set.privacyNoticeUrl).toBe('https://kakibakery.test/privacy');
    expect(set.controls.talkToPerson).toBe(false);
    expect(
      WidgetConfigResponse.safeParse({ ...config, privacyNoticeUrl: 'not a url' }).success,
    ).toBe(false);
  });

  it("parses a message with language 'zh' and null, and rejects another language", () => {
    const m = {
      id: '7d3c1f9e-0b1a-4c2d-9e8f-0a1b2c3d4e5f',
      conversationId: '7d3c1f9e-0b1a-4c2d-9e8f-0a1b2c3d4e5e',
      seq: 2,
      author: 'agent',
      body: '你好',
      inReplyTo: null,
      disclosure: null,
      notice: null,
      noticeKind: null,
      authorName: null,
      createdAt: '2026-10-26T01:00:00.000Z',
    };
    expect(Message.parse({ ...m, language: 'zh' }).language).toBe('zh');
    expect(Message.parse({ ...m, language: null }).language).toBe(null);
    expect(Message.safeParse({ ...m, language: 'fr' }).success).toBe(false);
  });
});
