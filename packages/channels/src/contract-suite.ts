import { describe, expect, it } from 'vitest';
import {
  isRejection,
  type ChannelAdapter,
  type CredentialRef,
  type IgnoreReason,
  type InboundEvent,
  type OutboundMessage,
  type RawInbound,
  type SendContext,
} from './adapter.js';

/**
 * The contract-test suite every adapter passes (ADR-011, CHN-01). Test-only: it imports
 * Vitest, so it is a separate `@kaki/channels/contract-suite` export, never re-exported
 * from the package index.
 */
export interface AdapterFixtures {
  credential: CredentialRef;
  revokedCredential: CredentialRef;
  /** Recorded webhooks and the canonical events each must give. */
  inbound: { name: string; raw: RawInbound; events: Omit<InboundEvent, 'timestamp'>[] }[];
  /** Webhooks that `verifyInbound` must reject (bad signature, …). */
  rejected: { name: string; raw: RawInbound }[];
  ignored: { name: string; raw: RawInbound; reason: IgnoreReason }[];
  outbound: { msg: OutboundMessage; ctx: SendContext };
  /** How many deliveries the fake transport behind the adapter has made. */
  deliveries(): number;
}

export function adapterContractSuite(
  name: string,
  makeAdapter: () => ChannelAdapter,
  fixtures: () => AdapterFixtures,
): void {
  describe(`${name} adapter contract (ADR-011)`, () => {
    async function eventsOf(adapter: ChannelAdapter, raw: RawInbound, creds: CredentialRef) {
      const verified = await adapter.verifyInbound(raw, creds);
      if (isRejection(verified)) throw new Error(`rejected: ${verified.rejected}`);
      return adapter.normalise(verified, creds);
    }

    it('declares its kind and capabilities', () => {
      const a = makeAdapter();
      expect(a.kind).toMatch(/^[a-z]+$/);
      expect(a.capabilities.maxLength).toBeGreaterThan(0);
      expect(typeof a.stream === 'function').toBe(a.capabilities.streaming);
    });

    it('normalises each recorded webhook to the expected canonical events', async () => {
      const f = fixtures();
      for (const fx of f.inbound) {
        const a = makeAdapter();
        const events = await eventsOf(a, fx.raw, f.credential);
        expect(
          events.map(({ timestamp: _t, ...rest }) => rest),
          fx.name,
        ).toEqual(fx.events);
        for (const e of events) {
          expect(e.timestamp, fx.name).toBeInstanceOf(Date);
          expect(a.shouldIgnore(e), fx.name).toBeNull();
          expect(a.threadKey(e), fx.name).toBeTruthy();
        }
      }
    });

    it('rejects webhooks that fail verification', async () => {
      const f = fixtures();
      for (const fx of f.rejected) {
        const v = await makeAdapter().verifyInbound(fx.raw, f.credential);
        expect(isRejection(v), fx.name).toBe(true);
      }
    });

    it('applies its ignore rules', async () => {
      const f = fixtures();
      for (const fx of f.ignored) {
        const a = makeAdapter();
        const events = await eventsOf(a, fx.raw, f.credential);
        expect(events.length, fx.name).toBeGreaterThan(0);
        for (const e of events) expect(a.shouldIgnore(e), fx.name).toBe(fx.reason);
      }
    });

    it('sends once for two sends with one message ID', async () => {
      const f = fixtures();
      const a = makeAdapter();
      const before = f.deliveries();
      const first = await a.send(f.outbound.msg, f.outbound.ctx);
      const second = await a.send(f.outbound.msg, f.outbound.ctx);
      expect(first.ok).toBe(true);
      expect(second).toEqual(first);
      expect(f.deliveries() - before).toBe(1);
    });

    it('reports a healthy credential ok and a revoked one as credential_revoked', async () => {
      const f = fixtures();
      const a = makeAdapter();
      expect(await a.checkHealth(f.credential)).toEqual({ ok: true });
      expect(await a.checkHealth(f.revokedCredential)).toEqual({
        ok: false,
        reason: 'credential_revoked',
      });
    });
  });
}
