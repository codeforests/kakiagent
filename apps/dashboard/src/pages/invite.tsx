import type { InvitationLookup } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { withArticle } from '../lib/team.ts';
import { AuthLayout, GoogleMark, Spinner } from './auth-layout.tsx';

/** Survives the Google redirect and a two-step detour in this tab only (design D4). */
const TOKEN_KEY = 'kaki-invite-token';
const AUTO_KEY = 'kaki-invite-auto';

const store = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* private mode: the page still works, only the Google return can't auto-join */
    }
  },
  clear: () => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(AUTO_KEY);
    } catch {
      /* nothing stored */
    }
  },
};

/** Reads `#token=` once and drops it from the address bar; else the stored one. */
function takeToken(): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromHash) {
    history.replaceState(history.state, '', location.pathname + location.search);
    store.set(TOKEN_KEY, fromHash);
    return fromHash;
  }
  return store.get(TOKEN_KEY);
}

type Ended = 'expired' | 'used' | 'invalid';
const ENDED_BY_CODE: Record<string, Ended> = {
  link_expired: 'expired',
  link_used: 'used',
  link_invalid: 'invalid',
};

/**
 * SCR-APP-004 Accept invitation (FEAT-007 ui-design): the link proves where the invitation
 * went, signing in proves who opened it (D2). The token travels only in request bodies.
 */
export function InvitePage() {
  const [token] = useState(takeToken);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const lookup = useQuery({
    queryKey: ['invite-lookup'],
    queryFn: () => api.lookupInvite(token!),
    enabled: token !== null,
    retry: false,
    gcTime: 0,
  });
  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token!),
    onSuccess: (me) => {
      store.clear();
      // Everything cached belonged to the old session. Keep the lookup, or this page,
      // still mounted for a moment, would ask for it again.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'invite-lookup' });
      queryClient.setQueryData(['me'], me);
      void navigate('/', {
        replace: true,
        state: { toast: `Welcome to ${me.tenant?.name ?? lookup.data?.tenantName}.` },
      });
    },
  });
  const sendLink = useMutation({
    mutationFn: (inv: InvitationLookup) => api.requestMagicLink(inv.email, token!),
  });
  const signOut = useMutation({
    mutationFn: api.signOut,
    onSuccess: () => {
      store.clear();
      store.set(TOKEN_KEY, token!);
      void lookup.refetch();
    },
  });

  const inv = lookup.data;
  const matches = inv?.state === 'valid' && inv.signedInAs === inv.email;

  // Back from Google (or a two-step detour) as the invited address: join without a click.
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || !matches || store.get(AUTO_KEY) !== '1') return;
    autoTried.current = true;
    store.set(AUTO_KEY, '0');
    accept.mutate();
  }, [matches, accept]);

  const acceptCode = accept.error instanceof ApiError ? accept.error.code : null;
  const lookupCode = lookup.error instanceof ApiError ? lookup.error.code : null;

  const view: View =
    token === null || lookupCode === 'link_invalid'
      ? { kind: 'invalid' }
      : lookup.isError ||
          (accept.isError &&
            !acceptCode?.startsWith('link_') &&
            acceptCode !== 'invite_wrong_email')
        ? { kind: 'error' }
        : !inv
          ? { kind: 'loading' }
          : acceptCode && ENDED_BY_CODE[acceptCode]
            ? { kind: ENDED_BY_CODE[acceptCode]!, inv }
            : inv.state === 'revoked'
              ? { kind: 'invalid' }
              : inv.state !== 'valid'
                ? { kind: inv.state, inv }
                : accept.isPending || accept.isSuccess
                  ? { kind: 'joining', inv }
                  : acceptCode === 'invite_wrong_email' || (inv.signedInAs && !matches)
                    ? { kind: 'wrong', inv }
                    : matches
                      ? { kind: 'join', inv }
                      : sendLink.isSuccess
                        ? { kind: 'sent', inv }
                        : { kind: 'signin', inv };

  useEffect(() => {
    if (view.kind === 'expired' || view.kind === 'used' || view.kind === 'invalid') store.clear();
  }, [view.kind]);

  const title =
    view.kind === 'join' || view.kind === 'signin' || view.kind === 'sent'
      ? `Join ${view.inv.tenantName} · KakiAgent`
      : 'Invitation · KakiAgent';
  useEffect(() => {
    document.title = title;
  }, [title]);

  const signedIn = Boolean(inv?.signedInAs);
  const home = signedIn ? (
    <Button variant="ghost" asChild>
      <Link to="/">Go to my dashboard</Link>
    </Button>
  ) : (
    <Button variant="ghost" asChild>
      <Link to="/sign-in">Go to sign in</Link>
    </Button>
  );

  switch (view.kind) {
    case 'loading':
      return (
        <AuthLayout title="Invitation" busy focusKey="loading">
          <div className="skeleton-line" />
          <div className="skeleton-line" />
        </AuthLayout>
      );
    case 'error':
      return (
        <AuthLayout title="Invitation" focusKey="error">
          <div className="alert alert--danger" role="alert">
            <p>Something went wrong. Try again.</p>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              accept.reset();
              void lookup.refetch();
            }}
          >
            Try again
          </Button>
        </AuthLayout>
      );
    case 'invalid':
      return (
        <AuthLayout title="This invitation isn't valid" focusKey="invalid">
          <p className="auth__body">
            It may have been withdrawn or replaced by a newer one. Ask the person who invited you to
            send it again.
          </p>
          {home}
        </AuthLayout>
      );
    case 'expired':
      return (
        <AuthLayout title="This invitation has expired" focusKey="expired">
          <p className="auth__body">
            Invitations last 7 days. Ask {view.inv.invitedBy} to send a new one.
          </p>
          {home}
        </AuthLayout>
      );
    case 'used':
      return (
        <AuthLayout title="This invitation has already been used" focusKey="used">
          <p className="auth__body">
            If you joined already, sign in to open {view.inv.tenantName}.
          </p>
          <Button asChild>
            <Link to={signedIn ? '/' : '/sign-in'}>
              {signedIn ? 'Go to my dashboard' : 'Sign in'}
            </Link>
          </Button>
        </AuthLayout>
      );
    case 'wrong':
      return (
        <AuthLayout title={`Join ${view.inv.tenantName}`} focusKey="wrong">
          <div className="alert alert--warning" role="alert">
            <p className="alert__title">This invitation is for {view.inv.email}</p>
            <p>
              You're signed in as {view.inv.signedInAs ?? 'someone else'}. Sign out, then sign in as{' '}
              {view.inv.email} to join.
            </p>
          </div>
          <Button
            className="auth__wide"
            onClick={() => {
              accept.reset();
              signOut.mutate();
            }}
            disabled={signOut.isPending}
            aria-busy={signOut.isPending || undefined}
          >
            {signOut.isPending && <Spinner />}
            Sign out and continue
          </Button>
          {signedIn && home}
        </AuthLayout>
      );
    case 'join':
    case 'joining':
      return (
        <AuthLayout title={`Join ${view.inv.tenantName}`} focusKey="join">
          <Invited inv={view.inv} />
          <Button
            className="auth__wide"
            onClick={() => accept.mutate()}
            disabled={view.kind === 'joining'}
            aria-busy={view.kind === 'joining' || undefined}
          >
            {view.kind === 'joining' && <Spinner />}
            {view.kind === 'joining' ? 'Joining…' : `Join ${view.inv.tenantName}`}
          </Button>
        </AuthLayout>
      );
    case 'sent':
      return (
        <AuthLayout title={`Join ${view.inv.tenantName}`} focusKey="sent">
          <p className="auth__body" role="status">
            Check your inbox. The link signs you in and joins {view.inv.tenantName}.
          </p>
          <Button
            variant="ghost"
            onClick={() => sendLink.mutate(view.inv)}
            disabled={sendLink.isPending}
          >
            Send again
          </Button>
        </AuthLayout>
      );
    case 'signin':
      return <SignInToJoin inv={view.inv} sendLink={sendLink} />;
  }
}

type View =
  | { kind: 'loading' | 'error' | 'invalid' }
  | {
      kind: 'expired' | 'used' | 'wrong' | 'join' | 'joining' | 'sent' | 'signin';
      inv: InvitationLookup;
    };

function Invited({ inv }: { inv: InvitationLookup }) {
  return (
    <p className="auth__body">
      {inv.invitedBy} invited you to join as {withArticle(inv.role)}.
    </p>
  );
}

function SignInToJoin({
  inv,
  sendLink,
}: {
  inv: InvitationLookup;
  sendLink: { mutate: (inv: InvitationLookup) => void; isPending: boolean; isError: boolean };
}) {
  const options = useQuery({ queryKey: ['auth-options'], queryFn: api.authOptions });
  return (
    <AuthLayout title={`Join ${inv.tenantName}`} focusKey="signin">
      <Invited inv={inv} />
      <p className="auth__body">
        Sign in as <strong>{inv.email}</strong> to join.
      </p>
      {sendLink.isError && (
        <div className="alert alert--danger" role="alert">
          <p>Something went wrong. Try again.</p>
        </div>
      )}
      <Button
        className="auth__wide"
        onClick={() => sendLink.mutate(inv)}
        disabled={sendLink.isPending}
        aria-busy={sendLink.isPending || undefined}
      >
        {sendLink.isPending && <Spinner />}
        Email me a sign-in link
      </Button>
      {options.data?.google && (
        <>
          <p className="auth__divider">or</p>
          <Button
            variant="secondary"
            className="auth__wide"
            onClick={() => {
              store.set(AUTO_KEY, '1');
              location.assign('/api/v1/auth/google/start?next=invite');
            }}
          >
            <GoogleMark />
            Continue with Google
          </Button>
        </>
      )}
    </AuthLayout>
  );
}
