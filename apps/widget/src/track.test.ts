import { describe, expect, it } from 'vitest';
import { menuItems, trackingPromptShown } from './chat.js';
import {
  CHOICE_TTL_MS,
  pathOf,
  referrerHost,
  storeChoice,
  storedChoice,
  tracks,
  utmOf,
  uuid,
} from './track.js';

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}
const blocked = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
};

describe('pathOf (FEAT-029 §5.2, D4)', () => {
  it('keeps the path only, decoded', () => {
    expect(pathOf({ pathname: '/catering/menu' })).toBe('/catering/menu');
    expect(pathOf({ pathname: '/kueh%20lapis' })).toBe('/kueh lapis');
    expect(pathOf({ pathname: '' })).toBe('/');
    expect(pathOf(new URL('https://x.test/a/b?email=a@b.c#frag'))).toBe('/a/b');
  });
  it('drops segments with @ or 6+ digits', () => {
    expect(pathOf({ pathname: '/u/jane%40mail.com/orders' })).toBe('/u/orders');
    expect(pathOf({ pathname: '/order/12345678/track' })).toBe('/order/track');
    expect(pathOf({ pathname: '/promo/12345' })).toBe('/promo/12345');
  });
  it('cuts to 512 and survives bad escapes', () => {
    expect(pathOf({ pathname: `/${'a'.repeat(600)}` })).toHaveLength(512);
    expect(pathOf({ pathname: '/%E0%A4%A' })).toBe('/%E0%A4%A');
  });
});

describe('utmOf', () => {
  it('takes the five keys, cut to 100', () => {
    expect(
      utmOf(
        `?utm_source=google&utm_medium=cpc&utm_campaign=${'c'.repeat(150)}&utm_term=kueh&utm_content=ad1&utm_id=9&q=x`,
      ),
    ).toEqual({
      source: 'google',
      medium: 'cpc',
      campaign: 'c'.repeat(100),
      term: 'kueh',
      content: 'ad1',
    });
  });
  it('is undefined with none', () => {
    expect(utmOf('?q=1')).toBeUndefined();
    expect(utmOf('')).toBeUndefined();
  });
});

describe('referrerHost', () => {
  it('keeps an external host only', () => {
    expect(referrerHost('https://www.google.com/search?q=kueh', 'kakibakery.test')).toBe(
      'www.google.com',
    );
    expect(referrerHost('https://kakibakery.test/menu', 'kakibakery.test')).toBeUndefined();
    expect(referrerHost('', 'kakibakery.test')).toBeUndefined();
    expect(referrerHost('not a url', 'kakibakery.test')).toBeUndefined();
  });
});

describe('stored choice (D6)', () => {
  it('round-trips and expires after 12 months', () => {
    const s = memory();
    expect(storedChoice(s)).toBeNull();
    storeChoice('accepted', s, 1000);
    expect(storedChoice(s, 2000)).toBe('accepted');
    expect(storedChoice(s, 1000 + CHOICE_TTL_MS + 1)).toBeNull();
    storeChoice('declined', s, 5000);
    expect(storedChoice(s, 6000)).toBe('declined');
  });
  it('ignores junk and blocked storage without throwing', () => {
    const s = memory();
    s.setItem('kaki.track', '{bad');
    expect(storedChoice(s)).toBeNull();
    s.setItem('kaki.track', JSON.stringify({ c: 'maybe', at: 1 }));
    expect(storedChoice(s)).toBeNull();
    expect(storedChoice(blocked)).toBeNull();
    expect(() => storeChoice('accepted', blocked)).not.toThrow();
    expect(storedChoice(null)).toBeNull();
  });
});

describe('mode and choice', () => {
  it('tracks in on, or consent once accepted', () => {
    expect(tracks('on', null)).toBe(true);
    expect(tracks('off', 'accepted')).toBe(false);
    expect(tracks('consent', null)).toBe(false);
    expect(tracks('consent', 'declined')).toBe(false);
    expect(tracks('consent', 'accepted')).toBe(true);
  });
  it('shows the prompt only in consent mode with no choice (SCR-WGT-007)', () => {
    expect(trackingPromptShown('consent', null)).toBe(true);
    expect(trackingPromptShown('consent', 'accepted')).toBe(false);
    expect(trackingPromptShown('consent', 'declined')).toBe(false);
    expect(trackingPromptShown('on', null)).toBe(false);
    expect(trackingPromptShown('off', null)).toBe(false);
  });
  it('adds the menu item by choice, after the privacy notice (SCR-WGT-002)', () => {
    const config = {
      privacyNoticeUrl: 'https://x.test/privacy',
      controls: { talkToPerson: false },
    } as Parameters<typeof menuItems>[0];
    const base = { conversationId: null, ended: false, preview: false };
    const items = (mode: 'on' | 'off' | 'consent', choice: 'accepted' | 'declined' | null) =>
      menuItems(config, { ...base, tracking: { mode, choice } });
    expect(items('consent', 'accepted')).toEqual(['privacy', 'stopTracking']);
    expect(items('consent', 'declined')).toEqual(['privacy', 'shareTracking']);
    expect(items('consent', null)).toEqual(['privacy']);
    expect(items('on', 'accepted')).toEqual(['privacy']);
    expect(items('off', 'declined')).toEqual(['privacy']);
    expect(
      menuItems(config, {
        ...base,
        preview: true,
        tracking: { mode: 'consent', choice: 'accepted' },
      }),
    ).toEqual(['privacy']);
  });
});

it('uuid is v4-shaped', () => {
  expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
