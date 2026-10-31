import { EmailChangeBody, type Account, type DeviceSession } from '@kaki/contracts';
import { Button, ConfirmDialog, ErrorState, FormDialog } from '@kaki/ui';
import { useRef, useState, type ReactNode } from 'react';
import {
  accountErrorText,
  deviceDetail,
  deviceIcon,
  expiryText,
  nameError,
  nameValue,
  useCancelEmailChange,
  useRequestEmailChange,
  useRevokeSession,
  useSessions,
  useUpdateProfile,
} from '../lib/account.ts';
import { ApiError } from '../lib/api.ts';
import { describedBy } from '../lib/form.ts';
import { ReauthCancelled } from '../lib/reauth.ts';
import { useSignOut } from '../lib/sign-out.ts';
import { GoogleMark } from './auth-layout.tsx';

/** SCR-APP-055 My account's Profile, Email address and Devices cards (FEAT-008 ui-design). */

type OnToast = (t: string) => void;

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card account-card" aria-labelledby={`${id}-title`}>
      <h2 className="section-title" id={`${id}-title`} tabIndex={-1}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A card's loading or error state; Profile and Email share one request, so one state each. */
export function CardState({
  id,
  title,
  what,
  error,
  onRetry,
}: {
  id: string;
  title: string;
  what: string;
  error: boolean;
  onRetry: () => void;
}) {
  if (error)
    return (
      <Card id={id} title={title}>
        <ErrorState
          title={`We couldn't load ${what}.`}
          action={
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          }
        />
      </Card>
    );
  return (
    <section className="card account-card" aria-busy="true" aria-label={`Loading ${what}`}>
      <div className="skeleton-line" />
      <div className="skeleton-line" />
    </section>
  );
}

// ---- Profile ------------------------------------------------------------------------

export function ProfileCard({ account, onToast }: { account: Account; onToast: OnToast }) {
  const saved = account.displayName ?? '';
  const [value, setValue] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const save = useUpdateProfile();
  const dirty = value.trim() !== saved;
  const failed = save.isError && !(save.error instanceof ApiError && save.error.status === 400);
  const fieldError =
    error ??
    (save.error instanceof ApiError && save.error.status === 400
      ? 'Use up to 60 letters, numbers and spaces.'
      : null);

  return (
    <Card id="profile" title="Profile">
      <form
        className="account-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const err = nameError(value);
          setError(err);
          if (err) {
            document.getElementById('profile-name')?.focus();
            return;
          }
          save.mutate(nameValue(value), {
            onSuccess: (a) => {
              setValue(a.displayName ?? '');
              onToast('Name saved.');
              // Save is disabled again now, which would drop focus to the page.
              document.getElementById('profile-name')?.focus();
            },
          });
        }}
      >
        {failed && (
          <div className="alert alert--danger" role="alert">
            <p>That didn't save. Try again.</p>
          </div>
        )}
        <div className="field">
          <label className="field__label" htmlFor="profile-name">
            Your name
          </label>
          <div className="account-form__row">
            <input
              id="profile-name"
              className="input"
              autoComplete="name"
              maxLength={60}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={describedBy('profile-name', fieldError ?? undefined, true)}
            />
            <Button
              type="submit"
              disabled={!dirty || save.isPending}
              aria-busy={save.isPending || undefined}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
          <p className="field__help" id="profile-name-help">
            {account.displayName
              ? 'Your team sees this. When you take over a chat, the customer sees it too.'
              : 'Your team sees your email address until you add a name.'}
          </p>
          {fieldError && (
            <p className="field__error" id="profile-name-error">
              <span aria-hidden="true">!</span> {fieldError}
            </p>
          )}
        </div>
      </form>
    </Card>
  );
}

// ---- Email address ------------------------------------------------------------------

export function EmailCard({ account, onToast }: { account: Account; onToast: OnToast }) {
  const [dialog, setDialog] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const action = useRef<HTMLButtonElement>(null);
  const request = useRequestEmailChange();
  const resend = useRequestEmailChange();
  const cancel = useCancelEmailChange();
  const pending = account.pendingEmail;
  const backToAction = (e: Event) => {
    e.preventDefault();
    action.current?.focus();
  };
  const resendFailed = resend.isError && !(resend.error instanceof ReauthCancelled);

  return (
    <Card id="email" title="Email address">
      <div>
        <p className="account-card__address">{account.email}</p>
        <p className="field__help">You sign in with this address.</p>
        {account.googleLinked && (
          <p className="field__help account-card__google">
            <GoogleMark />
            Google sign-in is linked to this address.
          </p>
        )}
      </div>
      {pending && (
        <div className="alert alert--info account-card__pending">
          <p className="alert__title">Waiting for you to confirm {pending.email}</p>
          <p>
            Open the link we sent there by {expiryText(pending.expiresAt)}. Until then you still
            sign in with {account.email}.
          </p>
          {pending.delivery === 'queued' && (
            <p>
              <span className="status-badge status-badge--neutral">Sending…</span>{' '}
              <span className="field__help">We'll keep trying to send it.</span>
            </p>
          )}
        </div>
      )}
      {resendFailed && (
        <div className="alert alert--danger" role="alert">
          <p>{accountErrorText(resend.error).text}</p>
        </div>
      )}
      <div className="account-card__actions">
        <Button
          ref={action}
          variant="secondary"
          onClick={() => {
            request.reset();
            setDialog(true);
          }}
        >
          {pending ? 'Use a different address' : 'Change email'}
        </Button>
        {pending && (
          <>
            <Button
              variant="secondary"
              disabled={resend.isPending}
              aria-busy={resend.isPending || undefined}
              onClick={() =>
                resend.mutate(pending.email, {
                  onSuccess: () => onToast(`New link sent to ${pending.email}.`),
                })
              }
            >
              {resend.isPending ? 'Sending…' : 'Send a new link'}
            </Button>
            <Button
              variant="danger-ghost"
              onClick={() => {
                cancel.reset();
                setConfirmCancel(true);
              }}
            >
              Cancel change
            </Button>
          </>
        )}
      </div>

      <ChangeEmailDialog
        open={dialog}
        onOpenChange={setDialog}
        current={account.email}
        busy={request.isPending}
        error={
          request.isError && !(request.error instanceof ReauthCancelled) ? request.error : null
        }
        onSubmit={(email) =>
          request.mutate(email, {
            onSuccess: () => {
              setDialog(false);
              onToast(`Check ${email} for the link.`);
            },
          })
        }
        onCloseAutoFocus={backToAction}
      />
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={(open) => !open && setConfirmCancel(false)}
        title={`Cancel the change to ${pending?.email ?? ''}?`}
        cancelLabel="Keep it"
        confirmLabel="Cancel change"
        confirmVariant="danger"
        busy={cancel.isPending}
        busyLabel="Cancelling…"
        onConfirm={() =>
          cancel.mutate(undefined, {
            onSuccess: () => {
              setConfirmCancel(false);
              onToast('Change cancelled.');
            },
          })
        }
        onCloseAutoFocus={backToAction}
        alert={
          cancel.isError && (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't cancel it. Check your connection and try again.</p>
            </div>
          )
        }
      >
        The link we sent stops working. You keep signing in with {account.email}.
      </ConfirmDialog>
    </Card>
  );
}

function ChangeEmailDialog({
  open,
  onOpenChange,
  current,
  busy,
  error,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
  busy: boolean;
  error: unknown;
  onSubmit: (email: string) => void;
  onCloseAutoFocus: (e: Event) => void;
}) {
  const [email, setEmail] = useState('');
  const [invalid, setInvalid] = useState(false);
  const shown = error ? accountErrorText(error) : null;
  const fieldError = invalid
    ? accountErrorText(new ApiError(400, 'validation', '')).text
    : shown?.field
      ? shown.text
      : null;

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setEmail('');
          setInvalid(false);
        }
        onOpenChange(next);
      }}
      title="Change your email address"
      busy={busy}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <form
        className="account-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const address = email.trim().toLowerCase();
          const ok = EmailChangeBody.shape.email.safeParse(address).success;
          setInvalid(!ok);
          if (!ok) {
            document.getElementById('new-email')?.focus();
            return;
          }
          onSubmit(address);
        }}
      >
        {shown && !shown.field && (
          <div className="alert alert--warning" role="alert">
            <p>{shown.text}</p>
          </div>
        )}
        <div className="field">
          <label className="field__label" htmlFor="new-email">
            New email address
          </label>
          <input
            id="new-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'new-email-error' : undefined}
          />
          {fieldError && (
            <p className="field__error" id="new-email-error">
              <span aria-hidden="true">!</span> {fieldError}
            </p>
          )}
        </div>
        <p className="kaki-dialog__body">
          We'll send a link to the new address. Nothing changes until you open it. We'll also tell{' '}
          {current} about the change.
        </p>
        <div className="kaki-dialog__actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Sending…' : 'Send link'}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}

// ---- Devices ------------------------------------------------------------------------

export function DevicesCard({ onToast }: { onToast: OnToast }) {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const signOutEverywhere = useSignOut(true);
  const [asked, setAsked] = useState<DeviceSession | null>(null);
  const [askAll, setAskAll] = useState(false);
  const toHeading = (e: Event) => {
    e.preventDefault();
    document.getElementById('devices-title')?.focus();
  };

  if (!sessions.data)
    return (
      <CardState
        id="devices"
        title="Devices"
        what="your devices"
        error={sessions.isError}
        onRetry={() => void sessions.refetch()}
      />
    );

  const list = sessions.data.sessions;
  const others = list.some((s) => !s.current);
  return (
    <Card id="devices" title="Devices">
      <p className="field__help">
        {others
          ? "Where you're signed in now. Sign out anything you don't recognise."
          : "You're only signed in here."}
      </p>
      <ul className="device-list">
        {list.map((s) => (
          <li key={s.id} className="device-row" data-testid="device">
            <span className="device-row__icon">
              {deviceIcon(s.device) === 'smartphone' ? <SmartphoneIcon /> : <MonitorIcon />}
            </span>
            <span className="device-row__text">
              <span className="device-row__name">{s.device}</span>
              <span className="device-row__meta">{deviceDetail(s)}</span>
            </span>
            {s.current ? (
              <span className="status-badge status-badge--success">This device</span>
            ) : (
              <Button
                variant="ghost"
                aria-label={`Sign out ${s.device}`}
                onClick={() => {
                  revoke.reset();
                  setAsked(s);
                }}
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others && (
        <div>
          <Button variant="danger-ghost" onClick={() => setAskAll(true)}>
            Sign out of all devices
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={asked !== null}
        onOpenChange={(open) => !open && setAsked(null)}
        title={`Sign out ${asked?.device ?? ''}?`}
        confirmLabel="Sign out"
        confirmVariant="danger"
        busy={revoke.isPending}
        busyLabel="Signing out…"
        onConfirm={() => {
          const device = asked!;
          revoke.mutate(device.id, {
            onSuccess: () => {
              setAsked(null);
              onToast(`Signed out ${device.device}.`);
            },
          });
        }}
        onCloseAutoFocus={toHeading}
        alert={
          revoke.isError && (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't sign it out. Check your connection and try again.</p>
            </div>
          )
        }
      >
        Anyone using it will need to sign in again.
      </ConfirmDialog>
      <ConfirmDialog
        open={askAll}
        onOpenChange={setAskAll}
        title="Sign out of all devices?"
        confirmLabel="Sign out everywhere"
        confirmVariant="danger"
        busy={signOutEverywhere.isPending}
        busyLabel="Signing out…"
        onConfirm={() => signOutEverywhere.mutate()}
      >
        You'll be signed out here too, and everywhere else you're signed in.
      </ConfirmDialog>
    </Card>
  );
}

// Lucide glyphs (design.md §4 icons), inline like the other pages' icons.
function Glyph({ size = 20, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const MonitorIcon = () => (
  <Glyph>
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
  </Glyph>
);

const SmartphoneIcon = () => (
  <Glyph>
    <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
    <path d="M12 18h.01" />
  </Glyph>
);

export const MailCheckIcon = () => (
  <Glyph size={40}>
    <path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    <path d="m16 19 2 2 4-4" />
  </Glyph>
);

export const ClockIcon = () => (
  <Glyph size={40}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </Glyph>
);

export const AlertTriangleIcon = () => (
  <Glyph size={40}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Glyph>
);
