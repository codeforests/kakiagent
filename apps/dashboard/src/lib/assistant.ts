import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';

/** SCR-APP-041's settings, shared with the setup's "Rules and privacy" step (FEAT-035). */
export const useAssistantSettings = () =>
  useQuery({
    queryKey: ['assistant-settings'],
    queryFn: () => api.assistantSettings(),
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
