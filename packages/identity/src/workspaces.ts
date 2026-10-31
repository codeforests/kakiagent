import { schema, sql, withTenant, type ZoneDb } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';
import { randomBytes, randomUUID } from 'node:crypto';
import { NotMemberError, TermsOutdatedError } from './errors.js';
import type { Role } from './capabilities.js';
import { CURRENT_TERMS, TERMS_DOCUMENTS, termsAreCurrent, type TermsDocument } from './terms.js';

export interface CreatedWorkspace {
  id: string;
  name: string;
  status: 'active';
}

/** `kaki-bakery-x7k2qp`: ASCII letters and digits from the name, plus a random suffix. */
export function workspaceSlug(name: string, suffix = randomSuffix()): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'workspace';
  return `${base}-${suffix}`;
}

function randomSuffix(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Creates a tenant with the caller as its Owner (ONB-01, AUTH-08, UC-01 steps 3–5), in
 * one transaction under the new tenant's context: the tenant ID is minted here, never
 * taken from the request (ADR-005). The session switches to the new workspace.
 */
export async function createWorkspace(
  idDb: ZoneDb,
  who: { sessionId: string; userId: string },
  input: { businessName: string; accepted: Record<TermsDocument, string> },
): Promise<CreatedWorkspace> {
  if (!termsAreCurrent(input.accepted)) throw new TermsOutdatedError();
  const tenantId = randomUUID();
  const name = input.businessName.trim();
  await withTenant(idDb, tenantId, async (tx) => {
    await tx.insert(schema.tenants).values({
      id: tenantId,
      slug: workspaceSlug(name),
      name,
      widgetKey: `wk_${randomBytes(18).toString('base64url')}`,
    });
    await tx.insert(schema.businessProfiles).values({ tenantId });
    await tx.insert(schema.widgetSettings).values({ tenantId });
    await tx.insert(schema.memberships).values({ tenantId, userId: who.userId, role: 'owner' });
    await tx.insert(schema.termsAcceptances).values(
      TERMS_DOCUMENTS.map((document) => ({
        tenantId,
        userId: who.userId,
        document,
        version: CURRENT_TERMS[document].version,
      })),
    );
    const actor = { actorType: 'user' as const, actorId: who.userId };
    await audit.append(tx, tenantId, {
      action: 'tenant.created',
      ...actor,
      subjectType: 'tenant',
      subjectId: tenantId,
    });
    await audit.append(tx, tenantId, {
      action: 'terms.accepted',
      ...actor,
      subjectType: 'tenant',
      subjectId: tenantId,
      related: [{ type: 'user', id: who.userId }],
      payload: Object.fromEntries(
        TERMS_DOCUMENTS.map((d) => [d, auditCode(CURRENT_TERMS[d].version)]),
      ),
    });
    await tx.execute(
      sql`update sessions set active_tenant_id = ${tenantId} where id = ${who.sessionId}`,
    );
  });
  return { id: tenantId, name, status: 'active' };
}

/** A workspace in the tenant switcher (contract `Workspace`, FEAT-007 §3). */
export interface WorkspaceView {
  id: string;
  name: string;
  role: Role;
  current: boolean;
}

/**
 * The user's active memberships with their tenants' names (AUTH-04, UC-02 4), by name.
 * Names across tenants come only through `user_workspaces()` (0040).
 */
export async function listWorkspaces(
  idDb: ZoneDb,
  userId: string,
  currentTenantId: string | null,
): Promise<WorkspaceView[]> {
  const { rows } = await idDb.db.execute<{ tenant_id: string; name: string; role: Role }>(
    sql`select tenant_id, name, role from user_workspaces(${userId})`,
  );
  return rows.map((r) => ({
    id: r.tenant_id,
    name: r.name,
    role: r.role,
    current: r.tenant_id === currentTenantId,
  }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Moves the session to another workspace (UC-02 4), only where the user has an active
 * membership; otherwise `NotMemberError` (404), the session unchanged.
 */
export async function switchWorkspace(
  idDb: ZoneDb,
  who: { sessionId: string; userId: string },
  tenantId: string,
): Promise<void> {
  if (!UUID_RE.test(tenantId)) throw new NotMemberError();
  const res = await idDb.db.execute(
    sql`update sessions set active_tenant_id = ${tenantId}
        where id = ${who.sessionId} and user_id = ${who.userId}
          and exists (select 1 from memberships m
                      where m.tenant_id = ${tenantId} and m.user_id = ${who.userId}
                        and m.status = 'active')`,
  );
  if (!res.rowCount) throw new NotMemberError();
}
