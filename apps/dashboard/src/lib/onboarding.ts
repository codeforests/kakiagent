import {
  ReadinessKey,
  type OnboardingProgress,
  type OnboardingStep,
  type ReadinessResponse,
  type StepOutcomeBody,
} from '@kaki/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { api, ApiError } from './api.ts';
import { AI_STATUS_KEY } from './ai-status.ts';
import { CHANNELS_KEY } from './channels.ts';

/** Helpers for the setup wizard's frame and SCR-APP-012 Go-live check (FEAT-035 ui-design). */

export interface Step {
  key: OnboardingStep;
  path: string;
  title: string;
  /** Steps 2–6 (ONB-02); the profile and Go live can't be skipped. */
  skippable: boolean;
}

export const STEPS: readonly Step[] = [
  { key: 'profile', path: '/setup', title: 'Business profile', skippable: false },
  { key: 'sources', path: '/setup/sources', title: 'Add your sources', skippable: true },
  { key: 'review', path: '/setup/review', title: 'Review your facts', skippable: true },
  { key: 'rules', path: '/setup/rules', title: 'Rules and privacy', skippable: true },
  { key: 'test', path: '/setup/test', title: 'Test your assistant', skippable: true },
  { key: 'website', path: '/setup/website', title: 'Add to your website', skippable: true },
  { key: 'go_live', path: '/setup/go-live', title: 'Go live', skippable: false },
];

const indexOf = (key: OnboardingStep) => STEPS.findIndex((s) => s.key === key);

/** The step a `/setup` path shows, or null outside the wizard. */
export function stepOf(pathname: string): Step | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return STEPS.find((s) => s.path === path) ?? null;
}

export const stepByKey = (key: OnboardingStep): Step => STEPS[indexOf(key)]!;
export const nextStep = (key: OnboardingStep): Step | null => STEPS[indexOf(key) + 1] ?? null;
export const prevStep = (key: OnboardingStep): Step | null =>
  indexOf(key) > 0 ? STEPS[indexOf(key) - 1]! : null;
/** 1-based, for "Step {n} of 7". */
export const stepNumber = (key: OnboardingStep) => indexOf(key) + 1;

/** Done or skipped steps, for the progress bar; Go live counts once the tenant is live. */
export function finishedCount(progress: OnboardingProgress): number {
  return STEPS.filter((s) => stepState(progress, s.key) !== 'not_started').length;
}

export type StepState = 'done' | 'skipped' | 'not_started';

export function stepState(progress: OnboardingProgress, key: OnboardingStep): StepState {
  if (key === 'go_live' && progress.firstLiveAt) return 'done';
  return progress.steps[key] ?? 'not_started';
}

export const PROGRESS_KEY = ['onboarding-progress'];
export const READINESS_KEY = ['onboarding-readiness'];
const noRetryOnApiError = (n: number, err: Error) => !(err instanceof ApiError) && n < 1;

export function useProgress({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: PROGRESS_KEY,
    queryFn: () => api.getProgress(),
    enabled,
    retry: noRetryOnApiError,
  });
}

/** Records a step outcome; the cache follows the server's answer. */
export function useRecordStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      step,
      outcome,
    }: {
      step: OnboardingStep;
      outcome: StepOutcomeBody['outcome'];
    }) => api.recordStep(step, outcome),
    onSuccess: (res) => queryClient.setQueryData<OnboardingProgress>(PROGRESS_KEY, res),
  });
}

export function useReadiness() {
  return useQuery({
    queryKey: READINESS_KEY,
    queryFn: () => api.getReadiness(),
    refetchOnWindowFocus: true,
    retry: noRetryOnApiError,
  });
}

/** Go live; never optimistic (design.md §4.10). */
export function useGoLive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.goLive,
    onSuccess: (res) => {
      queryClient.setQueryData<ReadinessResponse>(READINESS_KEY, res);
      void queryClient.invalidateQueries({ queryKey: PROGRESS_KEY });
      void queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
      void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
    },
  });
}

/** The failing required items, in contract order. */
export const missingItems = (readiness: ReadinessResponse): ReadinessKey[] =>
  readiness.items.filter((i) => !i.ok).map((i) => i.key);

/** The `missing` keys of a 409 `not_ready`, or null for any other error. */
export function notReadyMissing(err: unknown): ReadinessKey[] | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'not_ready') return null;
  const parsed = ReadinessKey.array().safeParse(err.details.missing);
  return parsed.success ? parsed.data : [];
}

export interface ReadinessItemText {
  label: string;
  reason: string;
  /** Where it's fixed; none for terms (support). */
  fix: string | null;
}

export const READINESS_TEXT: Record<ReadinessKey, ReadinessItemText> = {
  profile: {
    label: 'Business profile',
    reason: 'Add your industry, opening hours, a contact and a language.',
    fix: '/setup',
  },
  approved_fact: {
    label: 'At least one approved fact',
    reason: 'Approve the facts your assistant may use.',
    fix: '/setup/review',
  },
  disclosure: {
    label: 'AI disclosure',
    reason: "Check how your assistant says it's an AI, then save.",
    fix: '/setup/rules#assistant',
  },
  purpose: {
    label: 'Purpose statement',
    reason: "Say why you collect visitors' details.",
    fix: '/setup/rules#privacy',
  },
  notice: {
    label: 'Privacy notice',
    reason: 'Link your privacy notice or fill in ours.',
    fix: '/setup/rules#privacy',
  },
  terms: {
    label: 'Current terms accepted',
    reason: 'The account owner needs to accept the current terms. Contact support if this stays.',
    fix: null,
  },
  rules: {
    label: 'Boundary rules',
    reason: 'Check and save what your assistant may say and promise.',
    fix: '/setup/rules',
  },
};

export const hasWarnings = (r: ReadinessResponse) =>
  r.warnings.conflicts > 0 || r.warnings.needsReview > 0;

/** Why Go live is disabled, or null when it can be pressed (ui-design SCR-APP-012 footer). */
export function goLiveBlocked(
  r: ReadinessResponse,
  acknowledged: boolean,
  chosen: readonly string[],
): string | null {
  if (!r.ready) return 'Fix the missing items to go live.';
  if (hasWarnings(r) && !acknowledged) return 'Tick "I understand" to go live with warnings.';
  const offline = new Set(r.channels.filter((c) => c.state === 'offline').map((c) => c.id));
  if (!chosen.some((id) => offline.has(id))) return 'Choose a channel to go live on.';
  return null;
}

/** "the website chat widget", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The wizard frame's toast, which outlives the step it was raised on (the frame stays mounted). */
export const WizardToast = createContext<(text: string) => void>(() => {});
export const useWizardToast = () => useContext(WizardToast);
