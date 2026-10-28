import type { AiStatus, AiStatusResponse, Role } from '@kaki/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';

/** Helpers for the AI status pill, SCR-APP-058 and the "AI paused" banner (FEAT-057 ui-design). */

export const AI_STATUS_KEY = ['ai-status'];
const REFETCH_MS = 30_000;

/** The kill-switch status, refetched every 30 s, on focus and on the Inbox's `ai_status` event. */
export function useAiStatus({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: AI_STATUS_KEY,
    queryFn: () => api.aiStatus(),
    enabled,
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: true,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
}

/** Pause or resume; the cache changes only from the server's answer (never optimistic, design.md §4.10). */
export function useSetAiPaused() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => (paused ? api.pauseAi() : api.resumeAi()),
    onSuccess: (res) => queryClient.setQueryData<AiStatusResponse>(AI_STATUS_KEY, res),
  });
}

/** `killswitch.toggle`: Owners and Admins pause and resume. */
export const canToggle = (role: Role | null | undefined) => role === 'owner' || role === 'admin';

export type PillState = 'live' | 'paused' | 'not_live';

/** D8: paused always wins; otherwise live when at least one channel is live. */
export function pillState(status: AiStatus): PillState {
  if (status.paused) return 'paused';
  return status.liveChannels > 0 ? 'live' : 'not_live';
}

export const PILL_TEXT: Record<PillState, { long: string; short: string }> = {
  live: { long: 'AI live', short: 'Live' },
  paused: { long: 'AI paused', short: 'Paused' },
  not_live: { long: 'Not live', short: 'Not live' },
};

const PART = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Singapore',
});

/** "Paused since 2:05 pm, 27 Oct" (SGT, ui-design SCR-APP-058); null while not paused. */
export function pausedSince(status: AiStatus): string | null {
  if (!status.paused || !status.pausedAt) return null;
  const p = Object.fromEntries(
    PART.formatToParts(new Date(status.pausedAt)).map((x) => [x.type, x.value]),
  );
  return `Paused since ${p.hour}:${p.minute} ${String(p.dayPeriod).toLowerCase()}, ${p.day} ${p.month}`;
}
