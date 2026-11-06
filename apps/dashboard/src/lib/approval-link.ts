import type { ApprovalLinkOpened, MagicLinkVerifyResponse } from '@kaki/contracts';
import { ApiError } from './api.ts';

/**
 * The signed approval link's landing (FEAT-056 §5.4, ui-design SCR-APP-018 link landing).
 * The token survives a sign-in, a Google redirect or a two-step detour in `sessionStorage`
 * of this tab; the emailed sign-in link carries its own copy for other browsers (D1).
 */
export const LINK_KEY = 'kaki.approval-link';

let memory: string | null = null;

export const linkStore = {
  get(): string | null {
    try {
      return sessionStorage.getItem(LINK_KEY) ?? memory;
    } catch {
      return memory;
    }
  },
  set(token: string) {
    memory = token;
    try {
      sessionStorage.setItem(LINK_KEY, token);
    } catch {
      /* private mode: the memory copy covers this page load */
    }
  },
  clear() {
    memory = null;
    try {
      sessionStorage.removeItem(LINK_KEY);
    } catch {
      /* nothing stored */
    }
  },
};

/** Reads `#token=` once (dropping it from the address bar and history); else the stored one. */
export function takeLinkToken(): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
  if (fromHash) {
    linkStore.set(fromHash);
    return fromHash;
  }
  return linkStore.get();
}

/** The landing's states (ui-design SCR-APP-018 link landing). */
export type LinkState =
  | 'checking'
  | 'sign_in'
  | 'expired'
  | 'used'
  | 'invalid'
  | 'wrong_account'
  | 'not_member'
  | 'error';

/** Dead links: the token is cleared, nothing more can come of it. */
export const ENDED_STATES: ReadonlySet<LinkState> = new Set([
  'expired',
  'used',
  'invalid',
  'not_member',
]);

const BY_CODE: Record<string, LinkState> = {
  link_invalid: 'invalid',
  link_expired: 'expired',
  link_used: 'used',
  wrong_account: 'wrong_account',
  not_member: 'not_member',
};

/**
 * The state to show for the open call's answer or error. `opened` and the two-step answers
 * navigate away, so they stay `checking` here.
 */
export function linkState(result: ApprovalLinkOpened | undefined, error: unknown): LinkState {
  if (error) {
    return error instanceof ApiError && error.status < 500 && BY_CODE[error.code]
      ? BY_CODE[error.code]!
      : 'error';
  }
  return result?.state === 'sign_in' ? 'sign_in' : 'checking';
}

/** Where the two-step answers go, coming back to the landing after the code. */
export const TWO_STEP_PATH = {
  two_step: '/two-step?next=%2Fapprove',
  two_step_setup: '/two-step/setup?next=%2Fapprove',
} as const;

/** Where a sign-in link requested from the landing goes after verify (§5.4). */
export function afterSignIn(next: MagicLinkVerifyResponse['next']): string {
  return next === 'mfa'
    ? TWO_STEP_PATH.two_step
    : next === 'mfa-enrol'
      ? TWO_STEP_PATH.two_step_setup
      : '/approve';
}
