import type { ReauthMethod } from '@kaki/contracts';
import { Button, FormDialog } from '@kaki/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.ts';
import {
  clockTime,
  codeFormatError,
  lockedUntil,
  normaliseCode,
  useMfaStatus,
  wrongCodeText,
  type CodeKind,
} from '../lib/mfa.ts';
import { ReauthContext, type ReauthOpener } from '../lib/reauth.ts';
import { Spinner } from '../pages/auth-layout.tsx';
import { CodeField, MailIcon } from '../pages/two-step-parts.tsx';

type Pending = { methods: ReauthMethod[]; resolve: (ok: boolean) => void };

/**
 * Gives `useReauthGuard` its dialog (FEAT-006 §5.4): in `AppShell` and around
 * `/two-step/setup`. One request at a time; a second one while open replaces nothing.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const open = useCallback<ReauthOpener>(
    (methods) => new Promise((resolve) => setPending((p) => p ?? { methods, resolve })),
    [],
  );
  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return (
    <ReauthContext.Provider value={open}>
      {children}
      {pending && <ReauthDialog methods={pending.methods} onDone={close} />}
    </ReauthContext.Provider>
  );
}

const POLL_MS = 3000;
const RESEND_AFTER_MS = 30_000;

/**
 * design.md §4.3 `reauth-dialog`, "Confirm it's you" (FEAT-006 ui-design): a code from the
 * authenticator app or a recovery code, or, without two-step, a link emailed to the user
 * that this dialog notices by polling `GET /auth/reauth`. Success closes it and the guard
 * runs the action again; Cancel leaves everything as it was.
 */
function ReauthDialog({
  methods,
  onDone,
}: {
  methods: ReauthMethod[];
  onDone: (ok: boolean) => void;
}) {
  const byCode = methods.includes('totp') || methods.includes('recovery');
  const [kind, setKind] = useState<CodeKind>(methods.includes('totp') ? 'totp' : 'recovery');
  const [code, setCode] = useState('');
  const [formatError, setFormatError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const check = useMutation({
    mutationFn: (body: { method: CodeKind; code: string }) => api.reauthenticate(body),
    onSuccess: () => onDone(true),
    onError: () => {
      setCode('');
      inputRef.current?.focus();
    },
  });

  const email = useMutation({ mutationFn: api.requestReauthLink });
  const waiting = email.isSuccess;
  // "Send another link" opens 30 s after each send.
  const [resendFor, setResendFor] = useState(0);
  useEffect(() => {
    if (!waiting) return;
    const sentAt = email.submittedAt;
    const timer = setTimeout(() => setResendFor(sentAt), RESEND_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waiting, email.submittedAt]);
  const canResend = waiting && resendFor === email.submittedAt;

  const reauth = useQuery({
    queryKey: ['reauth'],
    queryFn: api.reauthStatus,
    enabled: waiting,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: 'always',
    gcTime: 0,
  });
  const fresh = waiting && reauth.data?.fresh === true;
  useEffect(() => {
    if (fresh) onDone(true);
  }, [fresh, onDone]);

  const status = useMfaStatus();
  const busy = check.isPending;
  const locked = lockedUntil(check.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
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
    setKind(to);
  };

  const cancel = (
    <Button type="button" variant="secondary" disabled={busy} onClick={() => onDone(false)}>
      Cancel
    </Button>
  );

  const body = (
    <p className="kaki-dialog__body">
      This is a sensitive change, so we need to check it's really you.
    </p>
  );

  let content: ReactNode;
  if (byCode && locked && kind === 'totp') {
    content = (
      <>
        <div className="alert alert--warning" role="alert">
          <p className="alert__title">Too many wrong codes</p>
          <p>
            For your security, codes from your app won't work until {clockTime(locked)} (15
            minutes). You can still use a recovery code.
          </p>
        </div>
        <div className="kaki-dialog__actions">
          {cancel}
          {methods.includes('recovery') && (
            <Button type="button" onClick={() => swap('recovery')}>
              Use a recovery code
            </Button>
          )}
        </div>
      </>
    );
  } else if (byCode) {
    const fieldError = formatError ?? wrongCodeText(kind, check.error);
    const tooMany = check.error instanceof ApiError && check.error.code === 'too_many_attempts';
    const failed = check.isError && !fieldError && !tooMany;
    content = (
      <form onSubmit={submit} noValidate className="reauth-form">
        {body}
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
        <CodeField
          id="reauth-code"
          kind={kind}
          value={code}
          onChange={setCode}
          error={fieldError}
          readOnly={busy}
          inputRef={inputRef}
          autoFocus
        />
        {methods.includes('totp') && methods.includes('recovery') && (
          <Button
            type="button"
            variant="ghost"
            className="reauth-form__swap"
            onClick={() => swap(kind === 'totp' ? 'recovery' : 'totp')}
          >
            {kind === 'totp' ? 'Use a recovery code' : 'Use your authenticator app instead'}
          </Button>
        )}
        <div className="kaki-dialog__actions">
          {cancel}
          <Button type="submit" aria-busy={busy || undefined}>
            {busy ? 'Checking…' : 'Confirm'}
          </Button>
        </div>
      </form>
    );
  } else {
    const limited = email.error instanceof ApiError && email.error.status === 429;
    const sendFailed = email.isError && !limited;
    content = (
      <div className="reauth-form">
        {waiting ? (
          <div className="reauth-wait" role="status">
            <MailIcon />
            <p>
              <Spinner /> Check your email. Open the link in this browser; this window carries on by
              itself.
            </p>
          </div>
        ) : (
          <>
            {body}
            <p className="kaki-dialog__body">
              We'll email a confirmation link to {status.data?.email ?? 'your email address'}.
            </p>
          </>
        )}
        {limited && (
          <div className="alert alert--warning" role="alert">
            <p>Too many links for now. Try again in 15 minutes.</p>
          </div>
        )}
        {sendFailed && (
          <div className="alert alert--danger" role="alert">
            <p>We couldn't send the link. Check your connection and try again.</p>
          </div>
        )}
        {waiting && (
          <p className="auth__caption">
            Didn't get it?{' '}
            <Button
              type="button"
              variant="ghost"
              disabled={!canResend || email.isPending}
              onClick={() => email.mutate()}
            >
              Send another link
            </Button>
          </p>
        )}
        <div className="kaki-dialog__actions">
          {cancel}
          {!waiting && (
            <Button
              type="button"
              autoFocus
              aria-busy={email.isPending || undefined}
              onClick={() => email.mutate()}
            >
              {email.isPending ? 'Sending…' : 'Email me a link'}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onDone(false);
      }}
      title="Confirm it's you"
      busy={busy}
    >
      {content}
    </FormDialog>
  );
}
