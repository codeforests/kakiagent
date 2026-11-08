/**
 * The custom sending domain (CHN-04, NFR-18; FEAT-036 §5.1 `identity.ts`, D1, D4). SES holds
 * the identity (Easy DKIM, a `mail.<domain>` MAIL FROM); DMARC is checked in DNS. A domain is
 * `verified` only while DKIM, MAIL FROM and DMARC all pass; a verified domain that loses a
 * record is `failing`, and replies fall back to the forwarding address until it recovers.
 */
import { resolveTxt as dnsResolveTxt } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import type { EmailDomainRecord, EmailDomainState } from '@kaki/contracts';
import type { HealthStatus } from '../adapter.js';

export interface IdentityStatus {
  /** False when the provider has no identity for the domain (deleted outside the product). */
  exists: boolean;
  dkim: boolean;
  mailFrom: boolean;
}

/** The provider port: SES v2 in production, `fixture` in local and test builds. */
export interface SendingIdentities {
  create(domain: string): Promise<{ dkimTokens: string[]; mailFrom: string }>;
  status(domain: string): Promise<IdentityStatus>;
  remove(domain: string): Promise<void>;
}

/** DNS TXT lookups (`node:dns` in production; a fake in tests). */
export interface TxtResolver {
  resolveTxt(host: string): Promise<string[][]>;
}

export const nodeTxtResolver: TxtResolver = { resolveTxt: (host) => dnsResolveTxt(host) };

export class IdentityProviderError extends Error {}

/** Free-mail domains a tenant can't send from: they aren't theirs to sign (§3 `platform_domain`). */
export const FREE_MAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
] as const;

/** The domain part of an address, lower-cased. */
export const domainOf = (address: string) =>
  address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/** Whether a reply-from address is refused: free mail, or our own platform domain. */
export function refusedDomain(address: string, platformDomain: string): boolean {
  const d = domainOf(address);
  const p = platformDomain.toLowerCase().replace(/^in\./, '');
  return (FREE_MAIL_DOMAINS as readonly string[]).includes(d) || d === p || d.endsWith(`.${p}`);
}

export interface DomainChecks {
  exists: boolean;
  dkim: boolean;
  mailFrom: boolean;
  dmarc: boolean;
}

export const allPass = (c: DomainChecks) => c.exists && c.dkim && c.mailFrom && c.dmarc;

/** The domain state machine: pending → verified; verified ⇄ failing. Pending never fails. */
export function nextDomainState(prev: EmailDomainState, checks: DomainChecks): EmailDomainState {
  if (allPass(checks)) return 'verified';
  return prev === 'pending' ? 'pending' : 'failing';
}

/** The health a domain state reports (CHN-12): only `failing` degrades the connection. */
export function domainHealth(state: EmailDomainState | null, checks: DomainChecks): HealthStatus {
  if (state !== 'failing') return { ok: true };
  return { ok: false, reason: checks.exists ? 'credential_invalid' : 'credential_revoked' };
}

/** Whether `_dmarc.<domain>` has a DMARC record; any lookup failure counts as missing. */
export async function hasDmarc(resolver: TxtResolver, domain: string): Promise<boolean> {
  try {
    const rows = await resolver.resolveTxt(`_dmarc.${domain}`);
    return rows.some((parts) => parts.join('').trim().toUpperCase().startsWith('V=DMARC1'));
  } catch {
    return false;
  }
}

export async function checkDomain(
  identities: SendingIdentities,
  resolver: TxtResolver,
  domain: string,
): Promise<DomainChecks> {
  const [status, dmarc] = await Promise.all([
    identities.status(domain),
    hasDmarc(resolver, domain),
  ]);
  return { ...status, dmarc };
}

/**
 * The DNS rows the owner adds (SCR-APP-038): three DKIM CNAMEs, the MAIL FROM MX and SPF,
 * and a DMARC TXT shown only while it's missing. With `checks` (a check just ran) each row
 * has its own result; without, the rows take the stored state.
 */
export function records(input: {
  domain: string;
  dkimTokens: readonly string[];
  region: string;
  state: EmailDomainState;
  checks?: DomainChecks | null;
}): EmailDomainRecord[] {
  const { domain, region, state, checks } = input;
  const status = (pass: boolean | undefined): EmailDomainRecord['status'] => {
    if (pass === undefined) return state === 'verified' ? 'ok' : state;
    if (pass) return 'ok';
    return state === 'pending' ? 'pending' : 'failing';
  };
  const mailFrom = `mail.${domain}`;
  const rows: EmailDomainRecord[] = input.dkimTokens.map((t) => ({
    purpose: 'dkim',
    type: 'CNAME',
    host: `${t}._domainkey.${domain}`,
    value: `${t}.dkim.amazonses.com`,
    status: status(checks ? checks.exists && checks.dkim : undefined),
  }));
  const mf = status(checks ? checks.exists && checks.mailFrom : undefined);
  rows.push(
    {
      purpose: 'mail_from_mx',
      type: 'MX',
      host: mailFrom,
      value: `10 feedback-smtp.${region}.amazonses.com`,
      status: mf,
    },
    {
      purpose: 'mail_from_spf',
      type: 'TXT',
      host: mailFrom,
      value: 'v=spf1 include:amazonses.com ~all',
      status: mf,
    },
  );
  const dmarcOk = checks ? checks.dmarc : state === 'verified';
  if (!dmarcOk)
    rows.push({
      purpose: 'dmarc',
      type: 'TXT',
      host: `_dmarc.${domain}`,
      value: 'v=DMARC1; p=none;',
      status: status(checks ? false : undefined),
    });
  return rows;
}

const errName = (err: unknown) => (err as { name?: string } | null)?.name ?? '';

/** SES v2 (`CreateEmailIdentity` with Easy DKIM, `PutEmailIdentityMailFromAttributes`). */
export function sesIdentities(cfg: {
  region: string;
  configurationSet?: string | undefined;
  client?: Pick<SESv2Client, 'send'>;
}): SendingIdentities {
  const client = cfg.client ?? new SESv2Client({ region: cfg.region });
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new IdentityProviderError(errName(err) || 'ses_error', { cause: err });
    }
  };
  return {
    async create(domain) {
      let tokens: string[];
      try {
        const out = await client.send(
          new CreateEmailIdentityCommand({
            EmailIdentity: domain,
            ...(cfg.configurationSet ? { ConfigurationSetName: cfg.configurationSet } : {}),
          }),
        );
        tokens = out.DkimAttributes?.Tokens ?? [];
      } catch (err) {
        if (errName(err) !== 'AlreadyExistsException')
          throw new IdentityProviderError(errName(err) || 'ses_error', { cause: err });
        const got = await call(() =>
          client.send(new GetEmailIdentityCommand({ EmailIdentity: domain })),
        );
        tokens = got.DkimAttributes?.Tokens ?? [];
      }
      const mailFrom = `mail.${domain}`;
      await call(() =>
        client.send(
          new PutEmailIdentityMailFromAttributesCommand({
            EmailIdentity: domain,
            MailFromDomain: mailFrom,
            BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
          }),
        ),
      );
      return { dkimTokens: tokens, mailFrom };
    },
    async status(domain) {
      try {
        const got = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
        return {
          exists: true,
          dkim: got.DkimAttributes?.Status === 'SUCCESS',
          mailFrom: got.MailFromAttributes?.MailFromDomainStatus === 'SUCCESS',
        };
      } catch (err) {
        if (errName(err) === 'NotFoundException')
          return { exists: false, dkim: false, mailFrom: false };
        throw new IdentityProviderError(errName(err) || 'ses_error', { cause: err });
      }
    },
    async remove(domain) {
      try {
        await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
      } catch (err) {
        if (errName(err) !== 'NotFoundException')
          throw new IdentityProviderError(errName(err) || 'ses_error', { cause: err });
      }
    },
  };
}

const fixtureTokens = (domain: string) =>
  [0, 1, 2].map((i) => createHash('sha256').update(`${domain}:${i}`).digest('hex').slice(0, 32));

/**
 * Local and test builds only: a `.test` domain passes every check (DKIM, MAIL FROM and its
 * DMARC through `fixtureTxtResolver`), anything else stays pending. Stateless, so the API
 * and the scheduler agree without sharing memory.
 */
export const fixtureIdentities: SendingIdentities = {
  create: async (domain) => ({ dkimTokens: fixtureTokens(domain), mailFrom: `mail.${domain}` }),
  status: async (domain) => {
    const ok = domain.endsWith('.test');
    return { exists: true, dkim: ok, mailFrom: ok };
  },
  remove: async () => {},
};

export const fixtureTxtResolver: TxtResolver = {
  resolveTxt: async (host) => (host.endsWith('.test') ? [['v=DMARC1; p=none;']] : []),
};

export type IdentityProviderKind = 'ses' | 'fixture';

/** The configured provider; a production build refuses `fixture` (AGENTS.md dev-only rule). */
export function identityProvider(
  kind: IdentityProviderKind,
  cfg: { region: string; configurationSet?: string | undefined },
): { identities: SendingIdentities; resolver: TxtResolver } {
  if (kind === 'ses') return { identities: sesIdentities(cfg), resolver: nodeTxtResolver };
  if (process.env.KAKI_BUILD === 'production')
    throw new Error('EMAIL_IDENTITY_PROVIDER=fixture is not allowed in a production build');
  return { identities: fixtureIdentities, resolver: fixtureTxtResolver };
}
