import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';

/** Helpers for two-step verification: SCR-APP-005, My account and Team (FEAT-006 ui-design). */

export const MFA_KEY = ['mfa'];
export const TEAM_MFA_KEY = ['team-mfa'];

/** The user's two-step state; works while the session still owes a code. */
export function useMfaStatus({ refetchOnWindowFocus = false } = {}) {
  return useQuery({ queryKey: MFA_KEY, queryFn: api.mfaStatus, refetchOnWindowFocus });
}

/** The workspace's requirement and its member counts (SCR-APP-045 p). */
export function useTeamMfa() {
  return useQuery({ queryKey: TEAM_MFA_KEY, queryFn: api.teamMfa });
}

/** What the user typed, without spaces and hyphens ("123 456", "ABCDE-FGHIJ"). */
export const normaliseCode = (code: string) => code.replace(/[\s-]/g, '').toLowerCase();

export const isTotpCode = (code: string) => /^\d{6}$/.test(normaliseCode(code));

/** `xxxxx-xxxxx`, as the codes were shown at enrolment. */
export function formatRecoveryCode(code: string) {
  const c = normaliseCode(code);
  return c.length === 10 ? `${c.slice(0, 5)}-${c.slice(5)}` : c;
}

/** The manual key in groups of four, for typing into the app. */
export const formatKey = (secret: string) => secret.replace(/(.{4})(?=.)/g, '$1 ');

/** The text of `kakiagent-recovery-codes.txt`. */
export function recoveryCodesFile(codes: string[], email: string, appName = 'KakiAgent') {
  return [
    `${appName} recovery codes for ${email}`,
    '',
    'Each code signs you in once if you lose your authenticator app.',
    'Keep them somewhere safe, like a password manager.',
    '',
    ...codes.map(formatRecoveryCode),
    '',
  ].join('\n');
}

/** Saves the codes as a text file. */
export function downloadRecoveryCodes(codes: string[], email: string) {
  const url = URL.createObjectURL(
    new Blob([recoveryCodesFile(codes, email)], { type: 'text/plain' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kakiagent-recovery-codes.txt';
  a.click();
  URL.revokeObjectURL(url);
}

/** `attemptsLeft` of a 400 `code_invalid` on a TOTP challenge or re-auth. */
export function attemptsLeft(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.code !== 'code_invalid') return null;
  const n = err.details.attemptsLeft;
  return typeof n === 'number' ? n : null;
}

/** `until` of a 429 `mfa_locked`, or null. */
export function lockedUntil(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== 'mfa_locked') return null;
  const until = err.details.until;
  return typeof until === 'string' ? until : null;
}

const SGT = { timeZone: 'Asia/Singapore' } as const;
const CLOCK = new Intl.DateTimeFormat('en-SG', {
  ...SGT,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const DAY = new Intl.DateTimeFormat('en-SG', {
  ...SGT,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const parts = (f: Intl.DateTimeFormat, iso: string) =>
  Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));

/** "2:05 pm" (SGT). */
export function clockTime(iso: string) {
  const p = parts(CLOCK, iso);
  return `${p.hour}:${p.minute} ${String(p.dayPeriod).toLowerCase()}`;
}

/** "28 Oct 2026" (SGT). */
export function dayDate(iso: string) {
  const p = parts(DAY, iso);
  return `${p.day} ${p.month} ${p.year}`;
}

/** `?next=` only when it is a same-origin path; otherwise the inbox. */
export function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : '/inbox';
}
