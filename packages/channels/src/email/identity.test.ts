import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CredentialRef, OutboundMessage, RawInbound, SendResult } from '../adapter.js';
import { adapterContractSuite } from '../contract-suite.js';
import { CHANNEL_REGISTRY, connectable, registryEntry, withAdapter } from '../registry.js';
import { emailAdapter } from './adapter.js';
import {
  domainHealth,
  fixtureIdentities,
  fixtureTxtResolver,
  hasDmarc,
  identityProvider,
  nextDomainState,
  records,
  refusedDomain,
  sesIdentities,
  type DomainChecks,
} from './identity.js';

const pass: DomainChecks = { exists: true, dkim: true, mailFrom: true, dmarc: true };
const TOKENS = ['tok1', 'tok2', 'tok3'];

describe('sending identity records (NFR-18; FEAT-036 §5.1)', () => {
  it('renders three DKIM CNAMEs, the MAIL FROM MX and SPF, and DMARC while it is missing', () => {
    const rows = records({
      domain: 'kakibakery.sg',
      dkimTokens: TOKENS,
      region: 'ap-southeast-1',
      state: 'pending',
    });
    expect(rows.map((r) => [r.purpose, r.type, r.host, r.value, r.status])).toEqual([
      ['dkim', 'CNAME', 'tok1._domainkey.kakibakery.sg', 'tok1.dkim.amazonses.com', 'pending'],
      ['dkim', 'CNAME', 'tok2._domainkey.kakibakery.sg', 'tok2.dkim.amazonses.com', 'pending'],
      ['dkim', 'CNAME', 'tok3._domainkey.kakibakery.sg', 'tok3.dkim.amazonses.com', 'pending'],
      [
        'mail_from_mx',
        'MX',
        'mail.kakibakery.sg',
        '10 feedback-smtp.ap-southeast-1.amazonses.com',
        'pending',
      ],
      [
        'mail_from_spf',
        'TXT',
        'mail.kakibakery.sg',
        'v=spf1 include:amazonses.com ~all',
        'pending',
      ],
      ['dmarc', 'TXT', '_dmarc.kakibakery.sg', 'v=DMARC1; p=none;', 'pending'],
    ]);
  });

  it('a verified domain shows every row ok and no DMARC row', () => {
    const rows = records({ domain: 'a.sg', dkimTokens: TOKENS, region: 'r', state: 'verified' });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === 'ok')).toBe(true);
  });

  it('after a check each row has its own result', () => {
    const rows = records({
      domain: 'a.sg',
      dkimTokens: TOKENS,
      region: 'r',
      state: 'failing',
      checks: { ...pass, mailFrom: false, dmarc: true },
    });
    expect(rows.map((r) => [r.purpose, r.status])).toEqual([
      ['dkim', 'ok'],
      ['dkim', 'ok'],
      ['dkim', 'ok'],
      ['mail_from_mx', 'failing'],
      ['mail_from_spf', 'failing'],
    ]);
  });
});

describe('domain state machine (FEAT-036 §5.1, D4; AC-6)', () => {
  it('verifies only when DKIM, MAIL FROM and DMARC all pass', () => {
    expect(nextDomainState('pending', pass)).toBe('verified');
    for (const miss of ['dkim', 'mailFrom', 'dmarc', 'exists'] as const)
      expect(nextDomainState('pending', { ...pass, [miss]: false }), miss).toBe('pending');
  });

  it('a verified domain that loses a record is failing, and recovers when it is back', () => {
    expect(nextDomainState('verified', { ...pass, dmarc: false })).toBe('failing');
    expect(nextDomainState('failing', { ...pass, dkim: false })).toBe('failing');
    expect(nextDomainState('failing', pass)).toBe('verified');
  });

  it('only failing degrades: a lost record is credential_invalid, a deleted identity revoked', () => {
    expect(domainHealth(null, pass)).toEqual({ ok: true });
    expect(domainHealth('pending', { ...pass, dkim: false })).toEqual({ ok: true });
    expect(domainHealth('failing', { ...pass, dkim: false })).toEqual({
      ok: false,
      reason: 'credential_invalid',
    });
    expect(domainHealth('failing', { ...pass, exists: false })).toEqual({
      ok: false,
      reason: 'credential_revoked',
    });
  });

  it('refuses free-mail and platform domains', () => {
    for (const a of [
      'me@gmail.com',
      'x@Outlook.com',
      'y@hotmail.com',
      'z@yahoo.com',
      'w@icloud.com',
    ])
      expect(refusedDomain(a, 'in.kaki.test'), a).toBe(true);
    expect(refusedDomain('hello@kaki.test', 'in.kaki.test')).toBe(true);
    expect(refusedDomain('hello@in.kaki.test', 'in.kaki.test')).toBe(true);
    expect(refusedDomain('hello@kakibakery.sg', 'in.kaki.test')).toBe(false);
  });

  it('DMARC passes on any v=DMARC1 record; a lookup error is missing', async () => {
    const r = (rows: string[][] | Error) => ({
      resolveTxt: async () => {
        if (rows instanceof Error) throw rows;
        return rows;
      },
    });
    expect(await hasDmarc(r([['v=DMARC1; p=reject;']]), 'a.sg')).toBe(true);
    expect(await hasDmarc(r([['v=DMA', 'RC1; p=none']]), 'a.sg')).toBe(true);
    expect(await hasDmarc(r([['v=spf1 -all']]), 'a.sg')).toBe(false);
    expect(await hasDmarc(r(new Error('ENOTFOUND')), 'a.sg')).toBe(false);
  });
});

describe('identity providers', () => {
  it('fixture: a .test domain verifies on its first check, others stay pending', async () => {
    expect(await fixtureIdentities.status('kakibakery.test')).toEqual({
      exists: true,
      dkim: true,
      mailFrom: true,
    });
    expect(await hasDmarc(fixtureTxtResolver, 'kakibakery.test')).toBe(true);
    expect((await fixtureIdentities.status('kakibakery.sg')).dkim).toBe(false);
    expect((await fixtureIdentities.create('a.test')).dkimTokens).toHaveLength(3);
  });

  it('a production build refuses the fixture provider', () => {
    const prev = process.env.KAKI_BUILD;
    process.env.KAKI_BUILD = 'production';
    try {
      expect(() => identityProvider('fixture', { region: 'r' })).toThrow(/not allowed/);
      expect(identityProvider('ses', { region: 'ap-southeast-1' }).identities).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.KAKI_BUILD;
      else process.env.KAKI_BUILD = prev;
    }
  });

  it('SES: creates with Easy DKIM and MAIL FROM, reads status, maps NotFound', async () => {
    const sent: { name: string; input: unknown }[] = [];
    const notFound = Object.assign(new Error('nf'), { name: 'NotFoundException' });
    let gone = false;
    const client = {
      send: async (cmd: { constructor: { name: string }; input: unknown }) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'CreateEmailIdentityCommand')
          return { DkimAttributes: { Tokens: TOKENS } };
        if (cmd.constructor.name === 'GetEmailIdentityCommand') {
          if (gone) throw notFound;
          return {
            DkimAttributes: { Status: 'SUCCESS', Tokens: TOKENS },
            MailFromAttributes: { MailFromDomainStatus: 'PENDING' },
          };
        }
        if (cmd.constructor.name === 'DeleteEmailIdentityCommand' && gone) throw notFound;
        return {};
      },
    };
    const ses = sesIdentities({ region: 'r', configurationSet: 'kaki', client: client as never });
    expect(await ses.create('a.sg')).toEqual({ dkimTokens: TOKENS, mailFrom: 'mail.a.sg' });
    expect(sent.map((s) => s.name)).toEqual([
      'CreateEmailIdentityCommand',
      'PutEmailIdentityMailFromAttributesCommand',
    ]);
    expect(sent[0]!.input).toEqual({ EmailIdentity: 'a.sg', ConfigurationSetName: 'kaki' });
    expect(sent[1]!.input).toMatchObject({ MailFromDomain: 'mail.a.sg' });
    expect(await ses.status('a.sg')).toEqual({ exists: true, dkim: true, mailFrom: false });
    gone = true;
    expect(await ses.status('a.sg')).toEqual({ exists: false, dkim: false, mailFrom: false });
    await expect(ses.remove('a.sg')).resolves.toBeUndefined();
  });
});

describe('email registry entry (FEAT-036 §5.1)', () => {
  it('is health-checked, offers hidden and message, and connects at /settings/channels/email', () => {
    expect(registryEntry('email')).toMatchObject({
      name: 'Email',
      checksHealth: true,
      offlineModes: ['hidden', 'message'],
      connectPath: '/settings/channels/email',
    });
    expect(connectable(CHANNEL_REGISTRY, ['widget'])).toEqual([
      { kind: 'email', name: 'Email', connectPath: '/settings/channels/email' },
    ]);
    expect(registryEntry('email')?.adapter).toBeUndefined();
    const bound = withAdapter(CHANNEL_REGISTRY, 'email', () => adapter());
    expect(registryEntry('email', bound)?.adapter).toBeTypeOf('function');
  });
});

// ---- The ADR-011 contract suite for the email adapter --------------------------------------

const TOPIC = 'arn:aws:sns:ap-southeast-1:000000000000:email-inbound';
const BUCKET = 'kaki-email-inbound';
const raw = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/email/${name}.eml`, import.meta.url));
const TENANT = '11111111-1111-4111-8111-111111111111';
const credential: CredentialRef = {
  connectionId: '22222222-2222-4222-8222-222222222222',
  tenantId: TENANT,
  ciphertext: null,
  keyRef: null,
};
const revokedCredential: CredentialRef = { ...credential, tenantId: 'revoked-tenant' };

function sns(key: string, opts: { topic?: string; bucket?: string } = {}): RawInbound {
  return {
    headers: {},
    receivedAt: new Date('2026-11-03T02:00:00Z'),
    body: JSON.stringify({
      Type: 'Notification',
      TopicArn: opts.topic ?? TOPIC,
      Message: JSON.stringify({
        notificationType: 'Received',
        mail: { messageId: `ses-${key}` },
        receipt: { action: { type: 'S3', bucketName: opts.bucket ?? BUCKET, objectKey: key } },
      }),
    }),
  };
}

let deliveries = 0;
const sentIds = new Map<string, SendResult>();
function adapter() {
  return emailAdapter({
    config: { topicArn: TOPIC, inboundBucket: BUCKET },
    getRaw: async (_b, key) => raw(key),
    ownAddresses: async () => ['kaki-bakery@in.kaki.test'],
    send: async (msg: OutboundMessage) => {
      const seen = sentIds.get(msg.id);
      if (seen) return seen;
      deliveries += 1;
      const r: SendResult = { ok: true, externalId: `<${msg.id}@in.kaki.test>` };
      sentIds.set(msg.id, r);
      return r;
    },
    checkDomain: async (tenantId) =>
      tenantId === TENANT ? { ok: true } : domainHealth('failing', { ...pass, exists: false }),
  });
}

adapterContractSuite('email', adapter, () => ({
  credential,
  revokedCredential,
  inbound: [
    {
      name: 'first',
      raw: sns('first'),
      events: [
        {
          kind: 'message',
          tenantId: TENANT,
          connectionId: credential.connectionId,
          externalUserId: 'tan.mei@gmail.com',
          text: 'Hi, do you deliver to Tampines? I need a chocolate cake on Saturday.\nMy NRIC is S1234567D if you need it.\n\nThanks,\nMei',
          attachments: [],
          localeHint: null,
          extensions: {
            subject: 'Birthday cake for Saturday',
            messageId: '<CAF1first@mail.gmail.com>',
            threadKey: '<CAF1first@mail.gmail.com>',
            ignore: null,
          },
        },
      ],
    },
  ],
  rejected: [
    { name: 'another topic', raw: sns('first', { topic: 'arn:aws:sns:x:1:other' }) },
    { name: 'another bucket', raw: sns('first', { bucket: 'someone-else' }) },
    { name: 'not JSON', raw: { headers: {}, body: '<html>', receivedAt: new Date() } },
  ],
  ignored: [
    { name: 'gmail vacation', raw: sns('gmail-vacation'), reason: 'auto_reply' },
    { name: 'outlook OOF', raw: sns('outlook-oof'), reason: 'auto_reply' },
    { name: 'DSN', raw: sns('dsn'), reason: 'bounce' },
    { name: 'list post', raw: sns('list-post'), reason: 'bulk' },
    { name: 'newsletter', raw: sns('newsletter'), reason: 'bulk' },
  ],
  outbound: {
    msg: { id: '33333333-3333-4333-8333-333333333333', text: 'Yes, we deliver to Tampines.' },
    ctx: {
      tenantId: TENANT,
      connectionId: credential.connectionId,
      threadKey: '<CAF1first@mail.gmail.com>',
      credential,
    },
  },
  deliveries: () => deliveries,
}));
