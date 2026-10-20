import type { Email } from '@kaki/platform';

/** Addresses are compared and stored trimmed and lower-cased. */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The sign-in email (design.md §6 voice). The link opens the dashboard's verify page. */
export function magicLinkEmail(to: string, url: string): Email {
  const text = [
    'Use this link to sign in to KakiAgent:',
    '',
    url,
    '',
    'It works once, for 15 minutes. If you didn’t ask to sign in, you can ignore this email.',
  ].join('\n');
  const html = `<p>Use this link to sign in to KakiAgent:</p>
<p><a href="${escapeHtml(url)}">Sign in to KakiAgent</a></p>
<p>It works once, for 15 minutes. If you didn’t ask to sign in, you can ignore this email.</p>`;
  return { to, subject: 'Your KakiAgent sign-in link', text, html };
}
