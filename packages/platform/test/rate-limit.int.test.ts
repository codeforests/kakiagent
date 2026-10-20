import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRateLimiter, type RateLimiter } from '../src/rate-limit.js';

/** The Valkey limiter against the same Valkey major version as compose (FEAT-005 T2). */
let container: StartedTestContainer;
let rl: RateLimiter;
beforeAll(async () => {
  container = await new GenericContainer('valkey/valkey:8').withExposedPorts(6379).start();
  rl = createRateLimiter(`redis://${container.getHost()}:${container.getMappedPort(6379)}`);
});
afterAll(async () => {
  await rl?.close();
  await container?.stop();
});

describe('Valkey rate limiter', () => {
  it('allows the limit, refuses the next hit, and resets after the window', async () => {
    for (let i = 1; i <= 5; i++)
      expect(await rl.hit('t:k', 5, 1000)).toEqual({ allowed: true, count: i });
    expect(await rl.hit('t:k', 5, 1000)).toEqual({ allowed: false, count: 6 });
    expect((await rl.hit('t:other', 5, 1000)).allowed).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await rl.hit('t:k', 5, 1000)).toEqual({ allowed: true, count: 1 });
  });

  it('later hits do not extend the window', async () => {
    await rl.hit('t:w', 5, 1000);
    await new Promise((r) => setTimeout(r, 600));
    await rl.hit('t:w', 5, 1000);
    await new Promise((r) => setTimeout(r, 500));
    expect((await rl.hit('t:w', 5, 1000)).count).toBe(1);
  });
});
