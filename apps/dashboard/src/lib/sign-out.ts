import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from './api.ts';

/**
 * Signs out (this device, or every device) and returns to sign-in (FEAT-005 ui-design,
 * SCR-APP-059 account menu). Both are undone by signing in again, so neither confirms.
 */
export function useSignOut(everywhere = false) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: everywhere ? api.signOutEverywhere : api.signOut,
    onSettled: () => {
      queryClient.clear();
      void navigate('/sign-in', { replace: true });
    },
  });
}
