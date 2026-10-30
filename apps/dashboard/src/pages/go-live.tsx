import type { ReadinessResponse } from '@kaki/contracts';
import { Button, ConfirmDialog, ErrorState } from '@kaki/ui';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError } from '../lib/api.ts';
import {
  goLiveBlocked,
  hasWarnings,
  joinNames,
  notReadyMissing,
  READINESS_TEXT,
  useGoLive,
  useReadiness,
  useWizardToast,
} from '../lib/onboarding.ts';
import { NoPermission } from './system.tsx';

/** `/setup/go-live`: SCR-APP-012 Go-live check, step 7 of the setup (ONB-09, UC-03 7–11; FEAT-035). */
export function GoLivePage() {
  const readiness = useReadiness();
  if (readiness.error instanceof ApiError && readiness.error.status === 403)
    return <NoPermission />;
  if (readiness.data?.firstLiveAt) return <Live readiness={readiness.data} />;
  const head = (
    <>
      <h1 className="page-title" tabIndex={-1}>
        Ready to go live?
      </h1>
      <p className="page-lede">
        We check a few things so visitors get safe, accurate answers from the start.
      </p>
    </>
  );
  if (readiness.isError)
    return (
      <div className="go-live">
        {head}
        <ErrorState
          title="We couldn't check your setup."
          action={
            <Button variant="secondary" onClick={() => void readiness.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  if (!readiness.data)
    return (
      <div className="go-live">
        {head}
        <div className="go-live" aria-busy="true" aria-label="Checking your setup">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card">
              <div className="skeleton-field" />
              <div className="skeleton-field" />
            </div>
          ))}
        </div>
      </div>
    );
  return (
    <div className="go-live">
      {head}
      <Check readiness={readiness.data} onReload={() => void readiness.refetch()} />
    </div>
  );
}

type Alert = 'not_ready' | 'warnings' | 'conflict' | null;

function Check({ readiness, onReload }: { readiness: ReadinessResponse; onReload: () => void }) {
  const navigate = useNavigate();
  const toast = useWizardToast();
  const goLive = useGoLive();
  const [acknowledged, setAcknowledged] = useState(false);
  const [chosen, setChosen] = useState<string[]>(() =>
    readiness.channels.filter((c) => c.state === 'offline').map((c) => c.id),
  );
  const [confirming, setConfirming] = useState(false);
  const [alert, setAlert] = useState<Alert>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (alert) alertRef.current?.focus();
  }, [alert]);

  const offline = readiness.channels.filter((c) => c.state === 'offline');
  const picked = offline.filter((c) => chosen.includes(c.id));
  const blocked = goLiveBlocked(readiness, acknowledged, chosen);
  const warned = hasWarnings(readiness);

  const confirm = () =>
    goLive.mutate(
      {
        channels: picked.map((c) => ({ id: c.id, version: c.version })),
        acknowledgeWarnings: acknowledged,
      },
      {
        onSuccess: () => {
          setConfirming(false);
          toast('Your assistant is live.');
          // The page becomes "You're live": focus its heading once the dialog has closed.
          setTimeout(() => document.querySelector<HTMLElement>('#main h1')?.focus());
        },
        onError: (err) => {
          if (!(err instanceof ApiError) || ![404, 409].includes(err.status)) return;
          setConfirming(false);
          if (notReadyMissing(err)) setAlert('not_ready');
          else if (err.code === 'warnings_unacknowledged') {
            setAcknowledged(false);
            setAlert('warnings');
          } else setAlert('conflict');
          onReload();
        },
      },
    );

  return (
    <>
      {alert === 'not_ready' && (
        <div className="alert alert--danger" role="alert" tabIndex={-1} ref={alertRef}>
          <p>Something changed. Fix the items below to go live.</p>
        </div>
      )}
      {alert === 'warnings' && (
        <div className="alert alert--warning" role="alert" tabIndex={-1} ref={alertRef}>
          <p>New warnings appeared. Check them before going live.</p>
        </div>
      )}
      {alert === 'conflict' && (
        <div className="alert alert--warning" role="alert" tabIndex={-1} ref={alertRef}>
          <p>A channel changed while you were here.</p>
          <Button
            variant="secondary"
            onClick={() => {
              setAlert(null);
              onReload();
            }}
          >
            Reload
          </Button>
        </div>
      )}

      <Required readiness={readiness} />

      {warned && (
        <section className="card stack" aria-labelledby="go-live-warnings">
          <h2 className="section-title" id="go-live-warnings">
            Warnings
          </h2>
          <Warnings readiness={readiness} />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>I understand these facts won't be used in answers yet</span>
          </label>
        </section>
      )}

      <section className="card stack" aria-labelledby="go-live-channels">
        <h2 className="section-title" id="go-live-channels">
          Channels
        </h2>
        <p className="go-live__info">Choose where your assistant starts answering.</p>
        <ul className="go-live__channels">
          {readiness.channels.map((c) => {
            const live = c.state === 'live';
            return (
              <li key={c.id} className="go-live__channel">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={live || chosen.includes(c.id)}
                    disabled={live}
                    onChange={(e) =>
                      setChosen((ids) =>
                        e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id),
                      )
                    }
                  />
                  <span>{c.name}</span>
                </label>
                {live && <span className="chip chip--success">Live</span>}
              </li>
            );
          })}
        </ul>
        <p className="go-live__info">
          {readiness.preLiveForm
            ? 'Until a channel is live, its visitors can leave their details in a contact form.'
            : 'Until a channel is live, it stays hidden. A contact form needs your purpose statement and privacy notice.'}
        </p>
      </section>

      <div className="wizard-footer">
        <div className="wizard-footer__buttons">
          <Button variant="secondary" onClick={() => void navigate('/setup/website')}>
            Back
          </Button>
          <Button
            disabled={blocked !== null}
            aria-describedby={blocked ? 'go-live-blocked' : undefined}
            onClick={() => {
              goLive.reset();
              setConfirming(true);
            }}
          >
            Go live
          </Button>
        </div>
        {blocked && (
          <p className="review-setup__caption" id="go-live-blocked">
            {blocked}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title={`Go live on ${picked.length} ${picked.length === 1 ? 'channel' : 'channels'}?`}
        confirmLabel="Go live"
        busy={goLive.isPending}
        busyLabel="Going live…"
        onConfirm={confirm}
        alert={
          goLive.isError ? (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't go live. Check your connection and try again.</p>
            </div>
          ) : null
        }
      >
        <p>
          Your assistant starts answering real visitors on {joinNames(picked.map((c) => c.name))}.
          You can take a channel offline any time in Settings → Channels.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** The seven required rows, always in contract order. */
function Required({ readiness }: { readiness: ReadinessResponse }) {
  return (
    <section className="card stack" aria-labelledby="go-live-required">
      <h2 className="section-title" id="go-live-required">
        Required
      </h2>
      <ul className="readiness-checklist" aria-label="Required before going live">
        {readiness.items.map(({ key, ok }) => {
          const text = READINESS_TEXT[key];
          return (
            <li
              key={key}
              className={`readiness-row readiness-row--${ok ? 'pass' : 'fail'}`}
              data-testid={`readiness-${key}`}
            >
              <span className="readiness-row__icon" aria-hidden="true">
                {ok ? '✓' : '✗'}
              </span>
              <div>
                <p className="readiness-row__label">
                  {text.label}
                  <span className="sr-only">{ok ? ', done' : ', missing'}</span>
                </p>
                {!ok && <p className="readiness-row__reason">{text.reason}</p>}
              </div>
              {!ok && text.fix && (
                <Button asChild variant="ghost" className="readiness-row__action">
                  <Link to={text.fix} aria-label={`Fix: ${text.label}`}>
                    Fix
                  </Link>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Warnings({ readiness }: { readiness: ReadinessResponse }) {
  const { conflicts, needsReview } = readiness.warnings;
  const rows = [
    conflicts > 0 && {
      key: 'conflicts',
      label: `${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'} not resolved`,
      reason: 'Facts that disagree stay out of answers until you choose.',
      action: 'Resolve',
      to: '/review/conflicts',
    },
    needsReview > 0 && {
      key: 'review',
      label: `${needsReview} ${needsReview === 1 ? 'fact' : 'facts'} waiting for review`,
      reason: 'They stay out of answers until you approve them.',
      action: 'Review',
      to: '/setup/review',
    },
  ].filter((r) => r !== false);
  return (
    <ul className="readiness-checklist" aria-label="Warnings">
      {rows.map((r) => (
        <li key={r.key} className="readiness-row readiness-row--warning">
          <span className="readiness-row__icon" aria-hidden="true">
            !
          </span>
          <div>
            <p className="readiness-row__label">{r.label}</p>
            <p className="readiness-row__reason">{r.reason}</p>
          </div>
          <Button asChild variant="ghost" className="readiness-row__action">
            <Link to={r.to}>{r.action}</Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** After the first go-live: what's live, and the setup read-only below. */
function Live({ readiness }: { readiness: ReadinessResponse }) {
  const live = readiness.channels.filter((c) => c.state === 'live');
  return (
    <div className="go-live">
      <h1 className="page-title" tabIndex={-1}>
        You're live
      </h1>
      <p className="page-lede">
        {live.length
          ? `Your assistant is answering visitors on ${joinNames(live.map((c) => c.name))}.`
          : 'All your channels are offline right now. Take one live in Settings → Channels.'}
      </p>
      <div className="go-live__actions">
        <Button asChild>
          <Link to="/inbox">Open the inbox</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link to="/settings/channels">Manage channels</Link>
        </Button>
      </div>
      <h2 className="section-title">Your setup</h2>
      <Required readiness={readiness} />
      {hasWarnings(readiness) && (
        <section className="card stack" aria-label="Warnings">
          <Warnings readiness={readiness} />
        </section>
      )}
    </div>
  );
}
