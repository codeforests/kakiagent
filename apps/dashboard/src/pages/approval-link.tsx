import { MagicLinkRequest } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import {
  ENDED_STATES,
  linkState,
  linkStore,
  takeLinkToken,
  TWO_STEP_PATH,
} from '../lib/approval-link.ts';
import { AuthLayout, GoogleMark, Spinner } from './auth-layout.tsx';

const EMAIL_ERROR = 'Enter an email address, like you@yourbusiness.sg';

const ENDED = {
  expired: {
    title: 'This link has expired',
    body: 'Approval links last 24 hours. The request may still be waiting in your approvals.',
  },
  used: {
    title: 'This link has already been used',
    body: 'Each approval link works once. Open your approvals to find the request.',
  },
  invalid: {
    title: "This link isn't valid",
    body: 'It may have been copied incompletely. Open your approvals instead.',
  },
} as const;

/**
 * SCR-APP-018's link landing at `/approve` (FEAT-056 ui-design): the page an
 * `approval_pending` alert's "Review and approve" button opens. The token comes in the
 * fragment, is dropped from the address bar at once and travels only in request bodies.
 */
export function ApprovalLinkPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token] = useState(takeLinkToken);
  const open = useMutation({
    mutationFn: (t: string) => api.openApprovalLink(t),
    onSuccess: (r) => {
      if (r.state === 'opened') {
        linkStore.clear();
        // Another business's data must not show under the new one.
        if (r.switched) queryClient.clear();
        void navigate(`/approvals/${r.approvalId}`, { replace: true });
      } else if (r.state !== 'sign_in') {
        void navigate(TWO_STEP_PATH[r.state], { replace: true });
      }
    },
    onError: (err) => {
      if (ENDED_STATES.has(linkState(undefined, err))) linkStore.clear();
    },
  });
  // React's development double-mount must not post the token twice: the second open
  // would find the link already used.
  const posted = useRef(false);
  useEffect(() => {
    if (!token || posted.current) return;
    posted.current = true;
    open.mutate(token);
  }, [token, open]);

  const state = token === null ? 'invalid' : linkState(open.data, open.error);
  const retry = () => token && open.mutate(token);

  if (state === 'expired' || state === 'used' || state === 'invalid') {
    const s = ENDED[state];
    return (
      <AuthLayout title={s.title} focusKey={state}>
        <p className="auth__body">{s.body}</p>
        <Button asChild className="auth__wide">
          <Link to="/approvals">Open approvals</Link>
        </Button>
      </AuthLayout>
    );
  }

  if (state === 'not_member') {
    return (
      <AuthLayout title="You no longer have access" focusKey={state}>
        <p className="auth__body">
          Your access to this business has ended, so you can't review its approvals. Ask the Owner
          if this is a mistake.
        </p>
        <Button asChild variant="secondary" className="auth__wide">
          <Link to="/">Go to KakiAgent</Link>
        </Button>
      </AuthLayout>
    );
  }

  if (state === 'wrong_account') return <WrongAccount onSignedOut={retry} />;

  if (state === 'sign_in') return <SignInToApprove token={token!} />;

  if (state === 'error' && !open.isPending) {
    return (
      <AuthLayout title="We couldn't open your link" focusKey={state}>
        <div className="alert alert--danger" role="alert">
          <p>Check your connection and try again.</p>
        </div>
        <Button className="auth__wide" onClick={retry}>
          Try again
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Opening your approval" busy focusKey="checking">
      <p className="auth__body">
        <Spinner /> Checking your link…
      </p>
    </AuthLayout>
  );
}

/** Signed in as another member: nothing was consumed, so switching keeps the link usable. */
function WrongAccount({ onSignedOut }: { onSignedOut: () => void }) {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const signOut = useMutation({
    mutationFn: api.signOut,
    onSuccess: () => {
      queryClient.clear();
      onSignedOut();
    },
  });
  return (
    <AuthLayout title="This link is for another team member" focusKey="wrong_account" focusOnMount>
      <p className="auth__body">
        {me.data ? (
          <>
            You're signed in as <strong>{me.data.user.email}</strong>.{' '}
          </>
        ) : null}
        Sign out, then sign in as the team member this was sent to.
      </p>
      {signOut.isError && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't sign you out. Check your connection and try again.</p>
        </div>
      )}
      <Button
        className="auth__wide"
        aria-busy={signOut.isPending || undefined}
        onClick={() => !signOut.isPending && signOut.mutate()}
      >
        {signOut.isPending && <Spinner />}
        Sign out and switch
      </Button>
      <Button asChild variant="secondary" className="auth__wide">
        <Link to="/approvals">Open my approvals</Link>
      </Button>
    </AuthLayout>
  );
}

/** Not signed in: the sign-in link carries the approval token back (D1). */
function SignInToApprove({ token }: { token: string }) {
  const options = useQuery({ queryKey: ['auth-options'], queryFn: api.authOptions });
  const [email, setEmail] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const send = useMutation({
    mutationFn: (address: string) => api.requestMagicLink(address, undefined, token),
  });

  const parse = () => MagicLinkRequest.safeParse({ email });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (send.isPending) return;
    const parsed = parse();
    if (!parsed.success) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    setInvalid(false);
    send.mutate(parsed.data.email);
  }

  if (send.isSuccess) {
    return (
      <AuthLayout title="Check your email" focusKey="sent">
        <p className="auth__body">
          We sent a sign-in link to <strong>{send.variables}</strong>. Open it on this phone and
          you'll go straight to the approval. It works once, for 15 minutes.
        </p>
        {send.data.delayed && (
          <div className="alert alert--info">
            <p className="alert__title">Your email may take a few minutes</p>
            <p>Our email service is slow right now. We'll keep trying until the link expires.</p>
          </div>
        )}
        <Button variant="secondary" className="auth__wide" onClick={() => send.reset()}>
          Use a different email
        </Button>
      </AuthLayout>
    );
  }

  const rateLimited = send.error instanceof ApiError && send.error.status === 429;
  return (
    <AuthLayout title="Sign in to review this approval" focusKey="sign_in" focusOnMount>
      <p className="auth__body">
        For your security, approval links only work for the signed-in team member they were sent to.
      </p>
      {rateLimited && (
        <div className="alert alert--warning" role="alert">
          <p className="alert__title">Too many sign-in links for now</p>
          <p>Wait a few minutes, then try again.</p>
        </div>
      )}
      {send.isError && !rateLimited && (
        <div className="alert alert--danger" role="alert">
          <p className="alert__title">We couldn't send your link</p>
          <p>Check your connection and try again.</p>
        </div>
      )}
      <form className="auth__form" onSubmit={submit} noValidate>
        <div className="field">
          <label className="field__label" htmlFor="email">
            Work email
          </label>
          <input
            ref={inputRef}
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            placeholder="e.g. you@yourbusiness.sg"
            value={email}
            readOnly={send.isPending}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? 'email-error' : undefined}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setInvalid(email.trim() !== '' && !parse().success)}
          />
          {invalid && (
            <p id="email-error" className="field__error">
              {EMAIL_ERROR}
            </p>
          )}
        </div>
        <Button type="submit" className="auth__wide" aria-busy={send.isPending || undefined}>
          {send.isPending && <Spinner />}
          Email me a sign-in link
        </Button>
      </form>
      {options.data?.google && (
        <>
          <p className="auth__divider">or</p>
          <Button variant="secondary" className="auth__wide" asChild>
            <a href="/api/v1/auth/google/start?next=approve">
              <GoogleMark />
              Continue with Google
            </a>
          </Button>
        </>
      )}
    </AuthLayout>
  );
}
