import { Button } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ACCOUNT_KEY, confirmFailure, useSignedIn, type ConfirmFailure } from '../lib/account.ts';
import { api } from '../lib/api.ts';
import { AlertTriangleIcon, ClockIcon, MailCheckIcon } from './account-parts.tsx';
import { AuthLayout, Spinner } from './auth-layout.tsx';

/** Reads `#token=` once and drops it from the address bar; held in memory only. */
function takeToken(): string | null {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (token) history.replaceState(history.state, '', location.pathname + location.search);
  return token;
}

/**
 * SCR-APP-055 "Confirm new email" (FEAT-008 ui-design, D10): outside the shell, signed in
 * or not. The token travels only in the request body; the page confirms once on load.
 */
export function VerifyEmailPage() {
  const [token] = useState(takeToken);
  const queryClient = useQueryClient();
  const signedIn = useSignedIn();
  const confirm = useMutation({
    mutationFn: () => api.confirmEmailChange(token!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: ACCOUNT_KEY });
    },
  });

  // Once, even under StrictMode's double effect.
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current || token === null) return;
    tried.current = true;
    confirm.mutate();
  }, [token, confirm]);

  const state: 'confirming' | 'confirmed' | ConfirmFailure =
    token === null
      ? 'invalid'
      : confirm.isSuccess
        ? 'confirmed'
        : confirm.isError
          ? confirmFailure(confirm.error)
          : 'confirming';

  useEffect(() => {
    document.title = 'Confirm your email · KakiAgent';
  }, []);

  const toAccount = (
    <Button asChild>
      <Link to="/account">Go to My account</Link>
    </Button>
  );
  const view = viewOf(state, confirm.data?.email, signedIn.data === false, toAccount, () =>
    confirm.mutate(),
  );

  // One AuthLayout for every state, so its heading takes focus as the state changes.
  return (
    <AuthLayout title={view.title} busy={state === 'confirming'} focusKey={state}>
      {view.icon && (
        <span className={`auth__icon auth__icon--${view.icon.tone}`} aria-hidden="true">
          {view.icon.glyph}
        </span>
      )}
      {view.body && <p className="auth__body">{view.body}</p>}
      {view.action}
    </AuthLayout>
  );
}

type View = {
  title: string;
  icon?: { glyph: ReactNode; tone: 'success' | 'warning' | 'danger' };
  body?: ReactNode;
  action?: ReactNode;
};

function viewOf(
  state: 'confirming' | 'confirmed' | ConfirmFailure,
  email: string | undefined,
  signedOut: boolean,
  toAccount: ReactNode,
  retry: () => void,
): View {
  switch (state) {
    case 'confirming':
      return { title: 'Confirming your new email address…', body: <Spinner /> };
    case 'confirmed':
      return {
        title: `Your email address is now ${email}`,
        icon: { glyph: <MailCheckIcon />, tone: 'success' },
        body: 'Use it the next time you sign in.',
        action: signedOut ? (
          <Button asChild>
            <Link to="/sign-in">Sign in</Link>
          </Button>
        ) : (
          toAccount
        ),
      };
    case 'expired':
      return {
        title: 'This link has expired',
        icon: { glyph: <ClockIcon />, tone: 'warning' },
        body: 'Links work for 24 hours. Ask for a new one on My account.',
        action: toAccount,
      };
    case 'used':
      return {
        title: 'This link was already used',
        body: "If your email didn't change, ask for a new link on My account.",
        action: toAccount,
      };
    case 'invalid':
      return {
        title: "This link doesn't work",
        body: 'It may have been replaced by a newer link or cancelled.',
        action: toAccount,
      };
    case 'taken':
      return {
        title: 'That address already has an account',
        icon: { glyph: <AlertTriangleIcon />, tone: 'danger' },
        body: "Your email address hasn't changed. Choose a different one on My account.",
        action: toAccount,
      };
    case 'error':
      return {
        title: "We couldn't confirm your email address.",
        action: (
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        ),
      };
  }
}
