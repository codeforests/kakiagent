import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from './api.ts';

/** The top bar's tenant switcher (AUTH-04; FEAT-007 §5.4, ui-design "Tenant switcher"). */

export const WORKSPACES_KEY = ['workspaces'];

/** The user's active memberships, by name. */
export function useWorkspaces() {
  return useQuery({ queryKey: WORKSPACES_KEY, queryFn: api.workspaces });
}

/**
 * Moves the session to another workspace. Every cached answer belonged to the old one,
 * so the cache is cleared; going to `/` unmounts the inbox, whose socket reconnects on
 * the new tenant when it mounts again. The toast rides on the router state.
 */
export function useSwitchWorkspace() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (tenantId: string) => api.switchWorkspace(tenantId),
    onSuccess: (me) => {
      queryClient.clear();
      queryClient.setQueryData(['me'], me);
      void navigate('/', {
        state: { toast: `Switched to ${me.tenant?.name ?? 'your business'}.` },
      });
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY }),
  });
}
