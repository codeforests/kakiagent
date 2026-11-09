import { describe, expect, it } from 'vitest';
import { backoffMs } from './deliver.js';
import { EMAIL_CAPABILITIES } from './email/capabilities.js';
import { classifySmtp } from './email/send.js';
import { shapeOutbound, type ShapeInput } from './shape.js';

const ctx = {
  capabilities: EMAIL_CAPABILITIES,
  businessName: 'Kaki Bakery',
  privacyUrl: 'https://kakibakery.test/privacy',
};
const msg = (over: Partial<ShapeInput>): ShapeInput => ({
  author: 'agent',
  body: 'Yes, we deliver to Tampines.',
  notice: null,
  noticeKind: null,
  disclosure: null,
  card: null,
  ...over,
});
const FOOTER = '\n\n-- \nKaki Bakery · Privacy notice: https://kakibakery.test/privacy';

describe('shapeOutbound (CHN-01; FEAT-036 §5.3)', () => {
  it.each([
    ['a plain reply', msg({}), 'Yes, we deliver to Tampines.' + FOOTER],
    [
      'the disclosure on the first AI message (AGT-11)',
      msg({ disclosure: "I'm Kaki Bakery's AI assistant." }),
      "I'm Kaki Bakery's AI assistant.\n\nYes, we deliver to Tampines." + FOOTER,
    ],
    [
      'an after-hours notice under the reply',
      msg({ notice: "We're closed now; the team replies tomorrow.", noticeKind: 'after_hours' }),
      "Yes, we deliver to Tampines.\n\nWe're closed now; the team replies tomorrow." + FOOTER,
    ],
    [
      'a card dropped, its text kept (D7)',
      msg({ body: 'May we keep your details?', card: { kind: 'consent' } }),
      'May we keep your details?' + FOOTER,
    ],
    [
      'a staff reply',
      msg({ author: 'staff', body: 'Hi Mei, Ah Kow here.' }),
      'Hi Mei, Ah Kow here.' + FOOTER,
    ],
    [
      'an approval notice whose body is its notice',
      msg({
        author: 'system',
        body: 'The team is checking.',
        notice: 'The team is checking.',
        noticeKind: 'approval_waiting',
      }),
      'The team is checking.' + FOOTER,
    ],
  ])('%s', (_name, input, text) => {
    expect(shapeOutbound(input, ctx)).toEqual({ send: true, text });
  });

  it.each(['staff_joined', 'staff_left', 'chat_ended', 'lead_captured'])(
    "doesn't send the widget notice %s",
    (kind) => {
      expect(
        shapeOutbound(msg({ author: 'system', noticeKind: kind, notice: 'x', body: 'x' }), ctx),
      ).toEqual({
        send: false,
        reason: 'widget_notice',
      });
    },
  );

  it("never sends a visitor's own message; a footer without a link; long text is capped", () => {
    expect(shapeOutbound(msg({ author: 'visitor' }), ctx)).toEqual({
      send: false,
      reason: 'visitor',
    });
    expect(shapeOutbound(msg({}), { ...ctx, privacyUrl: null })).toEqual({
      send: true,
      text: 'Yes, we deliver to Tampines.\n\n-- \nKaki Bakery',
    });
    const long = shapeOutbound(msg({ body: 'a'.repeat(30_000) }), ctx);
    expect(long.send && long.text.length).toBeLessThanOrEqual(EMAIL_CAPABILITIES.maxLength);
    expect(long.send && long.text).toContain('[…]');
  });

  it('backs off 2, 4, 8 … minutes up to an hour, and maps SMTP codes', () => {
    expect([1, 2, 3, 6, 7, 10].map((n) => backoffMs(n) / 60_000)).toEqual([2, 4, 8, 60, 60, 60]);
    expect(classifySmtp({ responseCode: 535 })).toMatchObject({ failed: 'auth' });
    expect(classifySmtp({ responseCode: 554 })).toMatchObject({ failed: 'permanent' });
    expect(classifySmtp({ responseCode: 421 })).toMatchObject({ failed: 'transient' });
    expect(classifySmtp(new Error('ECONNRESET'))).toMatchObject({ failed: 'transient' });
  });
});
