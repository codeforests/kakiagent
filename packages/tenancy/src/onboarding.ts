import { eq, schema, sql, type Tx } from '@kaki/db';

const { onboardingProgress: op } = schema;

/** The wizard's steps, in order (ONB-02; FEAT-035 §3). */
export const ONBOARDING_STEPS = [
  'profile',
  'sources',
  'review',
  'rules',
  'test',
  'website',
  'go_live',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type StepOutcome = 'visited' | 'done' | 'skipped';

export interface OnboardingProgress {
  currentStep: OnboardingStep;
  steps: Partial<Record<OnboardingStep, 'done' | 'skipped'>>;
  firstLiveAt: Date | null;
}

/** The profile and the go-live check can't be skipped (ONB-02; → 400 `not_skippable`). */
export class NotSkippableError extends Error {}

/** The step after `step`; `go_live` stays `go_live`. */
export function nextStep(step: OnboardingStep): OnboardingStep {
  const i = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)]!;
}

const isStep = (s: string): s is OnboardingStep =>
  (ONBOARDING_STEPS as readonly string[]).includes(s);

function progressOf(row: typeof op.$inferSelect | undefined): OnboardingProgress {
  if (!row) return { currentStep: 'profile', steps: {}, firstLiveAt: null };
  const steps = Object.fromEntries(
    Object.entries(row.steps).filter(([k, v]) => isStep(k) && (v === 'done' || v === 'skipped')),
  );
  return {
    currentStep: isStep(row.currentStep) ? row.currentStep : 'profile',
    steps,
    firstLiveAt: row.firstLiveAt,
  };
}

/** The tenant's progress; no row reads as never started (FEAT-035 §4). Dashboard zone. */
export async function getProgress(tx: Tx, tenantId: string): Promise<OnboardingProgress> {
  const [row] = await tx.select().from(op).where(eq(op.tenantId, tenantId));
  return progressOf(row);
}

/**
 * Records what the owner did on a step (D6, last write wins): `visited` moves the current
 * step there; `done` and `skipped` record the outcome and move to the next step.
 */
export async function recordStep(
  tx: Tx,
  tenantId: string,
  step: OnboardingStep,
  outcome: StepOutcome,
): Promise<OnboardingProgress> {
  if (outcome === 'skipped' && (step === 'profile' || step === 'go_live'))
    throw new NotSkippableError();
  const current = outcome === 'visited' ? step : nextStep(step);
  const patch = outcome === 'visited' ? {} : { [step]: outcome };
  const [row] = await tx
    .insert(op)
    .values({ tenantId, currentStep: current, steps: patch })
    .onConflictDoUpdate({
      target: op.tenantId,
      set: {
        currentStep: current,
        steps: sql`${op.steps} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return progressOf(row);
}
