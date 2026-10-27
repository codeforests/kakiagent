import type { ChannelItem, ChannelsResponse } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import {
  channelStatus,
  degradedBannerText,
  degradedChannels,
  formatWhen,
  HEALTH_REASON,
  offlineBodyOf,
  offlineClause,
  offlineDraftOf,
  resolvedMessage,
  sameOffline,
  validateOffline,
} from './channels.ts';

const NOW = new Date('2026-10-27T06:00:00.000Z');
const widget: ChannelItem = {
  id: '00000000-0000-4000-8000-000000000001',
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
    defaults: { en: "Our chat isn't open yet.", zh: '我们的聊天尚未开放。' },
  },
  version: 1,
};
const telegram: ChannelItem = {
  ...widget,
  id: '00000000-0000-4000-8000-000000000002',
  kind: 'telegram',
  name: 'Telegram',
  state: 'live',
  stateChangedAt: '2026-10-20T06:05:00.000Z',
  checksHealth: true,
  offlineModes: ['message'],
  offline: { ...widget.offline, mode: 'message' },
};

describe('channelStatus', () => {
  it('reads live with its time', () => {
    const s = channelStatus(telegram, NOW);
    expect(s).toMatchObject({ live: true, degraded: false, reason: null });
    expect(s.since).toBe(`Live since ${formatWhen('2026-10-20T06:05:00.000Z')}`);
    expect(s.since).toMatch(/^Live since 20 Oct 2026, 2:05 pm$/);
    expect(s.checked).toBe('Not checked yet');
  });

  it('reads an offline channel that was never live', () => {
    const s = channelStatus(widget, NOW);
    expect(s).toMatchObject({ live: false, since: 'Not live yet', checked: null });
  });

  it('reads offline since the last change', () => {
    const s = channelStatus({ ...widget, stateChangedAt: '2026-10-27T01:00:00.000Z' }, NOW);
    expect(s.since).toMatch(/^Offline since 27 Oct 2026, 9:00 am$/);
  });

  it.each(Object.entries(HEALTH_REASON))('reads degraded with %s', (reason, copy) => {
    const s = channelStatus(
      {
        ...telegram,
        health: 'degraded',
        healthReason: reason as ChannelItem['healthReason'],
        healthCheckedAt: '2026-10-27T05:55:00.000Z',
      },
      NOW,
    );
    expect(s).toMatchObject({ live: true, degraded: true, reason: copy });
    expect(s.checked).toBe('Last checked 5 minutes ago');
  });
});

describe('offline form', () => {
  it('starts from the saved texts, with empty fields where the default applies', () => {
    const d = offlineDraftOf(widget);
    expect(d).toEqual({ mode: 'hidden', en: '', zh: '' });
    expect(resolvedMessage(d, widget)).toEqual(widget.offline.defaults);
    const saved = offlineDraftOf({
      ...widget,
      offline: { ...widget.offline, mode: 'message', message: { en: 'Back soon', zh: null } },
    });
    expect(saved).toEqual({ mode: 'message', en: 'Back soon', zh: '' });
    expect(resolvedMessage(saved, widget)).toEqual({ en: 'Back soon', zh: '我们的聊天尚未开放。' });
  });

  it('accepts 300 characters and refuses 301 with the count', () => {
    const ok = { mode: 'message' as const, en: 'a'.repeat(300), zh: '' };
    expect(validateOffline(ok, widget)).toEqual({});
    expect(validateOffline({ ...ok, zh: '字'.repeat(301) }, widget)).toEqual({
      zh: 'Keep the message under 300 characters (301 now).',
    });
  });

  it('refuses hidden where the channel only shows a message', () => {
    const errors = validateOffline({ mode: 'hidden', en: '', zh: '' }, telegram);
    expect(errors.mode).toBe('Telegram can\'t hide. Choose "Show a message".');
  });

  it('trims, sends null for empty text and compares trimmed', () => {
    const d = { mode: 'message' as const, en: '  Back soon ', zh: '  ' };
    expect(offlineBodyOf(d, 4)).toEqual({
      mode: 'message',
      message: { en: 'Back soon', zh: null },
      version: 4,
    });
    expect(sameOffline(d, { mode: 'message', en: 'Back soon', zh: '' })).toBe(true);
    expect(sameOffline(d, { mode: 'hidden', en: 'Back soon', zh: '' })).toBe(false);
  });

  it('words the go-offline clause by mode', () => {
    expect(offlineClause('message')).toBe('see your message and contact details');
    expect(offlineClause('hidden')).toBe("don't see the chat button");
  });
});

describe('degraded banner', () => {
  const res = (channels: ChannelItem[]): ChannelsResponse => ({ channels, connectable: [] });
  const bad = { ...telegram, health: 'degraded' as const, healthReason: 'unreachable' as const };

  it('picks only degraded channels', () => {
    expect(degradedChannels(undefined)).toEqual([]);
    expect(degradedChannels(res([widget, telegram]))).toEqual([]);
    expect(degradedChannels(res([widget, bad]))).toEqual([bad]);
  });

  it('names one channel, counts several', () => {
    expect(degradedBannerText([])).toBeNull();
    expect(degradedBannerText([bad])).toBe(
      "Telegram isn't working. Visitors there may not get replies.",
    );
    expect(degradedBannerText([bad, { ...bad, name: 'Email' }])).toBe(
      "2 channels aren't working. Visitors there may not get replies.",
    );
  });
});
