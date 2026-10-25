import { WidgetAppearanceBody, type WidgetSettings } from '@kaki/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { api, ApiError } from './api.ts';
import { useToast } from './form.ts';
import { draftOf, hostOf, pollInterval, sameDraft, type AppearanceDraft } from './widget.ts';
import type { Scheme } from '@kaki/channels/theme';

export const WIDGET_KEY = ['widget'] as const;

/** Writes a mutation's settings answer into the cache. */
export function useSetWidget() {
  const queryClient = useQueryClient();
  return (s: WidgetSettings) => queryClient.setQueryData(WIDGET_KEY, s);
}

/** Adds an allowed origin (OriginsList, and InstallCheck's "Add {host}"). */
export function useAddOrigin() {
  const setWidget = useSetWidget();
  return useMutation({
    mutationFn: (origin: string) => api.addWidgetOrigin(origin),
    onSuccess: setWidget,
  });
}

/**
 * The state both widget screens share (SCR-APP-037, SCR-APP-011): the settings, polled while
 * the install check or a detection is moving (D8); the unsaved appearance draft and the
 * preview scheme; save and detect; the unsaved-changes guard; the "now installed" toast.
 */
export function useWidgetEditor() {
  const setWidget = useSetWidget();
  const [toast, setToast] = useToast();
  const loaded = useQuery({
    queryKey: WIDGET_KEY,
    queryFn: () => api.widget(),
    refetchInterval: (q) => pollInterval(q.state.data),
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
  const assistantQ = useQuery({
    queryKey: ['assistant-settings'],
    queryFn: () => api.assistantSettings(),
    retry: false,
  });
  const data = loaded.data;

  // Null until the owner edits: the form shows the saved look until then.
  const [edited, setDraft] = useState<AppearanceDraft | null>(null);
  const saved = data ? draftOf(data.theme) : null;
  const draft = edited ?? saved;
  const changed = !!(edited && saved && !sameDraft(edited, saved));

  const [schemeChoice, setScheme] = useState<Scheme | null>(null);
  const scheme: Scheme =
    draft?.overrides.scheme ?? schemeChoice ?? data?.theme.detected?.scheme ?? 'light';

  const a = assistantQ.data;
  const assistant = {
    botName: a?.settings.botName?.trim() || a?.defaults.botName || 'Assistant',
    greeting: a?.settings.greeting.en?.trim() || a?.defaults.greeting.en || '',
  };

  const save = useMutation({
    mutationFn: (d: AppearanceDraft) => api.saveWidgetAppearance(WidgetAppearanceBody.parse(d)),
    onSuccess: (s) => {
      setWidget(s);
      setDraft(null);
      setToast('Saved. Your widget looks like this on your website now.');
    },
  });

  const detect = useMutation({
    mutationFn: () => api.detectWidgetTheme(),
    onSuccess: ({ detection }) => {
      if (data) setWidget({ ...data, detection });
    },
    onError: (err) => {
      // Someone else started one: show it.
      if (err instanceof ApiError && err.code === 'detect_running') void loaded.refetch();
    },
  });

  // The install check turning green is announced (toast is role="status").
  const lastState = useRef(data?.install.state);
  useEffect(() => {
    const state = data?.install.state;
    if (lastState.current && lastState.current !== 'detected' && state === 'detected')
      setToast(`Your widget is on ${hostOf(data?.install.origin ?? '')}.`);
    lastState.current = state;
  }, [data?.install.state, data?.install.origin, setToast]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      changed && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!changed) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed]);

  return {
    loaded,
    data,
    draft,
    changed,
    setDraft,
    scheme,
    schemeFixed: !!draft?.overrides.scheme,
    setScheme,
    assistant,
    save,
    detect,
    blocker,
    toast,
  };
}

export type WidgetEditor = ReturnType<typeof useWidgetEditor>;
