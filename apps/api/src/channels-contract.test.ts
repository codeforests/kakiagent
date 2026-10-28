import {
  ChannelItem,
  ChannelOfflineBody,
  ChannelsResponse,
  ChannelStateBody,
  WidgetConfigResponse,
} from '@kaki/contracts';
import { describe, expect, it } from 'vitest';

const item = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'widget',
  name: 'Website chat widget',
  state: 'offline',
  stateChangedAt: null,
  health: 'ok',
  healthReason: null,
  healthCheckedAt: null,
  degradedSince: null,
  checksHealth: false,
  offlineModes: ['hidden', 'message'],
  offline: {
    mode: 'hidden',
    message: { en: null, zh: null },
    defaults: { en: 'Not open yet.', zh: '尚未开放。' },
  },
  version: 1,
};

describe('channels contract (FEAT-034 §3)', () => {
  it('parses an item, the list and the bodies', () => {
    expect(ChannelItem.parse(item)).toEqual(item);
    expect(ChannelsResponse.parse({ channels: [item], connectable: [] }).channels).toHaveLength(1);
    expect(ChannelStateBody.parse({ version: 2 })).toEqual({ version: 2 });
    expect(
      ChannelOfflineBody.parse({ mode: 'message', message: { en: ' Hi ', zh: null }, version: 1 }),
    ).toEqual({ mode: 'message', message: { en: 'Hi', zh: null }, version: 1 });
  });

  it('rejects a 301-character message, an unknown mode, a degraded reason outside the list', () => {
    const body = { mode: 'message', message: { en: 'x'.repeat(301), zh: null }, version: 1 };
    expect(ChannelOfflineBody.safeParse(body).success).toBe(false);
    expect(
      ChannelOfflineBody.safeParse({ ...body, message: { en: null, zh: null }, mode: 'shown' })
        .success,
    ).toBe(false);
    expect(ChannelItem.safeParse({ ...item, healthReason: 'boom' }).success).toBe(false);
    expect(ChannelStateBody.safeParse({ version: 0 }).success).toBe(false);
  });

  it("the widget config's availability is live, or offline with mode, message and contacts", () => {
    const base = {
      token: 't',
      visitorId: '11111111-1111-4111-8111-111111111111',
      realtimeUrl: 'https://rt.kaki.test',
      panelUrl: 'https://cdn.kaki.test/panel.js',
      botName: 'Assistant',
      greeting: { en: 'Hi', zh: '你好' },
      theme: { position: 'right', overrides: {}, detected: null, logoUrl: null },
      privacyNoticeUrl: null,
      controls: { talkToPerson: false },
    };
    expect(WidgetConfigResponse.safeParse({ ...base, availability: { live: true } }).success).toBe(
      true,
    );
    const offline = {
      live: false,
      mode: 'message',
      message: { en: 'Soon', zh: '即将' },
      contact: { email: null, phone: '+6590000000' },
    };
    expect(WidgetConfigResponse.safeParse({ ...base, availability: offline }).success).toBe(true);
    expect(WidgetConfigResponse.safeParse({ ...base, availability: { live: false } }).success).toBe(
      false,
    );
    expect(WidgetConfigResponse.safeParse(base).success).toBe(false);
  });
});
