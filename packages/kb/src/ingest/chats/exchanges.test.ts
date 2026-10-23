import { describe, expect, it } from 'vitest';
import { groupExchanges, isBusinessSender, keepLatest, normaliseName } from './exchanges.js';
import { sgTime, type ChatMessage } from './messages.js';
import { createRedactor, NO_REDACTIONS, REDACTED } from './redact.js';

const counts = () => ({ ...NO_REDACTIONS });

describe('createRedactor (FEAT-017 §5.3 step 5)', () => {
  const redact = createRedactor(
    ['Mdm Tan Mei Ling', 'Ah Kow', '陈太太', 'Kaki Lim'],
    ['Kaki Bakery'],
  );

  it('redacts e-mails, phones, NRIC and cards, addresses, names and usernames, counting each', () => {
    const c = counts();
    const out = redact(
      'Hi Mei Ling, mail tanml@example.com or call 9123 4567 / +65 6123-4567 / +44 20 7946 0958. ' +
        'NRIC S1234567D. Deliver to Blk 123 Ang Mo Kio Ave 3 #05-12 Singapore 560123. @ahkow_sg and 陈太太 say hi. ' +
        'Kaki Bakery thanks Ah Kow.',
      c,
    );
    expect(out).not.toMatch(
      /Mei|Ling|tanml|9123|6123|7946|S1234567D|560123|#05-12|ahkow|陈太太|Kow/,
    );
    expect(out).toContain('Kaki Bakery'); // the business's own word "Kaki" is kept
    expect(out).toContain('[email]');
    expect(out).toContain('[NRIC ');
    expect(c).toEqual({ names: 4, phones: 3, emails: 1, ids: 1, addresses: 3 });
    expect(REDACTED.test(out)).toBe(true);
  });

  it('leaves prices, times and ordinary words alone', () => {
    const c = counts();
    expect(redact('The cake is S$55.00, open 9am to 5pm, 12 slices. Tangy flavour.', c)).toBe(
      'The cake is S$55.00, open 9am to 5pm, 12 slices. Tangy flavour.',
    );
    expect(c).toEqual(NO_REDACTIONS);
  });
});

describe('business detection (FEAT-017 §5.3 step 4)', () => {
  it('matches normalised names, contained names and Telegram account ids', () => {
    expect(normaliseName('  KAKI  Bakery 🍰!! ')).toBe('kaki bakery');
    expect(isBusinessSender({ sender: 'Kaki Bakery 🍰' }, ['kaki bakery'], [])).toBe(true);
    expect(isBusinessSender({ sender: 'Kaki Bakery (Sales)' }, ['Kaki Bakery'], [])).toBe(true);
    expect(isBusinessSender({ sender: 'Mdm Tan' }, ['Kaki Bakery'], [])).toBe(false);
    expect(isBusinessSender({ sender: 'Ka' }, ['Ka'], [])).toBe(false);
    expect(isBusinessSender({ sender: 'X', senderId: 'user7' }, [], ['user7'])).toBe(true);
  });
});

const at = (d: number, h: number, m = 0) => sgTime(2026, 10, d, h, m);
const msg = (sender: string, text: string, when: Date, conversation = 0): ChatMessage => ({
  sender,
  text,
  at: when,
  conversation,
});

describe('groupExchanges (FEAT-017 §5.3 step 6)', () => {
  const opts = { businessNames: ['Kaki Bakery'], businessIds: [], partLimit: 200 };

  it('pairs customer turns with business replies within 48 hours, redacted, one line per message', () => {
    const g = groupExchanges(
      [
        msg('Kaki Bakery', 'Good morning! New flavours this week.', at(1, 8)),
        msg('Mdm Tan', 'Hi, do you deliver to Jurong?', at(1, 9)),
        msg('Mdm Tan', 'My number is 9123 4567', at(1, 9, 1)),
        msg('Kaki Bakery', 'Yes Mdm Tan, island-wide delivery\nfor S$8.', at(1, 9, 5)),
        msg('Mdm Tan', 'Open on Sunday?', at(2, 9)),
        msg('Kaki Bakery', 'Only Saturday.', at(5, 9)), // over 48 hours later
      ],
      opts,
    )!;
    expect(g.businessMessages).toBe(3);
    expect(g.exchanges).toBe(1);
    expect(g.parts).toHaveLength(1);
    expect(g.parts[0]!.content).toBe(
      [
        'Customer: Hi, do you deliver to Jurong?',
        'Customer: My number is [phone]',
        'Business: Yes [name], island-wide delivery for S$8.',
      ].join('\n'),
    );
    expect(g.redacted).toMatchObject({ phones: 1, names: 1 });
  });

  it('returns null when no message is the business', () => {
    expect(groupExchanges([msg('A', 'hi?', at(1, 9)), msg('B', 'yo', at(1, 10))], opts)).toBeNull();
  });

  it('packs exchanges into parts of up to 4,000 characters per conversation, up to the limit', () => {
    const list: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      list.push(msg('C', `Question ${i}? ${'x'.repeat(300)}`, at(1, 9, i * 2), i < 20 ? 0 : 1));
      list.push(
        msg('Kaki Bakery', `Answer ${i}. ${'y'.repeat(300)}`, at(1, 9, i * 2 + 1), i < 20 ? 0 : 1),
      );
    }
    const g = groupExchanges(list, { ...opts, partLimit: 3 })!;
    expect(g.exchanges).toBe(30);
    expect(g.parts.every((p) => p.content.length <= 4000)).toBe(true);
    // 20 exchanges of ~630 chars → 4 parts, then 10 → 2 parts; only 3 kept.
    expect(g.parts).toHaveLength(3);
    expect(g.partsSkipped).toBe(3);
    expect(g.parts.map((p) => p.number)).toEqual([1, 2, 3]);
  });
});

describe('keepLatest (D9)', () => {
  it('keeps the latest messages and counts the rest', () => {
    const list = [3, 1, 2].map((d) => msg('A', String(d), at(d, 9)));
    const r = keepLatest(list, 2);
    expect(r.messages.map((m) => m.text)).toEqual(['2', '3']);
    expect(r.skipped).toBe(1);
    expect(keepLatest(list, 5).skipped).toBe(0);
  });
});
