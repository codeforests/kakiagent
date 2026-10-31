import type { MfaStatus } from '@kaki/contracts';
import { Button, ConfirmDialog, ErrorState, FormDialog } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useAccount } from '../lib/account.ts';
import { api, ApiError } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import { dayDate, MFA_KEY, useMfaStatus } from '../lib/mfa.ts';
import { ReauthCancelled, useReauthGuard } from '../lib/reauth.ts';
import { CardState, DevicesCard, EmailCard, ProfileCard } from './account-parts.tsx';
import { RecoveryCodesList, ShieldCheckIcon } from './two-step-parts.tsx';

/**
 * SCR-APP-055 My account: name, email and devices (FEAT-008 ui-design), then the two-step
 * part (FEAT-006 ui-design).
 */
export function AccountPage() {
  const status = useMfaStatus();
  const account = useAccount();
  const [toast, setToast] = useToast();
  const { hash } = useLocation();
  const loaded = !!status.data;

  // Confirmed in another tab: the re-read on focus brings the new address (ui-design).
  const email = account.data?.email;
  const seen = useRef(email);
  useEffect(() => {
    if (email && seen.current && seen.current !== email)
      setToast(`Your email address is now ${email}.`);
    seen.current = email;
  }, [email, setToast]);

  // "Get new codes" from the challenge lands on the card.
  useEffect(() => {
    if (loaded && hash === '#two-step') document.getElementById('two-step')?.scrollIntoView();
  }, [loaded, hash]);

  return (
    <>
      <h1 className="page-title">My account</h1>
      <p className="page-lede">
        How your team sees you, how you sign in, and where you're signed in.
      </p>
      {account.data ? (
        <>
          <ProfileCard account={account.data} onToast={setToast} />
          <EmailCard account={account.data} onToast={setToast} />
        </>
      ) : (
        (['profile', 'email'] as const).map((id) => (
          <CardState
            key={id}
            id={id}
            title={id === 'profile' ? 'Profile' : 'Email address'}
            what={id === 'profile' ? 'your profile' : 'your email address'}
            error={account.isError}
            onRetry={() => void account.refetch()}
          />
        ))
      )}
      <DevicesCard onToast={setToast} />
      {status.isError ? (
        <ErrorState
          title="We couldn't load your two-step setting."
          action={
            <Button variant="secondary" onClick={() => void status.refetch()}>
              Try again
            </Button>
          }
        />
      ) : status.data ? (
        <TwoStepCard status={status.data} onToast={setToast} />
      ) : (
        <section
          className="card two-step-card"
          aria-busy="true"
          aria-label="Loading two-step verification"
        >
          <div className="skeleton-field" />
          <div className="skeleton-field" />
        </section>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

type Confirm = 'codes' | 'off' | null;

function TwoStepCard({ status, onToast }: { status: MfaStatus; onToast: (t: string) => void }) {
  const queryClient = useQueryClient();
  const { guard } = useReauthGuard();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: MFA_KEY });

  const newCodes = useMutation({
    mutationFn: () => guard(api.newRecoveryCodes),
    onSuccess: (res) => {
      setConfirm(null);
      setCodes(res.codes);
      void refresh();
    },
  });
  const turnOff = useMutation({
    mutationFn: () => guard(api.removeMfa),
    onSuccess: () => {
      setConfirm(null);
      onToast('Two-step verification is off.');
      void refresh();
    },
  });

  const workspaces = status.requiredBy.map((w) => w.name).join(' and ');
  const requiredText = `${workspaces} requires two-step verification.`;
  const shown = (m: typeof newCodes | typeof turnOff) =>
    m.isError && !(m.error instanceof ReauthCancelled);
  const refused =
    turnOff.error instanceof ApiError && turnOff.error.code === 'mfa_required_by_workspace';

  if (!status.enrolled) {
    return (
      <section className="card two-step-card" id="two-step" aria-labelledby="two-step-title">
        <h2 className="section-title" id="two-step-title">
          Two-step verification
        </h2>
        <p>
          Add a code from your phone each time you sign in, so a stolen email can't open your
          account.
        </p>
        <Button asChild>
          <Link to="/two-step/setup">Set up</Link>
        </Button>
      </section>
    );
  }

  const few = status.recoveryCodesLeft <= 3;
  return (
    <section className="card two-step-card" id="two-step" aria-labelledby="two-step-title">
      <h2 className="section-title" id="two-step-title">
        Two-step verification
      </h2>
      <p className="two-step-card__status two-step-card__status--on">
        <ShieldCheckIcon size={16} />
        On{status.enrolledAt ? ` since ${dayDate(status.enrolledAt)}` : ''}
      </p>
      <p className={few ? 'two-step-card__codes--few' : undefined}>
        {few && <span aria-hidden="true">! </span>}
        {status.recoveryCodesLeft} recovery {status.recoveryCodesLeft === 1 ? 'code' : 'codes'} left
      </p>
      <div className="two-step-card__actions">
        <Button
          variant="secondary"
          onClick={() => {
            newCodes.reset();
            setConfirm('codes');
          }}
        >
          Get new recovery codes
        </Button>
        <Button
          variant="danger-ghost"
          disabled={!!workspaces}
          aria-describedby={workspaces ? 'two-step-off-help' : undefined}
          onClick={() => {
            turnOff.reset();
            setConfirm('off');
          }}
        >
          Turn off
        </Button>
      </div>
      {workspaces && (
        <p className="field__help" id="two-step-off-help">
          {requiredText}
        </p>
      )}

      <ConfirmDialog
        open={confirm === 'codes'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Get new recovery codes?"
        confirmLabel="Get new codes"
        busy={newCodes.isPending}
        busyLabel="Getting codes…"
        onConfirm={() => newCodes.mutate()}
        alert={
          shown(newCodes) && (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't get new codes. Check your connection and try again.</p>
            </div>
          )
        }
      >
        Your old codes stop working.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'off'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Turn off two-step verification?"
        confirmLabel="Turn off"
        confirmVariant="danger"
        busy={turnOff.isPending}
        busyLabel="Turning off…"
        confirmDisabled={refused}
        onConfirm={() => turnOff.mutate()}
        alert={
          shown(turnOff) && (
            <div className={`alert ${refused ? 'alert--warning' : 'alert--danger'}`} role="alert">
              <p>
                {refused
                  ? `${refusedBy(turnOff.error) ?? workspaces} requires two-step verification.`
                  : "We couldn't turn it off. Check your connection and try again."}
              </p>
            </div>
          )
        }
      >
        You'll sign in with just your email link or Google.
      </ConfirmDialog>
      <FormDialog
        open={codes !== null}
        onOpenChange={(open) => !open && setCodes(null)}
        title="Your new recovery codes"
      >
        <div className="reauth-form">
          <p className="kaki-dialog__body">
            Each code signs you in once. Keep them somewhere safe; you won't see them again.
          </p>
          {codes && <RecoveryCodesList codes={codes} email={status.email} onToast={onToast} />}
          <div className="kaki-dialog__actions">
            <Button onClick={() => setCodes(null)}>Done</Button>
          </div>
        </div>
      </FormDialog>
    </section>
  );
}

/** The workspace names on a 409 `mfa_required_by_workspace`. */
function refusedBy(err: unknown) {
  const names = err instanceof ApiError ? err.details.workspaces : undefined;
  return Array.isArray(names) && names.length > 0 ? names.join(' and ') : null;
}
