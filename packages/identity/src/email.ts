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

/** `mei@example.com` → `m***@example.com`: enough to recognise, not to read (FEAT-008 §5.1). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** To the new address (AUTH-05): the link that makes it the sign-in email. */
export function emailChangeConfirmEmail(to: string, url: string): Email {
  const lead = 'Use this link to make this your KakiAgent sign-in email:';
  const tail =
    'Until you open it, you keep signing in with your current email. It works once, for 24 hours. If you didn’t ask for this, you can ignore this email.';
  const text = [lead, '', url, '', tail].join('\n');
  const html = `<p>${lead}</p>
<p><a href="${escapeHtml(url)}">Confirm your new email</a></p>
<p>${tail}</p>`;
  return { to, subject: 'Confirm your new KakiAgent email', text, html };
}

/** To a new address that already has an account (D5): no link, nothing merged. */
export function emailInUseEmail(to: string): Email {
  const lead =
    'Someone asked to move a KakiAgent account to this email, but this email already has its own KakiAgent account, so nothing was changed.';
  const tail =
    'If it was you, sign in with this email instead, or choose another address. If you didn’t ask, you can ignore this email.';
  const text = [lead, '', tail].join('\n');
  const html = `<p>${lead}</p>
<p>${tail}</p>`;
  return { to, subject: 'This email already has a KakiAgent account', text, html };
}

/** To the current address (AUTH-05 "the old email receives a notice of the change"). */
export function emailChangeNoticeEmail(to: string, newEmail: string): Email {
  const masked = maskEmail(newEmail);
  const lead = `Someone asked to change your KakiAgent sign-in email to ${masked}.`;
  const mid = 'It changes only if the link sent to that address is opened.';
  const tail =
    'If this wasn’t you, sign in, cancel the change on My account and sign out of all devices.';
  const text = [lead, '', mid, '', tail].join('\n');
  const html = `<p>${escapeHtml(lead)}</p>
<p>${mid}</p>
<p>${tail}</p>`;
  return { to, subject: 'Your KakiAgent sign-in email is changing', text, html };
}
