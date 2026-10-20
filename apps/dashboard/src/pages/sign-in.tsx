import { MagicLinkRequest } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { AuthLayout, GoogleMark, LegalLinks, Spinner } from './auth-layout.tsx';

const EMAIL_ERROR = 'Enter an email address, like you@yourbusiness.sg';

/**
 * SCR-APP-001 Sign in, and SCR-APP-002's "sent" state (FEAT-005 ui-design). One screen
 * for sign-up and sign-in: the answer is the same whether or not the address has an
 * account (AUTH-01).
 */
export function SignInPage() {
  const [params] = useSearchParams();
  const options = useQuery({ queryKey: ['auth-options'], queryFn: api.authOptions });
  const [email, setEmail] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const send = useMutation({ mutationFn: (address: string) => api.requestMagicLink(address) });

  useEffect(() => inputRef.current?.focus(), []);

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
      <AuthLayout title="Check your email">
        <p className="auth__body">
          We sent a sign-in link to <strong>{send.variables}</strong>. It works once, for 15
          minutes.
        </p>
        {send.data.delayed && (
          <div className="alert alert--info" role="status">
            <p className="alert__title">Your email may take a few minutes</p>
            <p>Our email service is slow right now. We'll keep trying until the link expires.</p>
          </div>
        )}
        <Button variant="ghost" type="button" onClick={() => send.reset()}>
          Use a different email
        </Button>
        <p className="auth__caption">
          No email? Check your spam folder, or send a new link in a minute.
        </p>
      </AuthLayout>
    );
  }

  const rateLimited = send.error instanceof ApiError && send.error.status === 429;
  const failed = send.isError && !rateLimited;

  return (
    <AuthLayout title="Sign in to KakiAgent">
      <p className="auth__note">New here? Enter your email and we'll set up your account.</p>
      {params.get('error') === 'google' && !send.isPending && !send.isError && (
        <div className="alert alert--danger" role="alert">
          <p className="alert__title">Google sign-in didn't work</p>
          <p>Try again, or use a sign-in link instead.</p>
        </div>
      )}
      {rateLimited && (
        <div className="alert alert--warning" role="alert">
          <p className="alert__title">Too many sign-in links for now</p>
          <p>
            Wait a few minutes, then try again. The links we already sent still work for 15 minutes.
          </p>
        </div>
      )}
      {failed && (
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
            <a href="/api/v1/auth/google/start">
              <GoogleMark />
              Continue with Google
            </a>
          </Button>
        </>
      )}
      <p className="auth__caption">
        Read our <LegalLinks />.
      </p>
    </AuthLayout>
  );
}
