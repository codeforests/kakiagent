/**
 * The domain check against stored settings (CHN-04, CHN-12; FEAT-036 §5.1 `checkHealth`):
 * read the settings, check the provider and DNS outside any transaction, then store the
 * new state. The health job (outbox zone) and "Check" on SCR-APP-038 (dashboard zone) share it.
 */
import { eq, schema, withTenant, type ZoneDb } from '@kaki/db';
import type { EmailDomainState } from '@kaki/contracts';
import type { HealthStatus } from '../adapter.js';
import { withAdapter, type ChannelRegistry } from '../registry.js';
import { emailAdapter } from './adapter.js';
import {
  checkDomain,
  domainHealth,
  nextDomainState,
  type DomainChecks,
  type SendingIdentities,
  type TxtResolver,
} from './identity.js';

const { emailSettings } = schema;

export interface DomainCheckDeps {
  zdb: ZoneDb;
  identities: SendingIdentities;
  resolver: TxtResolver;
  now?: () => Date;
}

export interface DomainCheckResult {
  health: HealthStatus;
  /** Null when the tenant has no custom domain (forwarding only → ok). */
  state: EmailDomainState | null;
  checks: DomainChecks | null;
}

export async function checkEmailDomain(
  deps: DomainCheckDeps,
  tenantId: string,
): Promise<DomainCheckResult> {
  const now = (deps.now ?? (() => new Date()))();
  const settings = await withTenant(deps.zdb, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        domain: emailSettings.domain,
        state: emailSettings.domainState,
      })
      .from(emailSettings)
      .where(eq(emailSettings.tenantId, tenantId));
    return row;
  });
  if (!settings?.domain || !settings.state)
    return { health: { ok: true }, state: null, checks: null };
  const domain = settings.domain;
  const checks = await checkDomain(deps.identities, deps.resolver, domain);
  return withTenant(deps.zdb, tenantId, async (tx) => {
    // Read again under the lock: the domain may have been removed or replaced meanwhile.
    const [row] = await tx
      .select({
        domain: emailSettings.domain,
        state: emailSettings.domainState,
        failingSince: emailSettings.domainFailingSince,
      })
      .from(emailSettings)
      .where(eq(emailSettings.tenantId, tenantId))
      .for('update');
    if (!row?.domain || !row.state || row.domain !== domain)
      return { health: { ok: true }, state: row?.state ?? null, checks: null };
    const prev = row.state as EmailDomainState;
    const state = nextDomainState(prev, checks);
    await tx
      .update(emailSettings)
      .set({
        domainState: state,
        domainCheckedAt: now,
        ...(state === 'verified' && prev !== 'verified' ? { domainVerifiedAt: now } : {}),
        domainFailingSince: state === 'failing' ? (row.failingSince ?? now) : null,
      })
      .where(eq(emailSettings.tenantId, tenantId));
    return { health: domainHealth(state, checks), state, checks };
  });
}

/**
 * The registry with an email adapter that can run `checkHealth` (the scheduler's health job,
 * the api's "Check again"). Those roles never receive or send mail through it.
 */
export function withEmailHealth(registry: ChannelRegistry, deps: DomainCheckDeps): ChannelRegistry {
  const unused = () => Promise.reject(new Error('email inbound is not handled in this role'));
  return withAdapter(registry, 'email', () =>
    emailAdapter({
      config: { topicArn: '', inboundBucket: '' },
      getRaw: unused,
      send: async () => ({ ok: false, failed: 'permanent' }),
      checkDomain: async (tenantId) => (await checkEmailDomain(deps, tenantId)).health,
    }),
  );
}
