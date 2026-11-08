/**
 * The email channel's settings in the dashboard zone (CHN-04, CHN-10; FEAT-036 §3): setup,
 * reply cap, the domain's two-phase writes, a delivery retry and attachment lookup. The
 * routes over these are in `apps/api/test/email-channel.int.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanAttachment,
  clearDomain,
  domainToAdd,
  domainToCheck,
  domainToRemove,
  EmailChannelError,
  emailChannelView,
  retryDelivery,
  saveReplyCap,
  setupEmail,
  storeDomain,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let userId: string;
const cfg = { inboundDomain: 'in.kaki.test', region: 'ap-southeast-1' };
const dash = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), tenantId, fn);
const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof EmailChannelError ? e.code : String(e)),
  );

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  userId = (
    await owner.query<{ user_id: string }>(
      `select user_id from memberships where tenant_id = $1 limit 1`,
      [TENANT_A],
    )
  ).rows[0]!.user_id;
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('email settings (FEAT-036 §3)', () => {
  it('sets up once, offline and hidden, with the slug as the forwarding address', async () => {
    expect(await dash(TENANT_A, (tx) => emailChannelView(tx, TENANT_A, cfg))).toMatchObject({
      connected: false,
      settingsVersion: 0,
    });
    await dash(TENANT_A, (tx) => setupEmail(tx, { tenantId: TENANT_A, userId }));
    const v = await dash(TENANT_A, (tx) => emailChannelView(tx, TENANT_A, cfg));
    expect(v).toMatchObject({
      connected: true,
      connection: { state: 'offline' },
      forwardingAddress: 'kaki-bakery@in.kaki.test',
      replyFrom: 'kaki-bakery@in.kaki.test',
      replyCap: 10,
      settingsVersion: 1,
    });
    expect(await code(dash(TENANT_A, (tx) => setupEmail(tx, { tenantId: TENANT_A, userId })))).toBe(
      'already_connected',
    );
    expect(await dash(TENANT_B, (tx) => emailChannelView(tx, TENANT_B, cfg))).toMatchObject({
      connected: false,
    });
  });

  it('saves the reply cap with the version; a stale one and no setup are refused', async () => {
    await dash(TENANT_A, (tx) =>
      saveReplyCap(tx, { tenantId: TENANT_A, userId, replyCap: 4, settingsVersion: 1 }),
    );
    expect(await dash(TENANT_A, (tx) => emailChannelView(tx, TENANT_A, cfg))).toMatchObject({
      replyCap: 4,
      settingsVersion: 2,
    });
    expect(
      await code(
        dash(TENANT_A, (tx) =>
          saveReplyCap(tx, { tenantId: TENANT_A, userId, replyCap: 5, settingsVersion: 1 }),
        ),
      ),
    ).toBe('stale');
    expect(
      await code(
        dash(TENANT_B, (tx) =>
          saveReplyCap(tx, { tenantId: TENANT_B, userId, replyCap: 5, settingsVersion: 1 }),
        ),
      ),
    ).toBe('not_connected');
  });

  it('adds, checks and removes a domain', async () => {
    expect(
      await code(
        dash(TENANT_A, (tx) =>
          domainToAdd(tx, { tenantId: TENANT_A, address: 'me@gmail.com', settingsVersion: 2 }, cfg),
        ),
      ),
    ).toBe('platform_domain');
    expect(await code(dash(TENANT_A, (tx) => domainToCheck(tx, TENANT_A)))).toBe('not_found');
    const domain = await dash(TENANT_A, (tx) =>
      domainToAdd(tx, { tenantId: TENANT_A, address: 'Hi@KakiBakery.sg', settingsVersion: 2 }, cfg),
    );
    expect(domain).toBe('kakibakery.sg');
    await dash(TENANT_A, (tx) =>
      storeDomain(tx, {
        tenantId: TENANT_A,
        userId,
        address: 'Hi@KakiBakery.sg',
        domain,
        dkimTokens: ['a', 'b', 'c'],
        mailFrom: 'mail.kakibakery.sg',
        settingsVersion: 2,
      }),
    );
    const v = await dash(TENANT_A, (tx) => emailChannelView(tx, TENANT_A, cfg));
    expect(v.domain).toMatchObject({ address: 'hi@kakibakery.sg', state: 'pending' });
    expect(v.domain?.records).toHaveLength(6);
    expect(v.replyFrom).toBe('kaki-bakery@in.kaki.test');
    expect(await dash(TENANT_A, (tx) => domainToCheck(tx, TENANT_A))).toBe('kakibakery.sg');
    await owner.query(`update email_settings set domain_checked_at = now() where tenant_id = $1`, [
      TENANT_A,
    ]);
    expect(await code(dash(TENANT_A, (tx) => domainToCheck(tx, TENANT_A)))).toBe('too_soon');
    await owner.query(`update email_settings set domain_state = 'verified' where tenant_id = $1`, [
      TENANT_A,
    ]);
    expect((await dash(TENANT_A, (tx) => emailChannelView(tx, TENANT_A, cfg))).replyFrom).toBe(
      'hi@kakibakery.sg',
    );
    expect(
      await dash(TENANT_A, (tx) => domainToRemove(tx, { tenantId: TENANT_A, settingsVersion: 3 })),
    ).toBe('kakibakery.sg');
    await dash(TENANT_A, (tx) =>
      clearDomain(tx, { tenantId: TENANT_A, userId, settingsVersion: 3 }),
    );
    expect(await dash(TENANT_A, (tx) => emailChannelView(tx, TENANT_A, cfg))).toMatchObject({
      domain: null,
      replyFrom: 'kaki-bakery@in.kaki.test',
      settingsVersion: 4,
    });
  });

  it('retries only a failed delivery and finds only a clean attachment', async () => {
    const conv = randomUUID();
    await owner.query(
      `insert into conversations (tenant_id, id, visitor_id, channel) values ($1, $2, $3, 'email')`,
      [TENANT_A, conv, randomUUID()],
    );
    const msg = (
      await owner.query<{ id: string }>(
        `insert into messages (tenant_id, conversation_id, author, body) values ($1, $2, 'agent', 'Hi') returning id`,
        [TENANT_A, conv],
      )
    ).rows[0]!.id;
    expect(
      await code(
        dash(TENANT_A, (tx) => retryDelivery(tx, { tenantId: TENANT_A, userId, messageId: msg })),
      ),
    ).toBe('not_failed');
    await owner.query(
      `update message_deliveries set status = 'failed', failed_reason = 'bounced' where message_id = $1`,
      [msg],
    );
    expect(
      await dash(TENANT_A, (tx) =>
        retryDelivery(tx, { tenantId: TENANT_A, userId, messageId: msg }),
      ),
    ).toEqual({ conversationId: conv });
    expect(
      (await owner.query(`select status from message_deliveries where message_id = $1`, [msg]))
        .rows[0],
    ).toEqual({ status: 'pending' });
    expect(
      await code(
        dash(TENANT_B, (tx) => retryDelivery(tx, { tenantId: TENANT_B, userId, messageId: msg })),
      ),
    ).toBe('not_found');

    const att = (
      await owner.query<{ id: string }>(
        `insert into email_attachments (tenant_id, conversation_id, message_id, name, content_type, size, status, object_key)
         values ($1, $2, $3, 'menu.pdf', 'application/pdf', 10, 'clean', 'k/menu.pdf') returning id`,
        [TENANT_A, conv, msg],
      )
    ).rows[0]!.id;
    expect(await dash(TENANT_A, (tx) => cleanAttachment(tx, TENANT_A, att))).toEqual({
      key: 'k/menu.pdf',
      name: 'menu.pdf',
      contentType: 'application/pdf',
    });
    expect(await dash(TENANT_B, (tx) => cleanAttachment(tx, TENANT_B, att))).toBeNull();
    await owner.query(
      `update email_attachments set status = 'rejected', reject_reason = 'malware', object_key = null where id = $1`,
      [att],
    );
    expect(await dash(TENANT_A, (tx) => cleanAttachment(tx, TENANT_A, att))).toBeNull();
  });
});
