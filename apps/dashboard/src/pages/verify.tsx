import { Button } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { AuthLayout, Spinner } from './auth-layout.tsx';
import { CircleCheckIcon } from './two-step-parts.tsx';

const LINK_STATES = {
  link_expired: {
    title: 'This link has expired',
    body: 'Sign-in links work for 15 minutes. Send yourself a new one.',
  },
  link_used: {
    title: 'This link has already been used',
    body: "Each link signs you in once. If that wasn't you, send a new link and sign in again.",
  },
  link_invalid: {
    title: "This link isn't valid",
    body: 'Sign-in links work for 15 minutes. Send yourself a new one.',
  },
} as const;

const NEXT_PATH = {
  app: '/inbox',
  'create-workspace': '/welcome',
  mfa: '/two-step',
  'mfa-enrol': '/two-step/setup',
} as const;

const readToken = () => new URLSearchParams(location.hash.slice(1)).get('token');

/**
 * SCR-APP-002 at `/auth/verify`, the page the emailed link opens (FEAT-005 ui-design).
 * The token travels in the fragment, so it never reaches a server log or a Referer.
 */
export function VerifyPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token] = useState(readToken);
  // React's development double-mount must not post the token twice: the second post
  // would find the link already used.
  const posted = useRef(false);
  const verify = useMutation({
    mutationFn: (t: string) => api.verifyMagicLink(t),
    onSuccess: ({ next }) => {
      // A re-auth link (FEAT-006): the tab that asked carries on; this one just says so.
      if (next === 'reauthed') return;
      queryClient.clear();
      void navigate(NEXT_PATH[next], { replace: true });
    },
  });

  useEffect(() => {
    // Keep the token out of the address bar and history.
    if (location.hash) history.replaceState(history.state, '', location.pathname);
    if (!token || posted.current) return;
    posted.current = true;
    verify.mutate(token);
  }, [token, verify]);

  const code =
    token === null
      ? 'link_invalid'
      : verify.error instanceof ApiError && verify.error.code in LINK_STATES
        ? (verify.error.code as keyof typeof LINK_STATES)
        : null;

  if (code) {
    const s = LINK_STATES[code];
    return (
      <AuthLayout title={s.title}>
        <p className="auth__body">{s.body}</p>
        <Button asChild className="auth__wide">
          <Link to="/sign-in">Send a new link</Link>
        </Button>
      </AuthLayout>
    );
  }

  if (verify.data?.next === 'reauthed') return <Reauthed />;

  if (verify.error instanceof ApiError && verify.error.code === 'link_other_session') {
    return (
      <AuthLayout title="Open this link in the browser you were using">
        <p className="auth__body">
          This confirmation link only works in the browser where you asked for it. Copy it into that
          browser, or start the change again here.
        </p>
        <Button asChild className="auth__wide">
          <Link to="/inbox">Go to the dashboard</Link>
        </Button>
      </AuthLayout>
    );
  }

  if (verify.isError) {
    return (
      <AuthLayout title="Signing you in">
        <div className="alert alert--danger" role="alert">
          <p className="alert__title">We couldn't sign you in</p>
          <p>Check your connection, then try the link again.</p>
        </div>
        <Button className="auth__wide" onClick={() => token && verify.mutate(token)}>
          Try again
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Signing you in" busy>
      <p className="auth__body">
        <Spinner /> One moment.
      </p>
    </AuthLayout>
  );
}

/** SCR-APP-002 after a re-auth link (FEAT-006 ui-design): the change carries on in the other tab. */
function Reauthed() {
  // Scripts may close only a tab with no history of its own; hide the button elsewhere.
  const [canClose, setCanClose] = useState(() => history.length <= 1);
  return (
    <AuthLayout title="You're confirmed">
      <span className="auth__icon auth__icon--success" aria-hidden="true">
        <CircleCheckIcon />
      </span>
      <p className="auth__body">
        Go back to the tab where you were making the change. It carries on by itself.
      </p>
      {canClose && (
        <Button
          variant="secondary"
          className="auth__wide"
          onClick={() => {
            window.close();
            setTimeout(() => setCanClose(false), 300);
          }}
        >
          Close this tab
        </Button>
      )}
    </AuthLayout>
  );
}
