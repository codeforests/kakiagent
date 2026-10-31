import { DisplayName, type Account, type DeviceSession } from '@kaki/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, UnauthorizedError } from './api.ts';
import { useReauthGuard } from './reauth.ts';

/** My account: name, email change and devices, SCR-APP-055 (FEAT-008 §5.4, ui-design). */

export const ACCOUNT_KEY = ['account'];
export const SESSIONS_KEY = ['sessions'];

/** The field error for a name, or null when it can be saved (an empty one clears it). */
export function nameError(value: string): string | null {
  if (value.trim() === '') return null;
  return DisplayName.safeParse(value).success ? null : 'Use up to 60 letters, numbers and spaces.';
}

/** What a name field's value saves as: null clears the name. */
export const nameValue = (value: string) => (value.trim() === '' ? null : value.trim());

/** The change dialog's error, keyed on the API's codes (`apps/api/src/account.ts`). */
export type EmailErrorText = { text: string; field: boolean };

export function accountErrorText(err: unknown): EmailErrorText {
  const code = err instanceof ApiError ? err.code : null;
  switch (code) {
    case 'same_email':
      return { text: "That's already your email address.", field: true };
    case 'validation':
      return { text: 'Enter an email address like name@example.com.', field: true };
    case 'rate_limited':
      return { text: 'Too many changes. Try again in an hour.', field: false };
    default:
      return {
        text: "We couldn't send the link. Check your connection and try again.",
        field: false,
      };
  }
}

/** The `/verify-email` state a failed confirm lands in (ui-design "Confirm new email"). */
export type ConfirmFailure = 'expired' | 'used' | 'invalid' | 'taken' | 'error';

export function confirmFailure(err: unknown): ConfirmFailure {
  const code = err instanceof ApiError ? err.code : null;
  switch (code) {
    case 'link_expired':
      return 'expired';
    case 'link_used':
      return 'used';
    case 'link_invalid':
      return 'invalid';
    case 'email_taken':
      return 'taken';
    default:
      return 'error';
  }
}

/** Phones and tablets get the smartphone glyph, everything else the monitor (ui-design). */
export const deviceIcon = (device: string): 'smartphone' | 'monitor' =>
  /iPhone|iPad|Android/.test(device) ? 'smartphone' : 'monitor';

const time = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const day = (d: Date, now: Date) =>
  d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });

/** "now" under 2 minutes, "5 min ago" within the hour, "today 14:02", else "3 Nov". */
export function activeText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (minutes < 2) return 'now';
  if (minutes < 60) return `${minutes} min ago`;
  if (d.toDateString() === now.toDateString()) return `today ${time(d)}`;
  return day(d, now);
}

/** "Signed in 3 Nov with email link · Active 5 min ago". */
export function deviceDetail(s: DeviceSession, now = new Date()): string {
  const method = s.authMethod === 'google' ? 'Google' : 'email link';
  return `Signed in ${day(new Date(s.signedInAt), now)} with ${method} · Active ${activeText(s.lastActiveAt, now)}`;
}

/** "7 Nov 2:30 pm", a pending link's expiry. */
export function expiryText(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const t = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${date} ${t}`;
}

export function useAccount() {
  // Re-read on focus: a change confirmed in another tab shows here (ui-design).
  return useQuery({ queryKey: ACCOUNT_KEY, queryFn: api.account, refetchOnWindowFocus: true });
}

export function useSessions() {
  return useQuery({ queryKey: SESSIONS_KEY, queryFn: api.sessions });
}

/** The account changed: cache it and refresh `me`, which carries the name and email. */
function useAccountSaved() {
  const queryClient = useQueryClient();
  return (account: Account) => {
    queryClient.setQueryData(ACCOUNT_KEY, account);
    void queryClient.invalidateQueries({ queryKey: ['me'] });
    void queryClient.invalidateQueries({ queryKey: ['team'] });
  };
}

export function useUpdateProfile() {
  const saved = useAccountSaved();
  return useMutation({
    mutationFn: (displayName: string | null) => api.updateProfile(displayName),
    onSuccess: saved,
  });
}

/** Through the re-auth guard (D3): "Confirm it's you" may come first. */
export function useRequestEmailChange() {
  const { guard } = useReauthGuard();
  const saved = useAccountSaved();
  return useMutation({
    mutationFn: (email: string) => guard(() => api.requestEmailChange(email)),
    onSuccess: saved,
  });
}

export function useCancelEmailChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.cancelEmailChange,
    onSuccess: () =>
      queryClient.setQueryData<Account>(ACCOUNT_KEY, (old) =>
        old ? { ...old, pendingEmail: null } : old,
      ),
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  const drop = (id: string) =>
    queryClient.setQueryData<{ sessions: DeviceSession[] }>(SESSIONS_KEY, (old) =>
      old ? { sessions: old.sessions.filter((s) => s.id !== id) } : old,
    );
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        await api.revokeSession(id);
      } catch (err) {
        // Already ended elsewhere: the row goes quietly (ui-design).
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      }
    },
    onSuccess: (_, id) => drop(id),
  });
}

/**
 * Whether this browser is signed in, for `/verify-email`'s action. Asked without the
 * global error routing, which would send a signed-out visitor to sign-in.
 */
export function useSignedIn() {
  return useQuery({
    queryKey: ['verify-email-signed-in'],
    queryFn: () =>
      api.me().then(
        () => true,
        (err: unknown) => !(err instanceof UnauthorizedError && err.code !== 'mfa_required'),
      ),
    retry: false,
    gcTime: 0,
  });
}
