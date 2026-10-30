import { Button } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import {
  clockTime,
  codeFormatError,
  lockedUntil,
  normaliseCode,
  safeNext,
  useMfaStatus,
  useNow,
  wrongCodeText,
  type CodeKind,
} from '../lib/mfa.ts';
import { useSignOut } from '../lib/sign-out.ts';
import { AuthLayout, Spinner } from './auth-layout.tsx';
import { CodeField, LockIcon, ShieldCheckIcon } from './two-step-parts.tsx';

type View = CodeKind | { fewCodes: number };

/**
 * SCR-APP-005 at `/two-step` (FEAT-006 ui-design): the code challenge after sign-in, the
 * recovery-code path, and the lock after five wrong codes (UC-02 3, 3c).
 */
export function TwoStepPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const status = useMfaStatus({ refetchOnWindowFocus: true });
  const signOut = useSignOut();
  const [view, setView] = useState<View>('totp');
  const [code, setCode] = useState('');
  const [formatError, setFormatError] = useState<string | null>(null);
  const [lockedAt, setLockedAt] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The challenge comes back by itself once the lock has passed.
  const now = useNow(5000);

  const done = () => {
    queryClient.clear();
    void navigate(next, { replace: true });
  };

  const check = useMutation({
    mutationFn: async (body: { method: CodeKind; code: string }) => {
      await api.passMfaChallenge(body);
      // A used recovery code: warn when few are left (ui-design Recovery).
      return body.method === 'recovery' ? (await api.mfaStatus()).recoveryCodesLeft : null;
    },
    onSuccess: (left) => (left !== null && left <= 3 ? setView({ fewCodes: left }) : done()),
    onError: (err) => {
      const until = lockedUntil(err);
      if (until) setLockedAt(until);
      setCode('');
      inputRef.current?.focus();
    },
  });

  if (status.data?.state === 'enrol') return <Navigate to="/two-step/setup" replace />;
  if (status.data?.state === 'ok' && !check.isSuccess) return <Navigate to={next} replace />;

  const signOutLink = (
    <p className="auth__caption">
      {status.data ? `Signing in as ${status.data.email}. ` : ''}
      <Link
        to="/sign-in"
        onClick={(e) => {
          e.preventDefault();
          signOut.mutate();
        }}
      >
        {status.data ? 'Not you? Sign out' : 'Sign out'}
      </Link>
    </p>
  );

  if (!status.data) {
    return (
      <AuthLayout title="Enter your code" busy={status.isPending}>
        {status.isError ? (
          <div className="alert alert--danger" role="alert">
            <p className="alert__title">We couldn't load this page</p>
            <p>Check your connection and try again.</p>
            <Button variant="secondary" onClick={() => void status.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="auth__body">
            <Spinner /> One moment.
          </p>
        )}
      </AuthLayout>
    );
  }

  if (typeof view === 'object') {
    return (
      <AuthLayout title="You're signed in" focusKey="few">
        <div className="alert alert--warning" role="status">
          <p className="alert__title">
            You have {view.fewCodes} recovery {view.fewCodes === 1 ? 'code' : 'codes'} left.
          </p>
          <p>Get new codes so you can still sign in if you lose your phone.</p>
        </div>
        <Button
          className="auth__wide"
          onClick={() => {
            queryClient.clear();
            void navigate('/account#two-step', { replace: true });
          }}
        >
          Get new codes
        </Button>
        <Button variant="secondary" className="auth__wide" onClick={done}>
          Later
        </Button>
      </AuthLayout>
    );
  }

  const until = [lockedAt, status.data.lockedUntil].find((t) => t && Date.parse(t) > now);

  if (until && view === 'totp') {
    return (
      <AuthLayout title="Too many wrong codes" focusKey="locked">
        <span className="auth__icon auth__icon--warning" aria-hidden="true">
          <LockIcon />
        </span>
        <p className="auth__body">
          For your security, codes from your app won't work until {clockTime(until)} (15 minutes).
          You can still sign in with a recovery code.
        </p>
        <Button
          className="auth__wide"
          onClick={() => {
            check.reset();
            setView('recovery');
          }}
        >
          Use a recovery code
        </Button>
        {signOutLink}
      </AuthLayout>
    );
  }

  const kind = view;
  const fieldError = formatError ?? wrongCodeText(kind, check.error) ?? null;
  const tooMany = check.error instanceof ApiError && check.error.code === 'too_many_attempts';
  const failed = check.isError && !fieldError && !tooMany && !lockedUntil(check.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (check.isPending) return;
    const invalid = codeFormatError(kind, code);
    setFormatError(invalid);
    if (invalid) {
      inputRef.current?.focus();
      return;
    }
    check.mutate({ method: kind, code: kind === 'totp' ? normaliseCode(code) : code.trim() });
  }

  const swap = (to: CodeKind) => {
    check.reset();
    setFormatError(null);
    setCode('');
    setView(to);
  };

  return (
    <AuthLayout title={kind === 'totp' ? 'Enter your code' : 'Use a recovery code'} focusKey={kind}>
      {kind === 'totp' && (
        <span className="auth__icon" aria-hidden="true">
          <ShieldCheckIcon />
        </span>
      )}
      <p className="auth__body">
        {kind === 'totp'
          ? 'Open your authenticator app and enter the 6-digit code for KakiAgent.'
          : 'Enter one of the recovery codes you saved when you set up two-step verification. Each code works once.'}
      </p>
      {tooMany && (
        <div className="alert alert--warning" role="alert">
          <p>Too many tries. Wait 15 minutes, then try again.</p>
        </div>
      )}
      {failed && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't check your code. Check your connection and try again.</p>
        </div>
      )}
      <form className="auth__form" onSubmit={submit} noValidate>
        <CodeField
          id="two-step-code"
          kind={kind}
          value={code}
          onChange={setCode}
          error={fieldError}
          readOnly={check.isPending}
          inputRef={inputRef}
          autoFocus
        />
        <Button type="submit" className="auth__wide" aria-busy={check.isPending || undefined}>
          {check.isPending ? 'Checking…' : 'Continue'}
        </Button>
      </form>
      <Button
        variant="ghost"
        type="button"
        onClick={() => swap(kind === 'totp' ? 'recovery' : 'totp')}
      >
        {kind === 'totp' ? 'Use a recovery code' : 'Use your authenticator app instead'}
      </Button>
      {signOutLink}
    </AuthLayout>
  );
}
