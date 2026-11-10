import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { localSealer } from '@kaki/platform/secrets';
import { describe, expect, it } from 'vitest';
import type { CredentialRef, RawInbound } from '../adapter.js';
import { adapterContractSuite } from '../contract-suite.js';
import { fakeBotApi, fixtureToken } from './fake.js';
import { SECRET_HEADER, sealTelegram, telegramAdapter } from './index.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const CONN = '00000000-0000-4000-8000-00000000000c';
const sealer = localSealer(randomBytes(32));
const fake = fakeBotApi();
const hookUrl = (id: string) => `https://hooks.kaki.test/hooks/telegram/${id}`;
const SECRET = 'webhook-secret-of-the-fixture-bot';

async function credentialFor(token: string, connectionId = CONN): Promise<CredentialRef> {
  const s = await sealTelegram(sealer, connectionId, { token, webhookSecret: SECRET });
  return { connectionId, tenantId: TENANT, ciphertext: s.ciphertext, keyRef: s.keyRef };
}
const credential = await credentialFor(fixtureToken(700001));
const revokedCredential = await credentialFor('700001:revokedxxxxxxxxxxxxxxxxxxxxxxxxxx');
await fake.fetch(`${fake.base}/bot${fixtureToken(700001)}/setWebhook`, {
  method: 'POST',
  body: JSON.stringify({ url: hookUrl(CONN), secret_token: SECRET }),
});

const raw = (name: string, secret = SECRET): RawInbound => ({
  headers: { [SECRET_HEADER]: secret },
  body: readFileSync(new URL(`../../test/fixtures/telegram/${name}.json`, import.meta.url), 'utf8'),
  receivedAt: new Date(),
});
const adapter = () =>
  telegramAdapter({ sealer, hookUrl, api: { base: fake.base, fetch: fake.fetch } });
const sends = () => fake.sent.filter((s) => s.method === 'sendMessage').length;

adapterContractSuite('telegram', adapter, () => ({
  credential,
  revokedCredential,
  inbound: [
    {
      name: 'private text',
      raw: raw('private-text'),
      events: [
        {
          kind: 'message',
          tenantId: TENANT,
          connectionId: CONN,
          externalUserId: '5550001',
          text: 'Do you deliver to Tampines?',
          attachments: [],
          localeHint: 'en',
          extensions: {
            telegram: {
              chatId: 5550001,
              chatType: 'private',
              updateId: 1001,
              messageId: 1001,
              username: 'meitan',
              firstName: 'Mei',
              lastName: 'Tan',
              command: null,
              startPayload: null,
              memberStatus: null,
              contentLabel: null,
            },
          },
        },
      ],
    },
  ],
  rejected: [
    { name: 'wrong secret', raw: raw('private-text', 'guess') },
    { name: 'no secret', raw: { ...raw('private-text'), headers: {} } },
    { name: 'not JSON', raw: { ...raw('private-text'), body: '<html>' } },
  ],
  ignored: [
    { name: 'group', raw: raw('group'), reason: 'group' },
    { name: 'supergroup', raw: raw('supergroup'), reason: 'group' },
    { name: 'added to a group', raw: raw('added-to-group'), reason: 'group' },
    { name: 'sticker', raw: raw('sticker'), reason: 'unsupported' },
    { name: 'voice', raw: raw('voice'), reason: 'unsupported' },
  ],
  outbound: {
    msg: { id: '33333333-3333-4333-8333-333333333333', text: 'Yes, we deliver to Tampines.' },
    ctx: { tenantId: TENANT, connectionId: CONN, threadKey: '5550001', credential },
  },
  deliveries: sends,
}));

describe('Telegram adapter send and health (FEAT-037 §5.1)', () => {
  it('maps a blocked chat to permanent/blocked and a revoked token to auth', async () => {
    const a = adapter();
    fake.blocked.add(42);
    const ctx = { tenantId: TENANT, connectionId: CONN, threadKey: '42', credential };
    expect(await a.send({ id: 'm1', text: 'hi' }, ctx)).toEqual({
      ok: false,
      failed: 'permanent',
      status: 403,
      reason: 'blocked',
    });
    expect(
      await a.send({ id: 'm2', text: 'hi' }, { ...ctx, credential: revokedCredential }),
    ).toEqual({ ok: false, failed: 'auth', status: 401 });
    fake.failNext('sendMessage', 429, 'Too Many Requests', 5);
    expect(await a.send({ id: 'm3', text: 'hi' }, { ...ctx, threadKey: '43' })).toEqual({
      ok: false,
      failed: 'transient',
      status: 429,
      retryAfterSeconds: 5,
    });
  });

  it("re-registers an empty webhook, reports someone else's as credential_invalid", async () => {
    const token = fixtureToken(700002);
    const cred = await credentialFor(token, '00000000-0000-4000-8000-00000000000d');
    const a = adapter();
    expect(await a.checkHealth(cred)).toEqual({ ok: true });
    expect(fake.webhooks.get(700002)).toEqual({
      url: hookUrl('00000000-0000-4000-8000-00000000000d'),
      secret: SECRET,
    });
    fake.setForeignWebhook(700002, 'https://elsewhere.test/hook');
    expect(await a.checkHealth(cred)).toEqual({ ok: false, reason: 'credential_invalid' });
    expect(fake.webhooks.get(700002)?.url).toBe('https://elsewhere.test/hook');
    fake.failNext('getMe', 502);
    expect(await a.checkHealth(cred)).toEqual({ ok: false, reason: 'unreachable' });
  });
});
