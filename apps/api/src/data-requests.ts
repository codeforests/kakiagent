import {
  DsrCompleteBody,
  DsrCorrectionBody,
  DsrCreateBody,
  DsrDetail,
  DsrEraseBody,
  DsrEraseResult,
  DsrExportBody,
  DsrFindResult,
  DsrList,
  DsrListQuery,
  DsrPatchBody,
  DsrReasonBody,
  DsrVerifyBody,
  type DsrErrorCode,
} from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import {
  closeRequest,
  completeRequest,
  correctSubject,
  createRequest,
  DsrError,
  eraseSubject,
  exportSubject,
  findSubject,
  getRequest,
  identifiersOf,
  listRequests,
  markUnverified,
  memberIdsOf,
  requestEvents,
  toDetail,
  updateRequest,
  VerifyCooldown,
  verifyForDashboard,
  VerifyRunning,
  verifyRequest,
  type DsrRow,
} from '@kaki/governance';
import { can, memberNames, requireReauth } from '@kaki/identity';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

const STATUS: Record<DsrErrorCode, number> = {
  not_found: 404,
  state_changed: 409,
  wrong_type: 409,
  not_in_result: 422,
  nothing_selected: 422,
  too_large: 413,
  identifier_required: 400,
  future_date: 400,
};
const MESSAGE: Record<DsrErrorCode, string> = {
  not_found: 'No such data request',
  state_changed: 'This request changed since you loaded it',
  wrong_type: "This request type can't do that",
  not_in_result: 'Something selected is no longer in the search results',
  nothing_selected: 'Select at least one item',
  too_large: 'Too much data to export at once; export fewer conversations',
  identifier_required: 'Enter an email, phone number or Telegram ID',
  future_date: "The received date can't be in the future",
};

/** `DsrError` → its status and `{ error, message }` (FEAT-061 §3). */
export function dsrErrorReply(err: unknown): { status: number; body: DsrErrorBody } | null {
  if (!(err instanceof DsrError)) return null;
  return { status: STATUS[err.code], body: { error: err.code, message: MESSAGE[err.code] } };
}
type DsrErrorBody = { error: DsrErrorCode; message: string };

const RequestId = z.uuid();

/**
 * Data-subject requests (SCR-APP-048, SCR-APP-049; GOV-05, UC-31; FEAT-061 §5.7): log, verify,
 * find, export, correct, erase, close. Owner and Admin (`dsr.manage`); export and erase are
 * sensitive actions (AUTH-03). Tenant from the session only; another tenant's ID is 404.
 */
export function registerDataRequestRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, identityDb } = deps;
  const backupRetentionDays = deps.config.BACKUP_RETENTION_DAYS;

  async function manager(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'dsr.manage')) throw new ForbiddenError('dsr.manage');
    return s;
  }
  function idOf(req: FastifyRequest): string {
    const id = RequestId.safeParse((req.params as { id: string }).id);
    if (!id.success) throw new DsrError('not_found');
    return id.data;
  }
  const inTenant = <T>(s: TenantSession, fn: (tx: Tx) => Promise<T>) =>
    withTenant(dashboardDb, s.tenantId, fn);

  /** The detail with its audit events; member names come from identity (§5.7). */
  async function detailOf(s: TenantSession, tx: Tx, row: DsrRow): Promise<DsrDetail> {
    const events = await requestEvents(tx, s.tenantId, row.id);
    const ids = memberIdsOf(row, events);
    const names = ids.length
      ? await withTenant(identityDb, s.tenantId, (itx) => memberNames(itx, ids))
      : new Map<string, string>();
    return DsrDetail.parse(
      toDetail(row, events, (id) => (id ? (names.get(id) ?? null) : null), {
        backupRetentionDays,
      }),
    );
  }
  const write = (s: TenantSession, fn: (tx: Tx) => Promise<DsrRow>): Promise<DsrDetail> =>
    inTenant(s, async (tx) => detailOf(s, tx, await fn(tx)));

  app.get('/api/v1/data-requests', async (req) => {
    const s = await manager(req);
    const q = DsrListQuery.parse(req.query ?? {});
    return DsrList.parse(await inTenant(s, (tx) => listRequests(tx, s.tenantId, q)));
  });

  app.post('/api/v1/data-requests', async (req, reply) => {
    const s = await manager(req);
    const body = DsrCreateBody.parse(req.body ?? {});
    const detail = await write(s, (tx) => createRequest(tx, s.tenantId, s.userId, body));
    return reply.code(201).send(detail);
  });

  app.get('/api/v1/data-requests/:id', async (req) => {
    const s = await manager(req);
    const id = idOf(req);
    return inTenant(s, async (tx) => detailOf(s, tx, await getRequest(tx, s.tenantId, id)));
  });

  app.patch('/api/v1/data-requests/:id', async (req) => {
    const s = await manager(req);
    const id = idOf(req);
    const body = DsrPatchBody.parse(req.body ?? {});
    return write(s, (tx) => updateRequest(tx, s.tenantId, s.userId, id, body));
  });

  app.post('/api/v1/data-requests/:id/verify', async (req) => {
    const s = await manager(req);
    const id = idOf(req);
    const body = DsrVerifyBody.parse(req.body ?? {});
    return write(s, (tx) => verifyRequest(tx, s.tenantId, s.userId, id, body));
  });

  app.post('/api/v1/data-requests/:id/unverified', async (req) => {
    const s = await manager(req);
    const id = idOf(req);
    const body = DsrReasonBody.parse(req.body ?? {});
    return write(s, (tx) => markUnverified(tx, s.tenantId, s.userId, id, body));
  });

  app.post('/api/v1/data-requests/:id/close', async (req) => {
    const s = await manager(req);
    const id = idOf(req);
    const body = DsrReasonBody.parse(req.body ?? {});
    return write(s, (tx) => closeRequest(tx, s.tenantId, s.userId, id, body));
  });

  app.post('/api/v1/data-requests/:id/complete', async (req) => {
    const s = await manager(req);
    const id = idOf(req);
    const body = DsrCompleteBody.parse(req.body ?? {});
    return write(s, (tx) => completeRequest(tx, s.tenantId, s.userId, id, body));
  });

  // D9: a preview on an open request; every action needs `verified`.
  app.get('/api/v1/data-requests/:id/find', async (req) => {
    const s = await manager(req);
    const id = idOf(req);
    const found = await inTenant(s, async (tx) => {
      const row = await getRequest(tx, s.tenantId, id);
      if (row.status !== 'open' && row.status !== 'verified') throw new DsrError('state_changed');
      return findSubject(tx, s.tenantId, identifiersOf(row));
    });
    return DsrFindResult.parse(found.result);
  });

  app.post('/api/v1/data-requests/:id/export', async (req, reply) => {
    const s = await manager(req);
    requireReauth(s);
    const id = idOf(req);
    const body = DsrExportBody.parse(req.body ?? {});
    const out = await inTenant(s, (tx) =>
      exportSubject(tx, s.tenantId, s.userId, id, body.version, body.selection),
    );
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${out.fileName}"`)
      .header('Cache-Control', 'no-store')
      .send(JSON.stringify(out.file, null, 2));
  });

  app.post('/api/v1/data-requests/:id/corrections', async (req) => {
    const s = await manager(req);
    const id = idOf(req);
    const body = DsrCorrectionBody.parse(req.body ?? {});
    return write(
      s,
      async (tx) => (await correctSubject(tx, s.tenantId, s.userId, id, body)).request,
    );
  });

  app.post('/api/v1/data-requests/:id/erase', async (req) => {
    const s = await manager(req);
    requireReauth(s);
    const id = idOf(req);
    const body = DsrEraseBody.parse(req.body ?? {});
    const out = await inTenant(s, async (tx) => {
      const erased = await eraseSubject(tx, s.tenantId, s.userId, id, body.version, body.selection);
      return { erased, detail: await detailOf(s, tx, erased.request) };
    });
    // D11: the chain check after commit; a cooldown or a running check shows "not checked".
    let chain: 'intact' | 'broken' | 'not_checked' = 'not_checked';
    try {
      const v = await verifyForDashboard(dashboardDb, s.tenantId, {
        anchors: deps.auditAnchors,
        userId: s.userId,
        log: deps.logger,
      });
      chain = v.ok ? 'intact' : 'broken';
    } catch (err) {
      // The deletion has committed: a failed check never turns it into an error.
      if (!(err instanceof VerifyCooldown || err instanceof VerifyRunning))
        deps.logger.error({ err, requestId: id }, 'chain check after erase failed');
    }
    return DsrEraseResult.parse({
      detail: out.detail,
      counts: out.erased.counts,
      auditSeq: out.erased.auditSeq,
      chain,
    });
  });
}
