import { Button, EmptyState } from '@kaki/ui';
import { Link } from 'react-router';

/** SCR-APP-059 system pages: not found, no permission, offline, tenant suspended, session expired. */

export function NotFound() {
  return (
    <EmptyState
      title="We can't find that page"
      action={
        <Button asChild>
          <Link to="/">Go to Home</Link>
        </Button>
      }
    >
      The link may be old, or the page may have moved.
    </EmptyState>
  );
}

export function NoPermission() {
  return (
    <EmptyState title="You don't have access to this page">
      Ask your account owner if you need it.
    </EmptyState>
  );
}

export function Offline() {
  return (
    <EmptyState title="You're offline">
      We'll reconnect as soon as your connection is back.
    </EmptyState>
  );
}

export function TenantSuspended() {
  return (
    <main id="main" className="auth">
      <EmptyState title="This account is suspended">
        Contact KakiAgent support to restore access.
      </EmptyState>
    </main>
  );
}

export function SessionExpired() {
  return (
    <main id="main" className="auth">
      <EmptyState
        title="Your session has ended"
        action={
          <Button asChild>
            <Link to="/sign-in">Sign in again</Link>
          </Button>
        }
      >
        For your security, please sign in again.
      </EmptyState>
    </main>
  );
}
