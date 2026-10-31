import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

/** Form and feedback helpers shared by the dashboard's forms (design.md §4.2, §4.3). */

export const describedBy = (id: string, error?: string, help?: boolean) =>
  [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;

/** The toast (design.md §4.3): `role="status"`, gone after 5 s. Router state seeds it. */
export function useToast() {
  const location = useLocation();
  const navigate = useNavigate();
  const incoming = (location.state as { toast?: string } | null)?.toast ?? null;
  const [toast, setToast] = useState<string | null>(incoming);
  // A toast sent to the page already showing (the tenant switcher, used on `/`) comes
  // without a remount, so the seed above never sees it: take it when the location changes.
  const [seenKey, setSeenKey] = useState(location.key);
  if (seenKey !== location.key) {
    setSeenKey(location.key);
    if (incoming) setToast(incoming);
  }
  useEffect(() => {
    if (!toast) return;
    // Drop the router state so a reload doesn't show the toast again.
    if (location.state) void navigate(location.pathname, { replace: true, state: null });
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast, navigate, location.pathname, location.state]);
  return [toast, setToast] as const;
}
