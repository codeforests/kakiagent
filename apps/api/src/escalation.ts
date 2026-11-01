import { EscalationRouting, EscalationRoutingBody } from '@kaki/contracts';
import { audit, auditCode } from '@kaki/governance';
import { schema, sql, withTenant, type Tx } from '@kaki/db';
import { can } from '@kaki/identity';
import { DEFAULT_REMINDER_MINUTES, escalationCandidates, routingOf } from '@kaki/inbox';
import type { FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

/** 422 `invalid_routing` with a code per field (`person_required`, `invalid`). */
export class EscalationRoutingBodyError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('invalid escalation routing');
  }
}
/** 422 `person_not_member`: the named person isn't an active member of this business. */
export class PersonNotMemberError extends Error {}

export function escalationErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof EscalationRoutingBodyError)
    return {
      status: 422,
      body: {
        error: 'invalid_routing',
        message: 'Check the highlighted settings',
        fields: err.fields,
      },
    };
  if (err instanceof PersonNotMemberError)
    return {
      status: 422,
      body: {
        error: 'person_not_member',
        message: "That person isn't an active member of this team.",
      },
    };
  return null;
}

function fieldsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = issue.path.join('.') || 'body';
    if (!out[path]) out[path] = issue.code === 'custom' ? issue.message : 'invalid';
  }
  return out;
}

async function view(tx: Tx, tenantId: string): Promise<EscalationRouting> {
  const row = await routingOf(tx, tenantId);
  const person = row?.mode === 'person' ? row.personUserId : null;
  const active = person ? (await escalationCandidates(tx)).some((c) => c.userId === person) : true;
  return EscalationRouting.parse({
    mode: row?.mode ?? 'round_robin',
    personUserId: row?.personUserId ?? null,
    reminderMinutes: row?.reminderMinutes ?? DEFAULT_REMINDER_MINUTES,
    personInactive: !active,
  });
}

/**
 * Escalation routing on Team (INB-05; FEAT-044 §3, §5.6, D2): every member who reads the inbox
 * sees it; owners and admins (`team.manage`) change it. Tenant from the session only.
 */
export function registerEscalationRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb } = deps;

  app.get('/api/v1/settings/escalation', async (req) => {
    const s = await sessionFrom(req);
    if (!can(s.role, 'inbox.read')) throw new ForbiddenError('inbox.read');
    return withTenant(dashboardDb, s.tenantId, (tx) => view(tx, s.tenantId));
  });

  app.put('/api/v1/settings/escalation', async (req) => {
    const s = await sessionFrom(req);
    if (!can(s.role, 'team.manage')) throw new ForbiddenError('team.manage');
    const parsed = EscalationRoutingBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new EscalationRoutingBodyError(fieldsOf(parsed.error));
    const body = parsed.data;
    const person = body.mode === 'person' ? body.personUserId : null;
    return withTenant(dashboardDb, s.tenantId, async (tx) => {
      if (person && !(await escalationCandidates(tx)).some((c) => c.userId === person))
        throw new PersonNotMemberError();
      const r = schema.escalationRouting;
      const values = {
        mode: body.mode,
        personUserId: person,
        reminderMinutes: body.reminderMinutes,
        updatedAt: sql`now()`,
        updatedBy: s.userId,
      };
      await tx
        .insert(r)
        .values({ tenantId: s.tenantId, ...values })
        .onConflictDoUpdate({ target: r.tenantId, set: values });
      await audit.append(tx, s.tenantId, {
        action: 'escalation.routing_updated',
        actorType: 'user',
        actorId: s.userId,
        subjectType: 'tenant',
        subjectId: s.tenantId,
        related: person ? [{ type: 'user', id: person }] : [],
        payload: { mode: auditCode(body.mode), reminderMinutes: body.reminderMinutes },
      });
      return view(tx, s.tenantId);
    });
  });
}
