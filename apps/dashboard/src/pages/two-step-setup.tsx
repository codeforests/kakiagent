import type { MfaEnrolmentStart } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import {
  codeFormatError,
  formatKey,
  MFA_KEY,
  normaliseCode,
  safeNext,
  useMfaStatus,
} from '../lib/mfa.ts';
import { ReauthCancelled, useReauthGuard } from '../lib/reauth.ts';
import { useSignOut } from '../lib/sign-out.ts';
import { ReauthProvider } from '../shell/reauth-dialog.tsx';
import { AuthLayout } from './auth-layout.tsx';
import { CodeField, QrCode, RecoveryCodesList } from './two-step-parts.tsx';

const CONFIRM_WRONG =
  "That code didn't work. Make sure you scanned the code on this screen, then enter the newest code.";

/** `/two-step/setup`, inside the re-auth guard: starting enrolment is a sensitive action. */
export function TwoStepSetupPage() {
  return (
    <ReauthProvider>
      <TwoStepSetup />
    </ReauthProvider>
  );
}

/**
 * SCR-APP-005 enrolment (FEAT-006 ui-design): scan, confirm, save recovery codes. Forced
 * when a workspace requires two-step (state `enrol`), otherwise from My account.
 */
function TwoStepSetup() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const status = useMfaStatus();
  const { guard } = useReauthGuard();
  const signOut = useSignOut();
  const [toast, setToast] = useToast();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [code, setCode] = useState('');
  const [formatError, setFormatError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  const start = useMutation({
    mutationFn: () => guard(api.startMfaEnrolment),
    onSuccess: () => setStep(1),
  });
  const confirm = useMutation({
    mutationFn: (c: string) => api.confirmMfaEnrolment(c),
    onSuccess: () => setStep(3),
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'no_enrolment') {
        setStep(1);
        start.mutate();
      }
      setCode('');
      inputRef.current?.focus();
    },
  });

  const ready = status.data && status.data.state !== 'challenge' && !status.data.enrolled;
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    start.mutate();
  }, [ready, start]);

  const forced = status.data?.state === 'enrol';
  if (status.data?.state === 'challenge') return <Navigate to="/two-step" replace />;
  const already =
    (status.data?.enrolled && !confirm.isSuccess) ||
    (start.error instanceof ApiError && start.error.code === 'mfa_already_enrolled');
  if (already) return <Navigate to="/account" replace />;
  if (!forced && start.error instanceof ReauthCancelled) return <Navigate to="/account" replace />;

  const signOutCaption = (
    <p className="auth__caption">
      <Link
        to="/sign-in"
        onClick={(e) => {
          e.preventDefault();
          signOut.mutate();
        }}
      >
        Sign out
      </Link>
    </p>
  );
  const cancel = !forced && (
    <Button variant="ghost" asChild>
      <Link to="/account">Cancel</Link>
    </Button>
  );
  const workspaces = status.data?.requiredBy.map((w) => w.name).join(' and ');
  const forcedAlert = forced && step !== 3 && (
    <div className="alert alert--info" role="status">
      <p>
        {workspaces || 'Your workspace'} requires two-step verification. Set it up to open the
        dashboard.
      </p>
    </div>
  );
  const lede = <p className="page-lede">Step {step} of 3</p>;

  if (status.isError || start.isError) {
    const cancelled = start.error instanceof ReauthCancelled;
    return (
      <AuthLayout title="Set up two-step verification" focusKey="failed">
        {forcedAlert}
        {cancelled ? (
          <p className="auth__body">Confirm it's you to start setting up two-step verification.</p>
        ) : (
          <div className="alert alert--danger" role="alert">
            <p>We couldn't start setup. Check your connection and try again.</p>
          </div>
        )}
        <Button
          className="auth__wide"
          onClick={() => {
            if (status.isError) void status.refetch();
            else start.mutate();
          }}
        >
          {cancelled ? 'Start setup' : 'Try again'}
        </Button>
        {forced ? signOutCaption : cancel}
      </AuthLayout>
    );
  }

  if (!status.data || !start.data) {
    return (
      <AuthLayout title="Set up two-step verification" busy>
        {forcedAlert}
        {lede}
        <div className="skeleton-qr" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
      </AuthLayout>
    );
  }

  const email = status.data.email;

  if (step === 3 && confirm.data) {
    const finish = () => {
      if (forced) {
        queryClient.clear();
        void navigate(safeNext(params.get('next')), { replace: true });
      } else {
        void queryClient.invalidateQueries({ queryKey: MFA_KEY });
        void navigate('/account', {
          replace: true,
          state: { toast: 'Two-step verification is on.' },
        });
      }
    };
    return (
      <AuthLayout title="Save your recovery codes" focusKey="3">
        {lede}
        <p className="auth__body">
          If you lose your phone, each of these codes lets you sign in once. Keep them somewhere
          safe, like a password manager. You won't see them again.
        </p>
        <RecoveryCodesList codes={confirm.data.codes} email={email} onToast={setToast} />
        <label className="checkbox">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>I've saved these codes</span>
        </label>
        <Button
          className="auth__wide"
          disabled={!saved}
          aria-describedby={saved ? undefined : 'codes-continue-help'}
          onClick={finish}
        >
          Continue
        </Button>
        {!saved && (
          <p className="auth__caption" id="codes-continue-help">
            Tick "I've saved these codes" to continue.
          </p>
        )}
        <Toast text={toast} />
      </AuthLayout>
    );
  }

  if (step === 2) {
    const fieldError =
      formatError ??
      (confirm.error instanceof ApiError && confirm.error.code === 'code_invalid'
        ? CONFIRM_WRONG
        : null);
    const failed =
      confirm.isError &&
      !fieldError &&
      !(confirm.error instanceof ApiError && confirm.error.code === 'no_enrolment');
    const submit = (e: FormEvent) => {
      e.preventDefault();
      if (confirm.isPending) return;
      const invalid = codeFormatError('totp', code);
      setFormatError(invalid);
      if (invalid) inputRef.current?.focus();
      else confirm.mutate(normaliseCode(code));
    };
    return (
      <AuthLayout title="Enter the code from your app" focusKey="2">
        {forcedAlert}
        {lede}
        <p className="auth__body">Enter the 6-digit code your app shows for KakiAgent.</p>
        {failed && (
          <div className="alert alert--danger" role="alert">
            <p>We couldn't check your code. Check your connection and try again.</p>
          </div>
        )}
        <form className="auth__form" onSubmit={submit} noValidate>
          <CodeField
            id="setup-code"
            kind="totp"
            value={code}
            onChange={setCode}
            error={fieldError}
            readOnly={confirm.isPending}
            inputRef={inputRef}
            autoFocus
          />
          <Button type="submit" className="auth__wide" aria-busy={confirm.isPending || undefined}>
            {confirm.isPending ? 'Turning on…' : 'Turn on two-step verification'}
          </Button>
        </form>
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            confirm.reset();
            setFormatError(null);
            setStep(1);
          }}
        >
          Back
        </Button>
        {forced ? signOutCaption : cancel}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Set up two-step verification" focusKey="1">
      {forcedAlert}
      {lede}
      <p className="auth__body">
        Each time you sign in, you'll enter a code from an authenticator app on your phone, such as
        Google Authenticator, Microsoft Authenticator or 1Password.
      </p>
      <ScanStep enrolment={start.data} onToast={setToast} />
      <Button className="auth__wide" onClick={() => setStep(2)}>
        Next
      </Button>
      {forced ? signOutCaption : cancel}
      <Toast text={toast} />
    </AuthLayout>
  );
}

function ScanStep({
  enrolment,
  onToast,
}: {
  enrolment: MfaEnrolmentStart;
  onToast: (text: string) => void;
}) {
  return (
    <>
      <div className="qr-plate">
        <QrCode uri={enrolment.otpauthUri} />
      </div>
      <p className="auth__body">Can't scan it? Enter this key:</p>
      <p className="setup-key" data-testid="setup-key">
        {formatKey(enrolment.secret)}
      </p>
      <Button
        variant="ghost"
        type="button"
        onClick={() =>
          void navigator.clipboard
            .writeText(enrolment.secret)
            .then(() => onToast('Key copied'))
            .catch(() => onToast("Couldn't copy. Select the key and copy it instead."))
        }
      >
        Copy key
      </Button>
    </>
  );
}

export function Toast({ text }: { text: string | null }) {
  return text ? (
    <div className="toast" role="status">
      {text}
    </div>
  ) : null;
}
