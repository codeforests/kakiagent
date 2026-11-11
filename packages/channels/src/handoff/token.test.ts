import { describe, expect, it } from 'vitest';
import { LINK_CODE } from '../telegram/receive.js';
import { HANDOFF_CODE, openHandoff, peekHandoff, signHandoff } from './token.js';

const SECRET = 's'.repeat(32);
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const LINK = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b';

describe('handoff codes (FEAT-038 §5.1, D4)', () => {
  it('round-trips for the tenant and channel it was signed for', () => {
    const t = signHandoff(SECRET, A, LINK, 'telegram');
    const e = signHandoff(SECRET, A, LINK, 'email');
    expect(openHandoff(SECRET, A, t)).toEqual({ linkId: LINK, channel: 'telegram' });
    expect(openHandoff(SECRET, A, e)).toEqual({ linkId: LINK, channel: 'email' });
    expect(peekHandoff(e)).toEqual({ linkId: LINK, channel: 'email' });
  });

  it('a Telegram code fits the start payload and never looks like an alert link', () => {
    const t = signHandoff(SECRET, A, LINK, 'telegram');
    expect(t.startsWith('c-')).toBe(true);
    expect(t.length).toBe(45);
    expect(t).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(t).toMatch(HANDOFF_CODE);
    expect(LINK_CODE.test(t)).toBe(false);
  });

  it('a wrong tenant, secret, prefix, length or MAC opens nothing', () => {
    const t = signHandoff(SECRET, A, LINK, 'telegram');
    expect(openHandoff(SECRET, B, t)).toBeNull();
    expect(openHandoff('x'.repeat(32), A, t)).toBeNull();
    expect(openHandoff(SECRET, A, `e-${t.slice(2)}`)).toBeNull();
    expect(openHandoff(SECRET, A, t.slice(0, -1))).toBeNull();
    expect(openHandoff(SECRET, A, `${t}A`)).toBeNull();
    const last = t.at(-2) === 'A' ? 'B' : 'A';
    expect(openHandoff(SECRET, A, `${t.slice(0, -2)}${last}${t.at(-1)}`)).toBeNull();
    expect(openHandoff(SECRET, A, 'link-abc')).toBeNull();
    expect(peekHandoff('c-short')).toBeNull();
  });
});
