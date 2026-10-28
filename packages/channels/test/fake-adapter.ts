import { createHmac } from 'node:crypto';
import type { AdapterFixtures } from '../src/contract-suite.js';
import type {
  ChannelAdapter,
  CredentialRef,
  HealthStatus,
  InboundEvent,
  RawInbound,
  SendResult,
} from '../src/adapter.js';

/**
 * A fake channel that implements the full ADR-011 contract (FEAT-034 AC-1): an HMAC-signed
 * JSON webhook, an in-memory transport, and a health check that tests can steer. It
 * registers as `telegram` in a test registry; core code never learns it exists.
 */
export const FAKE_SECRET = 'fake-signing-secret';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '99999999-9999-4999-8999-999999999999';

export interface FakeTransport {
  delivered: Map<string, string>;
  /** Overrides `checkHealth`; may throw or never settle. */
  health?: ((creds: CredentialRef) => Promise<HealthStatus>) | undefined;
  healthCalls: string[];
}

export function fakeTransport(): FakeTransport {
  return { delivered: new Map(), healthCalls: [] };
}

function sign(body: string) {
  return createHmac('sha256', FAKE_SECRET).update(body).digest('hex');
}

export function fakeWebhook(payload: Record<string, unknown>, signature?: string): RawInbound {
  const body = JSON.stringify(payload);
  return {
    headers: { 'x-fake-signature': signature ?? sign(body) },
    body,
    receivedAt: new Date('2026-10-27T02:00:00Z'),
  };
}

export function fakeAdapter(transport: FakeTransport): ChannelAdapter {
  return {
    kind: 'telegram',
    capabilities: {
      streaming: false,
      maxLength: 4096,
      richContent: false,
      attachments: false,
      typing: true,
    },
    async verifyInbound(req) {
      if (req.headers['x-fake-signature'] !== sign(req.body)) return { rejected: 'bad_signature' };
      let payload: { id?: unknown };
      try {
        payload = JSON.parse(req.body) as { id?: unknown };
      } catch {
        return { rejected: 'malformed' };
      }
      if (typeof payload.id !== 'string') return { rejected: 'malformed' };
      return { providerEventId: payload.id, payload, receivedAt: req.receivedAt };
    },
    async normalise(v, creds) {
      const p = v.payload as { from: string; text: string; bot?: boolean; lang?: string };
      const event: InboundEvent = {
        kind: 'message',
        tenantId: creds.tenantId,
        connectionId: creds.connectionId,
        externalUserId: p.from,
        text: p.text,
        attachments: [],
        localeHint: p.lang ?? null,
        timestamp: v.receivedAt,
        extensions: p.bot ? { telegram: { bot: true } } : {},
      };
      return [event];
    },
    shouldIgnore(e) {
      return (e.extensions.telegram as { bot?: boolean } | undefined)?.bot ? 'echo' : null;
    },
    threadKey(e) {
      return `chat:${e.externalUserId}`;
    },
    async send(msg): Promise<SendResult> {
      const seen = transport.delivered.get(msg.id);
      if (seen) return { ok: true, externalId: seen };
      const externalId = `ext-${transport.delivered.size + 1}`;
      transport.delivered.set(msg.id, externalId);
      return { ok: true, externalId };
    },
    async checkHealth(creds) {
      transport.healthCalls.push(creds.connectionId);
      if (transport.health) return transport.health(creds);
      return creds.keyRef === 'revoked'
        ? { ok: false, reason: 'credential_revoked' }
        : { ok: true };
    },
  };
}

export function fakeFixtures(transport: FakeTransport): AdapterFixtures {
  const credential: CredentialRef = {
    connectionId: CONNECTION,
    tenantId: TENANT,
    ciphertext: new Uint8Array([1]),
    keyRef: 'local:v1',
  };
  const base = {
    kind: 'message' as const,
    tenantId: TENANT,
    connectionId: CONNECTION,
    attachments: [],
  };
  return {
    credential,
    revokedCredential: { ...credential, keyRef: 'revoked' },
    inbound: [
      {
        name: 'a text message',
        raw: fakeWebhook({ id: 'm1', from: 'u1', text: 'Do you open on Sunday?', lang: 'en' }),
        events: [
          {
            ...base,
            externalUserId: 'u1',
            text: 'Do you open on Sunday?',
            localeHint: 'en',
            extensions: {},
          },
        ],
      },
    ],
    rejected: [
      { name: 'a bad signature', raw: fakeWebhook({ id: 'm2', from: 'u1', text: 'hi' }, 'bad') },
    ],
    ignored: [
      {
        name: "the bot's own echo",
        raw: fakeWebhook({ id: 'm3', from: 'bot', text: 'hello', bot: true }),
        reason: 'echo',
      },
    ],
    outbound: {
      msg: { id: 'out-1', text: 'We open at 9am.' },
      ctx: { tenantId: TENANT, connectionId: CONNECTION, threadKey: 'chat:u1', credential },
    },
    deliveries: () => transport.delivered.size,
  };
}
