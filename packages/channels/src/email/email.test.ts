import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ignoreReason } from './ignore.js';
import { bodyText, BODY_MAX, forwardingConfirmation, parseEmail } from './parse.js';
import { lookupIds, replySubject, threadKey, threadSubject } from './thread.js';

const fixture = (name: string) =>
  parseEmail(readFileSync(new URL(`../../test/fixtures/email/${name}.eml`, import.meta.url)));
const OWN = ['kaki-bakery@in.kaki.test'];

describe('email ignore rules (CHN-10; FEAT-036 §5.1)', () => {
  it.each([
    ['first', null],
    ['gmail-reply', null],
    ['outlook-reply', null],
    ['attachments', null],
    ['same-subject', null],
    ['gmail-vacation', 'auto_reply'],
    ['outlook-oof', 'auto_reply'],
    ['dsn', 'bounce'],
    ['list-post', 'list'],
    ['newsletter', 'bulk'],
  ] as const)('%s → %s', async (name, reason) => {
    expect(ignoreReason(await fixture(name), { ownMessage: false, ownAddresses: OWN })).toBe(
      reason,
    );
  });

  it('an echo of our own reply, by Message-ID or From, and the SES verdicts', async () => {
    const p = await fixture('first');
    expect(ignoreReason(p, { ownMessage: true, ownAddresses: OWN })).toBe('echo');
    expect(
      ignoreReason(
        { ...p, from: { address: OWN[0]!, name: null } },
        { ownMessage: false, ownAddresses: OWN },
      ),
    ).toBe('echo');
    const ctx = (verdicts: Record<string, string>) => ({
      ownMessage: false,
      ownAddresses: OWN,
      verdicts,
    });
    expect(ignoreReason(p, ctx({ spam: 'FAIL' }))).toBe('spam');
    expect(ignoreReason(p, ctx({ dmarc: 'FAIL', spam: 'PASS' }))).toBe('spam');
    expect(ignoreReason(p, ctx({ virus: 'FAIL', spam: 'PASS' }))).toBe('unsafe');
    expect(ignoreReason(p, ctx({ virus: 'PASS', spam: 'PASS', dmarc: 'GRAY' }))).toBeNull();
    const zh = { ...p, subject: '自动回复: 生日蛋糕' };
    expect(ignoreReason(zh, { ownMessage: false, ownAddresses: OWN })).toBe('auto_reply');
  });
});

describe('email threading (CHN-04; FEAT-036 §5.1)', () => {
  it('keys a thread by its root and looks up References ∪ In-Reply-To', async () => {
    const first = await fixture('first');
    expect(threadKey(first)).toBe('<CAF1first@mail.gmail.com>');
    const gmail = await fixture('gmail-reply');
    expect(threadKey(gmail)).toBe('<CAF1first@mail.gmail.com>');
    expect(lookupIds(gmail)).toEqual(['<CAF1first@mail.gmail.com>', '<out-1@in.kaki.test>']);
    const outlook = await fixture('outlook-reply');
    expect(threadKey(outlook)).toBe('<out-2@in.kaki.test>');
    expect(lookupIds(outlook)).toEqual(['<out-2@in.kaki.test>']);
    expect(lookupIds(await fixture('same-subject'))).toEqual([]);
  });

  it('subjects: one Re:, prefixes stripped for the thread', () => {
    expect(replySubject('Birthday cake')).toBe('Re: Birthday cake');
    expect(replySubject('RE: Re: Order')).toBe('Re: Order');
    expect(replySubject('回复：生日蛋糕')).toBe('Re: 生日蛋糕');
    expect(replySubject('')).toBe('Re: (no subject)');
    expect(threadSubject('RE: Order for 20 tarts')).toBe('Order for 20 tarts');
    expect(threadSubject('x'.repeat(300))).toHaveLength(200);
  });
});

describe('email bodies (FEAT-036 §5.1)', () => {
  it('parses the headers, sender and attachments', async () => {
    const p = await fixture('attachments');
    expect(p.from).toEqual({ address: 'tan.mei@gmail.com', name: 'Tan Mei' });
    expect(p.messageId).toBe('<CAF5attach@mail.gmail.com>');
    expect(p.attachments.map((a) => [a.name, a.contentType])).toEqual([
      ['design.png', 'image/png'],
      ['order.pdf', 'application/pdf'],
      ['invoice.pdf', 'application/pdf'],
    ]);
    expect(p.attachments[1]!.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await fixture('dsn')).contentType).toBe('multipart/report');
  });

  it('strips Gmail and Outlook quotes and a -- signature', async () => {
    expect(bodyText(await fixture('gmail-reply'))).toBe('Great, 1kg please.');
    expect(bodyText(await fixture('outlook-reply'))).toBe('Can I collect at 3pm instead?');
    expect(bodyText(await fixture('first'))).toContain('do you deliver to Tampines?');
    expect(bodyText({ text: null, html: '<p>Big <b>sale</b> &amp; more</p>' })).toBe(
      'Big sale & more',
    );
    expect(
      bodyText({ text: 'Thanks!\n\n-----Original Message-----\nFrom: x\nold', html: null }),
    ).toBe('Thanks!');
    expect(
      bodyText({ text: '好的\n\n2026年11月3日 10:05，Kaki 于 写道：\n> 旧', html: null }),
    ).toBe('好的');
  });

  it('caps a long body at 4,000 characters with […]', () => {
    const out = bodyText({ text: 'a'.repeat(5000), html: null });
    expect(out).toHaveLength(BODY_MAX);
    expect(out.endsWith('[…]')).toBe(true);
  });

  it("extracts Gmail's forwarding confirmation code and link (D5)", async () => {
    expect(forwardingConfirmation(await fixture('gmail-confirmation'))).toEqual({
      code: '482915736',
      link: 'https://mail-settings.google.com/mail/vf-%5BANGjdJ8abc%5D-xyz',
    });
    expect(forwardingConfirmation(await fixture('first'))).toBeNull();
  });
});
