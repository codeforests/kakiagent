import { Button } from '@kaki/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';

async function devSignIn(tenant: 'kaki-bakery' | 'second-tenant') {
  const res = await fetch('/api/dev/sign-in', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
}

/**
 * DEV-ONLY sign-in (plan §2). Signs in as the seeded owner of a dev tenant. The api
 * refuses it unless KAKI_DEV_AUTH=true in a non-production build, and the
 * dashboard's production build leaves this module out (router.tsx). FEAT-005 replaces
 * this page with SCR-APP-001 (magic link and Google).
 */
export function DevSignInPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);

  async function signIn(tenant: 'kaki-bakery' | 'second-tenant') {
    setError(false);
    try {
      await devSignIn(tenant);
      queryClient.clear();
      navigate('/inbox');
    } catch {
      setError(true);
    }
  }

  return (
    <main id="main" className="auth">
      <div className="auth__card">
        <h1 className="page-title">Sign in to KakiAgent</h1>
        <p className="auth__note">Development sign-in. Real sign-in arrives with FEAT-005.</p>
        <Button onClick={() => void signIn('kaki-bakery')}>Sign in as the Kaki Bakery owner</Button>
        <Button variant="secondary" onClick={() => void signIn('second-tenant')}>
          Sign in as the second tenant's owner
        </Button>
        {error && (
          <p role="alert" className="auth__error">
            Sign-in failed. Is the api running with KAKI_DEV_AUTH=true?
          </p>
        )}
      </div>
    </main>
  );
}
