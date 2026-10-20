import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runChecks } from './health.js';
import { envSchemas, loadConfig } from './config.js';
import { channels } from './pubsub.js';
import { signToken, TokenError, verifyToken } from './tokens.js';

const SECRET = 's'.repeat(32);

describe('tokens', () => {
  it('signs and verifies', () => {
    const t = signToken({ t: 'a', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    expect(verifyToken<{ t: string; exp: number }>(t, SECRET).t).toBe('a');
  });
  it('rejects tampering, a wrong secret, expiry and garbage', () => {
    const t = signToken({ t: 'a', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ t: 'b', exp: 9e9 })).toString('base64url');
    expect(() => verifyToken(`${forged}.${sig}`, SECRET)).toThrow(TokenError);
    expect(() => verifyToken(`${body}.${sig}`, 'x'.repeat(32))).toThrow(TokenError);
    expect(() => verifyToken(signToken({ exp: 1 }, SECRET), SECRET)).toThrow('expired');
    expect(() => verifyToken('nope', SECRET)).toThrow(TokenError);
  });
});

describe('config', () => {
  it('validates and treats empty optional URLs as unset', () => {
    const schema = envSchemas.base.extend({ PORT: envSchemas.port });
    const cfg = loadConfig(schema, { PORT: '3000', OTEL_EXPORTER_OTLP_ENDPOINT: '' });
    expect(cfg).toMatchObject({ PORT: 3000, NODE_ENV: 'development' });
    expect(cfg.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });
  it('names every invalid variable', () => {
    expect(() =>
      loadConfig(z.object({ A: envSchemas.url, B: envSchemas.secret }), { A: 'x', B: 'short' }),
    ).toThrow(/A: .*B: /);
  });
});

describe('channels and health', () => {
  it('prefixes every pub/sub channel with the tenant', () => {
    expect(channels.conversation('t1', 'c1')).toBe('t:t1:conv:c1');
    expect(channels.inbox('t1')).toBe('t:t1:inbox');
  });
  it('reports readiness from all checks', async () => {
    expect(await runChecks({ a: async () => true, b: async () => false })).toEqual({
      ok: false,
      checks: { a: true, b: false },
    });
    expect(
      await runChecks({
        a: async () => {
          throw new Error('x');
        },
      }),
    ).toEqual({ ok: false, checks: { a: false } });
  });
});
