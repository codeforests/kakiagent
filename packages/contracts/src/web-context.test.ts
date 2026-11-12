import { describe, expect, it } from 'vitest';
import {
  ContextSidebar,
  PagePath,
  SendMessageBody,
  TrackBody,
  TrackingChoiceBody,
  Utm,
  WebContext,
  WidgetConfigResponse,
  WidgetTrackingBody,
} from './index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const AT = '2026-11-18T06:05:00.000Z';
const view = { type: 'view', id: ID, sessionId: ID, path: '/menu', at: AT } as const;
const engage = { type: 'engage', id: ID, dwellMs: 4000, scroll: 60 } as const;

describe('web context contracts (FEAT-029 §3)', () => {
  it('round-trips the bodies and the sidebar block', () => {
    const body = {
      token: 't',
      events: [{ ...view, referrer: 'google.com', utm: { source: 'ig', campaign: 'cny' } }, engage],
    };
    expect(TrackBody.parse(body)).toEqual(body);
    for (const choice of ['accepted', 'declined'] as const)
      expect(TrackingChoiceBody.parse({ choice })).toEqual({ choice });
    for (const mode of ['off', 'on', 'consent'] as const)
      expect(WidgetTrackingBody.parse({ mode })).toEqual({ mode });
    const web = {
      scope: 'full',
      currentPage: '/cakes/premium',
      viewed: [{ path: '/cakes', dwellMs: 12000, at: AT }],
      source: { utm: { source: 'ig' }, referrer: null },
      returning: true,
    } as const;
    expect(WebContext.parse(web)).toEqual(web);
    expect(
      SendMessageBody.parse({ text: 'hi', clientMessageId: 'abcdefgh', page: '/menu' }).page,
    ).toBe('/menu');
  });

  it('PagePath needs a leading slash and fits 512 characters', () => {
    expect(PagePath.safeParse('menu').success).toBe(false);
    expect(PagePath.safeParse('https://x.test/menu').success).toBe(false);
    expect(PagePath.safeParse('/' + 'x'.repeat(511)).success).toBe(true);
    expect(PagePath.safeParse('/' + 'x'.repeat(512)).success).toBe(false);
  });

  it('TrackBody refuses 21 events, extra keys and bad engagement', () => {
    expect(TrackBody.safeParse({ token: 't', events: Array(20).fill(engage) }).success).toBe(true);
    expect(TrackBody.safeParse({ token: 't', events: Array(21).fill(engage) }).success).toBe(false);
    expect(TrackBody.safeParse({ token: 't', events: [] }).success).toBe(false);
    expect(TrackBody.safeParse({ token: 't', events: [engage], extra: 1 }).success).toBe(false);
    expect(TrackBody.safeParse({ token: 't', events: [{ ...view, url: 'x' }] }).success).toBe(
      false,
    );
    expect(TrackBody.safeParse({ token: 't', events: [{ ...engage, scroll: 101 }] }).success).toBe(
      false,
    );
  });

  it('Utm takes only the five keys, each at most 100 characters', () => {
    expect(Utm.safeParse({ source: 'a', gclid: 'x' }).success).toBe(false);
    expect(Utm.safeParse({ term: 'x'.repeat(101) }).success).toBe(false);
  });

  it('config defaults tracking to off and the sidebar requires web', () => {
    expect(WidgetConfigResponse.shape.tracking.parse(undefined)).toEqual({ mode: 'off' });
    expect(ContextSidebar.shape.web).toBe(WebContext);
  });
});
