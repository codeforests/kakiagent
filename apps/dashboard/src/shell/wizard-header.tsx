import { Button } from '@kaki/ui';
import type { OnboardingProgress } from '@kaki/contracts';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import {
  finishedCount,
  nextStep,
  prevStep,
  stepByKey,
  stepNumber,
  stepOf,
  stepState,
  STEPS,
  useProgress,
  useRecordStep,
  useWizardToast,
  WizardToast,
  type Step,
} from '../lib/onboarding.ts';

/** The setup wizard's frame (FEAT-035 ui-design "Wizard frame"): header above each step, footer below. */

const EMPTY: OnboardingProgress = { currentStep: 'profile', steps: {}, firstLiveAt: null };

/** The `/setup` layout route's element: the header, the step, and the frame's own toast. */
export function SetupLayout() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <WizardToast.Provider value={setToast}>
      <WizardHeader />
      <Outlet />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </WizardToast.Provider>
  );
}

export function WizardHeader() {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const step = stepOf(pathname);
  const progress = useProgress().data ?? EMPTY;
  const record = useRecordStep();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const first = useRef(true);
  const key = step?.key;

  // Each step change: record `visited` (fire and forget, D6) and set the title.
  useEffect(() => {
    if (!key) return;
    record.mutate({ step: key, outcome: 'visited' });
    document.title = `${stepByKey(key).title} · Setup · KakiAgent`;
    // `record` changes identity each render; only the step matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Focus: a Fix link's section (`#assistant`, `#privacy`), else the page's h1 after a step change.
  useEffect(() => {
    if (!key) return;
    const firstRender = first.current;
    first.current = false;
    if (firstRender && !hash) return;
    const frame = requestAnimationFrame(() => {
      const target =
        (hash && document.getElementById(hash.slice(1))) ||
        document.querySelector<HTMLElement>('#main h1');
      if (!target) return;
      target.tabIndex = -1;
      target.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [key, hash]);

  if (!step) return null;
  const finished = finishedCount(progress);
  const saveAndExit = () => {
    record.mutate({ step: step.key, outcome: 'visited' });
    void navigate('/', {
      state: { toast: 'Setup saved. Pick up where you left off from Home.' },
    });
  };

  return (
    <div className="wizard-header">
      <div className="wizard-header__row">
        <p className="wizard-header__caption">Set up your assistant</p>
        <Button variant="ghost" onClick={saveAndExit}>
          Save and exit
        </Button>
      </div>
      <p className="wizard-header__step">
        Step {stepNumber(step.key)} of {STEPS.length} · {step.title}
      </p>
      <div
        className="progress wizard-header__progress"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={STEPS.length}
        aria-valuenow={finished}
        aria-valuetext={`${finished} of ${STEPS.length} steps finished`}
      >
        <div className="progress__bar" style={{ width: `${(finished / STEPS.length) * 100}%` }} />
      </div>
      <Button
        variant="ghost"
        className="wizard-header__toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        All steps
      </Button>
      <nav aria-label="Setup steps">
        <ol id={listId} className="wizard-steps" data-open={open || undefined}>
          {STEPS.map((s) => (
            <StepLink
              key={s.key}
              step={s}
              current={s.key === step.key}
              progress={progress}
              onPick={() => setOpen(false)}
            />
          ))}
        </ol>
      </nav>
    </div>
  );
}

function StepLink({
  step,
  current,
  progress,
  onPick,
}: {
  step: Step;
  current: boolean;
  progress: OnboardingProgress;
  onPick: () => void;
}) {
  const state = stepState(progress, step.key);
  return (
    <li className={`wizard-steps__item wizard-steps__item--${state}`}>
      <Link to={step.path} aria-current={current ? 'step' : undefined} onClick={onPick}>
        {state === 'done' && (
          <>
            <span className="wizard-steps__icon" aria-hidden="true">
              ✓
            </span>
            {step.title}
            <span className="sr-only"> done</span>
          </>
        )}
        {state !== 'done' && step.title}
        {state === 'skipped' && <span className="chip chip--neutral">Skipped</span>}
      </Link>
    </li>
  );
}

/**
 * Back, Skip for now and Continue on steps 2–6. Continue and Skip record the outcome, then move on
 * whether or not that worked (progress is a convenience, D6).
 */
export function WizardFooter({ caption }: { caption?: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const toast = useWizardToast();
  const record = useRecordStep();
  const step = stepOf(pathname);
  if (!step) return null;
  const next = nextStep(step.key);
  const prev = prevStep(step.key);
  const busy = record.isPending;
  const advance = (outcome: 'done' | 'skipped') =>
    record.mutate(
      { step: step.key, outcome },
      {
        onSettled: () => {
          if (outcome === 'skipped') toast('Skipped. You can come back to it from the step list.');
          if (next) void navigate(next.path);
        },
      },
    );
  return (
    <div className="wizard-footer">
      <div className="wizard-footer__buttons">
        {prev && (
          <Button variant="secondary" disabled={busy} onClick={() => void navigate(prev.path)}>
            Back
          </Button>
        )}
        {step.skippable && (
          <Button variant="ghost" disabled={busy} onClick={() => advance('skipped')}>
            Skip for now
          </Button>
        )}
        <Button disabled={busy} onClick={() => advance('done')}>
          {busy && record.variables?.outcome === 'done' ? 'Continue…' : 'Continue'}
        </Button>
      </div>
      {caption && <p className="review-setup__caption">{caption}</p>}
    </div>
  );
}
