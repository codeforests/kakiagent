import type { ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * The shared layout of the screens outside the shell (FEAT-005 ui-design): the
 * centred `.auth` card with the wordmark above the heading.
 */
export function AuthLayout({
  title,
  busy,
  children,
}: {
  title: string;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <main id="main" className="auth">
      <div className="auth__card" aria-busy={busy || undefined}>
        <p className="auth__brand">KakiAgent</p>
        <h1 className="page-title">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** design.md §4 `spinner`: a ring in currentColor, shown only after 300 ms. */
export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

/** The Google "G", in currentColor: the secondary button carries no brand colours. */
export function GoogleMark() {
  return (
    <svg className="kaki-btn__icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"
      />
    </svg>
  );
}

const LEGAL = [
  { document: 'tos', title: 'Terms of Service' },
  { document: 'aup', title: 'Acceptable Use Policy' },
  { document: 'dpa', title: 'Data Processing Agreement' },
] as const;

/** "Terms of Service, Acceptable Use Policy and Data Processing Agreement", each a link. */
export function LegalLinks({ newTab = false }: { newTab?: boolean }) {
  const target = newTab ? { target: '_blank', rel: 'noopener' } : {};
  return (
    <>
      {LEGAL.map((d, i) => (
        <span key={d.document}>
          {i === 1 ? ', ' : i === 2 ? ' and ' : ''}
          <Link to={`/legal/${d.document}`} {...target}>
            {d.title}
          </Link>
        </span>
      ))}
    </>
  );
}
