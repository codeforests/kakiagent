import { Button, EmptyState } from '@kaki/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import { finishedCount, stepByKey, stepNumber, STEPS, useProgress } from '../lib/onboarding.ts';

/** Home (SCR-APP-012 arrives with FEAT-065). The skeleton points at the one live path. */
export function HomePage() {
  // "Setup saved…" from the wizard's Save and exit (FEAT-035).
  const [toast] = useToast();
  return (
    <>
      <h1 className="page-title">Home</h1>
      <ContinueSetup />
      <EmptyState
        title="Your assistant is running locally"
        action={
          <Button asChild>
            <Link to="/inbox">Open the inbox</Link>
          </Button>
        }
      >
        Send a message from the widget host page and it shows up in the inbox straight away.
      </EmptyState>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

/** FEAT-035: "Continue setup" until the first go-live, for the Owner and Admins only. */
function ContinueSetup() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const role = me.data?.role;
  const progress = useProgress({ enabled: role === 'owner' || role === 'admin' });
  // Loading or failed: no card.
  if (!progress.data || progress.data.firstLiveAt) return null;
  const step = stepByKey(progress.data.currentStep);
  const finished = finishedCount(progress.data);
  return (
    <section className="card setup-card" aria-labelledby="continue-setup">
      <h2 className="setup-card__title" id="continue-setup">
        Finish setting up your assistant
      </h2>
      <p>
        Step {stepNumber(step.key)} of {STEPS.length}: {step.title}. {finished} of {STEPS.length}{' '}
        steps finished.
      </p>
      <div
        className="progress"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={STEPS.length}
        aria-valuenow={finished}
        aria-valuetext={`${finished} of ${STEPS.length} steps finished`}
      >
        <div className="progress__bar" style={{ width: `${(finished / STEPS.length) * 100}%` }} />
      </div>
      <div>
        <Button asChild>
          <Link to={step.path}>Continue setup</Link>
        </Button>
      </div>
    </section>
  );
}
