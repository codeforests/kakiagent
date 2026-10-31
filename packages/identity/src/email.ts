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

const ROLE_NAMES = { admin: 'an Admin', agent: 'an Agent' } as const;

/** The invitation email (FEAT-007 §5.1, design.md §6 voice). The link opens SCR-APP-004. */
export function inviteEmail(
  to: string,
  v: { tenantName: string; inviter: string; role: 'admin' | 'agent'; url: string; expiresAt: Date },
): Email {
  const until = v.expiresAt.toLocaleDateString('en-SG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Singapore',
  });
  const lead = `${v.inviter} invited you to join ${v.tenantName} on KakiAgent as ${ROLE_NAMES[v.role]}.`;
  const tail = `The link works once, until ${until}. Sign in with ${to} to join. If you weren’t expecting this, you can ignore this email.`;
  const text = [lead, '', v.url, '', tail].join('\n');
  const html = `<p>${escapeHtml(lead)}</p>
<p><a href="${escapeHtml(v.url)}">Join ${escapeHtml(v.tenantName)}</a></p>
<p>${escapeHtml(tail)}</p>`;
  return { to, subject: `Join ${v.tenantName} on KakiAgent`, text, html };
}
