import { ReauthRequired, type ReauthMethod } from '@kaki/contracts';
import { createContext, useContext, useMemo } from 'react';
import { ApiError } from './api.ts';

/**
 * The re-auth guard (FEAT-006 §5.4, design.md `reauth-dialog`): a sensitive mutation wraps
 * its `mutationFn` in `guard(fn)`. On 403 `reauth_required` the dialog opens with the
 * user's methods; once the user is confirmed, `fn` runs once more, with no second click.
 * The provider that renders the dialog is `ReauthProvider` in `shell/reauth-dialog.tsx`.
 */

/** The user closed "Confirm it's you": the action didn't run, and callers show nothing. */
export class ReauthCancelled extends Error {
  constructor() {
    super('Re-authentication cancelled');
  }
}

/** The methods a 403 `reauth_required` offers, or null for any other error. */
export function reauthMethods(err: unknown): ReauthMethod[] | null {
  if (!(err instanceof ApiError) || err.status !== 403 || err.code !== 'reauth_required')
    return null;
  const parsed = ReauthRequired.shape.methods.safeParse(err.details.methods);
  return parsed.success ? parsed.data : null;
}

/** Opens the dialog; resolves true once the user is confirmed, false when cancelled. */
export type ReauthOpener = (methods: ReauthMethod[]) => Promise<boolean>;

export type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function makeGuard(open: ReauthOpener): Guard {
  return async (fn) => {
    try {
      return await fn();
    } catch (err) {
      const methods = reauthMethods(err);
      if (!methods) throw err;
      if (!(await open(methods))) throw new ReauthCancelled();
      // Once only: a second refusal is an error the caller shows.
      return fn();
    }
  };
}

export const ReauthContext = createContext<ReauthOpener | null>(null);

export function useReauthGuard(): { guard: Guard } {
  const open = useContext(ReauthContext);
  if (!open) throw new Error('useReauthGuard needs a ReauthProvider');
  return useMemo(() => ({ guard: makeGuard(open) }), [open]);
}
