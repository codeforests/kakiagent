import { listChannels } from '@kaki/channels';
import {
  GoLiveBody,
  OnboardingProgress,
  OnboardingStep,
  ReadinessResponse,
  StepOutcomeBody,
} from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { can } from '@kaki/identity';
import {
  getProgress,
  goLive,
  goLiveReadiness,
  NotReadyError,
  NotSkippableError,
  recordStep,
  sgDay,
  WarningsUnacknowledgedError,
  type OnboardingProgress as DomainProgress,
} from '@kaki/tenancy';
import type { FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

/** 400 `invalid_body` (FEAT-035 §3). */
export class OnboardingBodyError extends Error {}
/** 404 for a step name the wizard doesn't have. */
export class UnknownStepError extends Error {}

/** The onboarding routes' errors, and the gate's on the Channels page, for the api's error handler. */
export function onboardingErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof NotReadyError)
    return {
      status: 409,
      body: {
        error: 'not_ready',
        message: 'Finish the go-live check first',
        missing: err.missing,
      },
    };
  if (err instanceof WarningsUnacknowledgedError)
    return {
      status: 409,
      body: {
        error: 'warnings_unacknowledged',
        message: 'Confirm you understand the warnings before going live',
      },
    };
  if (err instanceof NotSkippableError)
    return { status: 400, body: { error: 'not_skippable', message: "This step can't be skipped" } };
  if (err instanceof OnboardingBodyError)
    return {
      status: 400,
      body: { error: 'invalid_body', message: 'Check the values and try again.' },
    };
  if (err instanceof UnknownStepError)
    return { status: 404, body: { error: 'not_found', message: 'Not found' } };
  return null;
}

const progressOf = (p: DomainProgress) =>
  OnboardingProgress.parse({ ...p, firstLiveAt: p.firstLiveAt?.toISOString() ?? null });

/** Wizard progress and the go-live check (ONB-02, ONB-09; FEAT-035 §5.3). Owner and Admin. */
export function registerOnboardingRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb } = deps;

  async function manager(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'settings.manage')) throw new ForbiddenError('settings.manage');
    return s;
  }
  const inTenant = <T>(s: TenantSession, fn: (tx: Tx) => Promise<T>) =>
    withTenant(dashboardDb, s.tenantId, fn);

  async function readiness(tx: Tx, s: TenantSession) {
    const r = await goLiveReadiness(tx, s.tenantId, s.userId, sgDay(new Date()));
    const { channels } = await listChannels(tx);
    return ReadinessResponse.parse({
      ...r,
      firstLiveAt: r.firstLiveAt?.toISOString() ?? null,
      channels,
    });
  }

  app.get('/api/v1/onboarding/progress', async (req) => {
    const s = await manager(req);
    return progressOf(await inTenant(s, (tx) => getProgress(tx, s.tenantId)));
  });

  app.put<{ Params: { step: string } }>('/api/v1/onboarding/progress/:step', async (req) => {
    const s = await manager(req);
    const step = OnboardingStep.safeParse(req.params.step);
    if (!step.success) throw new UnknownStepError();
    const body = StepOutcomeBody.safeParse(req.body ?? {});
    if (!body.success) throw new OnboardingBodyError();
    return progressOf(
      await inTenant(s, (tx) => recordStep(tx, s.tenantId, step.data, body.data.outcome)),
    );
  });

  app.get('/api/v1/onboarding/readiness', async (req) => {
    const s = await manager(req);
    return inTenant(s, (tx) => readiness(tx, s));
  });

  app.post('/api/v1/onboarding/go-live', async (req) => {
    const s = await manager(req);
    const body = GoLiveBody.safeParse(req.body ?? {});
    if (!body.success) throw new OnboardingBodyError();
    return inTenant(s, async (tx) => {
      await goLive(tx, {
        tenantId: s.tenantId,
        userId: s.userId,
        ...body.data,
        today: sgDay(new Date()),
      });
      return readiness(tx, s);
    });
  });
}
