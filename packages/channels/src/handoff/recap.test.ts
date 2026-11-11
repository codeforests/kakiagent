import { describe, expect, it } from 'vitest';
import { buildRecap, maskEmail, type RecapMessage } from './recap.js';

const at = (min: number) => new Date(Date.UTC(2026, 10, 18, 6, min));
const msg = (
  author: RecapMessage['author'],
  body: string,
  min: number,
  extra: Partial<RecapMessage> = {},
) => ({ author, body, authorName: null, createdAt: at(min), ...extra }) as RecapMessage;
const base = { businessName: 'Kaki Bakery', assistantName: 'Kaki', language: 'en' } as const;

describe('handoff recap (FEAT-038 §5.6, D8)', () => {
  it('Telegram: the last 6 sent messages, 300 characters each, notices left out', () => {
    const messages = [
      ...Array.from({ length: 8 }, (_, i) => msg(i % 2 ? 'agent' : 'visitor', `m${i}`, i)),
      msg('system', '', 9, { noticeKind: 'staff_joined' }),
      msg('staff', 'x'.repeat(400), 10, { authorName: 'Rachel Tan' }),
    ];
    const text = buildRecap({ ...base, channel: 'telegram', messages });
    const lines = text.split('\n\n')[1]!.split('\n');
    expect(text.startsWith("Hi, this is Kaki Bakery. Here's where we left off:")).toBe(true);
    expect(text.endsWith("Carry on here whenever you're ready.")).toBe(true);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('Kaki: m3');
    expect(lines[1]).toBe('You: m4');
    expect(lines[5]!.startsWith('Rachel: ')).toBe(true);
    expect(lines[5]!.length).toBe('Rachel: '.length + 300);
    expect(text).not.toContain('staff_joined');
  });

  it('email: the whole transcript with SGT times, capped at 50 messages', () => {
    const messages = Array.from({ length: 55 }, (_, i) => msg('visitor', `q${i}`, i));
    const text = buildRecap({ ...base, channel: 'email', messages });
    expect(text).toContain('… earlier messages not shown');
    expect(text).not.toContain('q4\n');
    expect(text).toContain('] You: q5');
    expect(text).toContain('] You: q54');
    expect(text).toContain('18 Nov, 2:05');
    const short = buildRecap({ ...base, channel: 'email', messages: messages.slice(0, 2) });
    expect(short).not.toContain('earlier messages');
  });

  it('email: capped at 20 000 characters', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg('agent', 'y'.repeat(1000), i));
    const text = buildRecap({ ...base, channel: 'email', messages });
    expect(text.length).toBeLessThan(21_000);
    expect(text).toContain('… earlier messages not shown');
  });

  it('Chinese labels', () => {
    const text = buildRecap({
      ...base,
      language: 'zh',
      channel: 'telegram',
      messages: [msg('visitor', '有蛋糕吗', 1)],
    });
    expect(text).toContain('你: 有蛋糕吗');
    expect(text).toContain('这里是Kaki Bakery');
  });

  it('masks an address', () => {
    expect(maskEmail('siti@gmail.com')).toBe('s***@gmail.com');
    expect(maskEmail('x')).toBe('***');
  });
});
