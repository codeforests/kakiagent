import type { Me } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useSignOut } from '../lib/sign-out.ts';
import { AuthLayout, LegalLinks, Spinner } from './auth-layout.tsx';

type Field = 'name' | 'terms';
const MESSAGES: Record<Field, string> = {
  name: 'Enter your business name',
  terms: 'Agree to the terms to continue',
};

/**
 * SCR-APP-003 Create your workspace (FEAT-005 ui-design; UC-01 steps 4–6, AUTH-08). The
 * checkbox records acceptance of the three documents at the versions shown.
 */
export function WelcomePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const options = useQuery({ queryKey: ['auth-options'], queryFn: api.authOptions });
  const signOut = useSignOut();
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);

  const create = useMutation({
    mutationFn: () => {
      const v = Object.fromEntries((options.data?.terms ?? []).map((t) => [t.document, t.version]));
      return api.createWorkspace({
        businessName: name.trim(),
        accepted: { tos: v.tos ?? '', aup: v.aup ?? '', dpa: v.dpa ?? '' },
      });
    },
    onSuccess: async ({ tenant }) => {
      // The shell must see the new workspace before it renders, or it would send the
      // user straight back here.
      queryClient.setQueryData<Me>(['me'], (old) => old && { ...old, role: 'owner', tenant });
      await navigate('/setup', { replace: true });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'terms_outdated') {
        setAgreed(false);
        void options.refetch();
      }
    },
  });

  // Each submit with errors moves focus to the summary (design.md §4.2).
  useEffect(() => {
    if (attempts) summaryRef.current?.focus();
  }, [attempts]);

  if (me.data?.tenant && create.isIdle) return <Navigate to="/" replace />;

  const errors: Partial<Record<Field, string>> = {};
  if (!name.trim()) errors.name = MESSAGES.name;
  if (!agreed) errors.terms = MESSAGES.terms;
  const errorList = Object.entries(errors) as [Field, string][];
  const shown = (f: Field) => submitted && errors[f] !== undefined;

  const termsUpdated = create.error instanceof ApiError && create.error.code === 'terms_outdated';
  const failed = create.isError && !termsUpdated;
  const busy = create.isPending;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setSubmitted(true);
    if (errorList.length || !options.data) {
      setAttempts((n) => n + 1);
      return;
    }
    create.mutate();
  }

  const versions = options.data?.terms.map((t) => t.version).join(' · ');

  return (
    <AuthLayout title="Create your workspace">
      {me.data && <p className="auth__note">Signed in as {me.data.user.email}.</p>}
      {submitted && errorList.length > 0 && (
        <div className="alert alert--danger" role="alert" tabIndex={-1} ref={summaryRef}>
          <p className="alert__title">Check these fields</p>
          <ul>
            {errorList.map(([f, msg]) => (
              <li key={f}>
                <a href={`#workspace-${f}`}>{msg}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {termsUpdated && (
        <div className="alert alert--warning" role="alert">
          <p className="alert__title">The terms were just updated</p>
          <p>Review the new versions, then agree again.</p>
        </div>
      )}
      {failed && (
        <div className="alert alert--danger" role="alert">
          <p className="alert__title">We couldn't create your workspace</p>
          <p>Nothing was saved. Try again.</p>
        </div>
      )}
      <form className="auth__form" onSubmit={submit} noValidate>
        <div className="field">
          <label className="field__label" htmlFor="workspace-name">
            Business name (required)
          </label>
          <input
            id="workspace-name"
            className="input"
            autoComplete="organization"
            placeholder="e.g. Kaki Bakery"
            maxLength={120}
            value={name}
            readOnly={busy}
            aria-invalid={shown('name') || undefined}
            aria-describedby={shown('name') ? 'workspace-name-error' : 'workspace-name-help'}
            onChange={(e) => setName(e.target.value)}
          />
          {shown('name') ? (
            <p id="workspace-name-error" className="field__error">
              {errors.name}
            </p>
          ) : (
            <p id="workspace-name-help" className="field__help">
              Your customers see this name in the chat.
            </p>
          )}
        </div>
        <div className="field">
          <label className="radio checkbox">
            <input
              id="workspace-terms"
              type="checkbox"
              checked={agreed}
              disabled={busy}
              aria-invalid={shown('terms') || undefined}
              aria-describedby={shown('terms') ? 'workspace-terms-error' : undefined}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span>
              I agree to the <LegalLinks newTab />
            </span>
          </label>
          {versions && <p className="field__help">Versions {versions}</p>}
          {shown('terms') && (
            <p id="workspace-terms-error" className="field__error">
              {errors.terms}
            </p>
          )}
        </div>
        <Button type="submit" className="auth__wide" aria-busy={busy || undefined}>
          {busy && <Spinner />}
          Create workspace
        </Button>
      </form>
      <Button variant="ghost" type="button" onClick={() => signOut.mutate()}>
        Sign out
      </Button>
    </AuthLayout>
  );
}
