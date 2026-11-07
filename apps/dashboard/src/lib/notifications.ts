import type { AlertEvent, NotificationPrefs, NotificationPrefsBody } from '@kaki/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';

/** My notifications, SCR-APP-056 (FEAT-052 §5.5, ui-design). */

export const NOTIFICATIONS_KEY = ['notification-prefs'];

/** Each event's row text (ui-design "Alerts card"). */
export const EVENT_TEXT: Record<AlertEvent, { label: string; help: string }> = {
  escalation: {
    label: 'A customer asks for a person',
    help: 'When the assistant hands a chat to your team.',
  },
  approval_pending: {
    label: 'A reply needs approval',
    help: 'Quotes, discounts or promises waiting for you to approve.',
  },
  hot_lead: { label: 'New hot lead', help: 'When a customer looks ready to buy.' },
  consent_withdrawn: {
    label: 'Consent withdrawn',
    help: 'When a customer asks you to stop using their details.',
  },
};

type Times = { start: string; end: string };

/** A window that crosses midnight, such as 22:00 to 08:00. */
export const overnight = (q: Times) => q.start > q.end;

/** "22:00 to 08:00, Singapore time". */
export const quietSummary = (q: Times) => `${q.start} to ${q.end}, Singapore time`;

const HOLD_HELP =
  'Alerts that arrive in this window come as one email when it ends. Urgent alerts, like a customer asking for a person or an approval about to miss its deadline, still come straight away.';

/** The help under the quiet-hours fields, or the line shown when quiet hours are off. */
export function quietHelp(q: Times & { enabled: boolean }): string {
  if (!q.enabled) return 'Every alert is emailed as it happens.';
  const lead = overnight(q) ? `Overnight, ${q.start} to ${q.end}. ` : '';
  return `${lead}Singapore time. ${HOLD_HELP}`;
}

export type QuietError = { field: 'start' | 'end'; text: string };

/** The first field error for the times, or null when they can be saved. */
export function quietError(q: Times): QuietError | null {
  if (!q.start) return { field: 'start', text: 'Enter a time.' };
  if (!q.end) return { field: 'end', text: 'Enter a time.' };
  if (q.start === q.end) return { field: 'end', text: 'Pick a different end time.' };
  return null;
}

/** A 422 `invalid_preferences` mapped to the same field errors; null for any other failure. */
export function quietServerError(err: unknown): QuietError | null {
  if (!(err instanceof ApiError) || err.code !== 'invalid_preferences') return null;
  const fields = (err.details.fields ?? {}) as Record<string, string>;
  if (fields['quietHours.end'] === 'same_time')
    return { field: 'end', text: 'Pick a different end time.' };
  if (fields['quietHours.start']) return { field: 'start', text: 'Enter a time.' };
  if (fields['quietHours.end']) return { field: 'end', text: 'Enter a time.' };
  return null;
}

export type TestErrorText = { tone: 'warning' | 'danger'; text: string };

/** The test card's alert after a failed send. */
export function testErrorText(err: unknown): TestErrorText {
  if (err instanceof ApiError && err.code === 'rate_limited') {
    const n =
      typeof err.details.retryAfterSeconds === 'number' ? err.details.retryAfterSeconds : 60;
    return { tone: 'warning', text: `You just sent one. Try again in ${n} seconds.` };
  }
  return { tone: 'danger', text: "We couldn't send a test alert. Try again." };
}

/** One change from the page: an event's email switch, or the quiet hours. */
export type PrefsChange =
  { event: AlertEvent; email: boolean } | { quietHours: NotificationPrefs['quietHours'] };

/** The preferences with a change applied. */
export function applyChange(prefs: NotificationPrefs, change: PrefsChange): NotificationPrefs {
  if ('quietHours' in change) return { ...prefs, quietHours: change.quietHours };
  return {
    ...prefs,
    events: prefs.events.map((e) => (e.event === change.event ? { ...e, email: change.email } : e)),
  };
}

/** The change that undoes `change` on `prefs` (taken before applying it). */
export function undoOf(prefs: NotificationPrefs, change: PrefsChange): PrefsChange {
  if ('quietHours' in change) return { quietHours: prefs.quietHours };
  const was = prefs.events.find((e) => e.event === change.event)?.email ?? !change.email;
  return { event: change.event, email: was };
}

/** The PUT body: the whole page, so the server and the cache agree. */
export const bodyOf = (prefs: NotificationPrefs): NotificationPrefsBody => ({
  events: prefs.events,
  quietHours: prefs.quietHours,
});

export function useNotificationPrefs() {
  return useQuery({ queryKey: NOTIFICATIONS_KEY, queryFn: api.getNotificationPrefs });
}

/**
 * Saves one change optimistically (design.md `toggle`: applies on change). A failure undoes
 * only that change in the cache, so a second switch saved meanwhile keeps its position.
 */
export function useSaveNotificationPrefs() {
  const queryClient = useQueryClient();
  const current = () => queryClient.getQueryData<NotificationPrefs>(NOTIFICATIONS_KEY);
  // The body is the cache after `onMutate` applied the change, so the change isn't needed here.
  return useMutation<NotificationPrefs, Error, PrefsChange, { undo: PrefsChange | null }>({
    mutationKey: NOTIFICATIONS_KEY,
    mutationFn: async () => {
      const prefs = current();
      if (!prefs) throw new Error('preferences not loaded');
      return api.putNotificationPrefs(bodyOf(prefs));
    },
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      const prefs = current();
      if (!prefs) return { undo: null };
      queryClient.setQueryData(NOTIFICATIONS_KEY, applyChange(prefs, change));
      return { undo: undoOf(prefs, change) };
    },
    onError: (_err, _change, ctx) => {
      const prefs = current();
      if (prefs && ctx?.undo)
        queryClient.setQueryData(NOTIFICATIONS_KEY, applyChange(prefs, ctx.undo));
    },
    onSuccess: (saved) => {
      // Another save still in flight already moved the cache on; its own answer lands next.
      if (queryClient.isMutating({ mutationKey: NOTIFICATIONS_KEY }) <= 1)
        queryClient.setQueryData(NOTIFICATIONS_KEY, saved);
    },
  });
}

export function useSendTestAlert() {
  return useMutation({ mutationFn: api.sendTestAlert });
}
