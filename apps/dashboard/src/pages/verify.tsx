import { Button } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { AuthLayout, Spinner } from './auth-layout.tsx';

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
      queryClient.clear();
      void navigate(next === 'app' ? '/inbox' : '/welcome', { replace: true });
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
