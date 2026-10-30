import type { Email } from '@kaki/platform';

/** Addresses are compared and stored trimmed and lower-cased. */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The sign-in email (design.md §6 voice), or the re-auth one (FEAT-006 §5.2). The link
 * opens the dashboard's verify page.
 */
export function magicLinkEmail(
  to: string,
  url: string,
  purpose: 'sign_in' | 'reauth' = 'sign_in',
): Email {
  const reauth = purpose === 'reauth';
  const lead = reauth
    ? 'Use this link to confirm it’s you in KakiAgent:'
    : 'Use this link to sign in to KakiAgent:';
  const action = reauth ? 'Confirm it’s you' : 'Sign in to KakiAgent';
  const tail = reauth
    ? 'Open it in the browser where you asked for it. It works once, for 15 minutes. If you didn’t ask, you can ignore this email.'
    : 'It works once, for 15 minutes. If you didn’t ask to sign in, you can ignore this email.';
  const text = [lead, '', url, '', tail].join('\n');
  const html = `<p>${lead}</p>
<p><a href="${escapeHtml(url)}">${action}</a></p>
<p>${tail}</p>`;
  const subject = reauth ? 'Confirm it’s you' : 'Your KakiAgent sign-in link';
  return { to, subject, text, html };
}
