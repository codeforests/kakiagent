import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

/** Form and feedback helpers shared by the dashboard's forms (design.md §4.2, §4.3). */

export const describedBy = (id: string, error?: string, help?: boolean) =>
  [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;

/** The toast (design.md §4.3): `role="status"`, gone after 5 s. Router state seeds it. */
export function useToast() {
  const location = useLocation();
  const navigate = useNavigate();
  const [toast, setToast] = useState<string | null>(
    () => (location.state as { toast?: string } | null)?.toast ?? null,
  );
  useEffect(() => {
    if (!toast) return;
    // Drop the router state so a reload doesn't show the toast again.
    if (location.state) void navigate(location.pathname, { replace: true, state: null });
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast, navigate, location.pathname, location.state]);
  return [toast, setToast] as const;
}
