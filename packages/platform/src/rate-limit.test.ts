import { describe, expect, it } from 'vitest';
import { buildMessage } from './mailer.js';
import { memoryRateLimiter } from './rate-limit.js';

describe('memoryRateLimiter', () => {
  it('allows the limit, refuses the next hit, and resets after the window', async () => {
    let t = 1_000;
    const rl = memoryRateLimiter(() => t);
    for (let i = 1; i <= 5; i++)
      expect(await rl.hit('k', 5, 60_000)).toEqual({ allowed: true, count: i });
    expect(await rl.hit('k', 5, 60_000)).toEqual({ allowed: false, count: 6 });
    expect((await rl.hit('other', 5, 60_000)).allowed).toBe(true);
    t += 59_999;
    expect((await rl.hit('k', 5, 60_000)).allowed).toBe(false);
    t += 1;
    expect(await rl.hit('k', 5, 60_000)).toEqual({ allowed: true, count: 1 });
  });
});

describe('buildMessage', () => {
  it('addresses the message from the configured sender', () => {
    expect(
      buildMessage('KakiAgent <no-reply@kakiagent.test>', {
        to: 'a@b.sg',
        subject: 'S',
        text: 'T',
        html: '<p>T</p>',
      }),
    ).toEqual({
      from: 'KakiAgent <no-reply@kakiagent.test>',
      to: 'a@b.sg',
      subject: 'S',
      text: 'T',
      html: '<p>T</p>',
    });
  });
});
