import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.ts';
import { afterSignIn, linkState, linkStore, takeLinkToken } from './approval-link.ts';

function stubBrowser(hash: string, storage: Storage | 'throws') {
  const loc = { hash, pathname: '/approve', search: '' };
  const replaceState = vi.fn((_s: unknown, _t: string, url: string) => {
    loc.hash = '';
    loc.pathname = url;
  });
  vi.stubGlobal('location', loc);
  vi.stubGlobal('history', { state: null, replaceState });
  if (storage === 'throws') {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
  } else vi.stubGlobal('sessionStorage', storage);
  return { loc, replaceState };
}

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe('takeLinkToken', () => {
  beforeEach(() => linkStore.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('reads the fragment first, stores it and strips the hash', () => {
    const storage = memoryStorage();
    storage.setItem('kaki.approval-link', 'older');
    const { loc, replaceState } = stubBrowser('#token=abc.def', storage);
    expect(takeLinkToken()).toBe('abc.def');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/approve');
    expect(loc.hash).toBe('');
    expect(storage.getItem('kaki.approval-link')).toBe('abc.def');
  });

  it('falls back to storage when the fragment has no token', () => {
    const storage = memoryStorage();
    storage.setItem('kaki.approval-link', 'stored');
    stubBrowser('', storage);
    expect(takeLinkToken()).toBe('stored');
  });

  it('is null with neither', () => {
    stubBrowser('', memoryStorage());
    expect(takeLinkToken()).toBeNull();
  });

  it('keeps the token in memory when storage throws', () => {
    stubBrowser('#token=xyz', 'throws');
    expect(takeLinkToken()).toBe('xyz');
    stubBrowser('', 'throws');
    expect(takeLinkToken()).toBe('xyz');
    linkStore.clear();
    expect(takeLinkToken()).toBeNull();
  });
});

describe('linkState', () => {
  it('maps each answer', () => {
    expect(linkState(undefined, null)).toBe('checking');
    expect(linkState({ state: 'sign_in' }, null)).toBe('sign_in');
    expect(linkState({ state: 'two_step' }, null)).toBe('checking');
    expect(linkState({ state: 'two_step_setup' }, null)).toBe('checking');
    expect(
      linkState(
        { state: 'opened', approvalId: '00000000-0000-4000-8000-000000000000', switched: false },
        null,
      ),
    ).toBe('checking');
  });

  it('maps each error code', () => {
    const e = (status: number, code: string) => new ApiError(status, code, code);
    expect(linkState(undefined, e(400, 'link_invalid'))).toBe('invalid');
    expect(linkState(undefined, e(410, 'link_expired'))).toBe('expired');
    expect(linkState(undefined, e(409, 'link_used'))).toBe('used');
    expect(linkState(undefined, e(403, 'wrong_account'))).toBe('wrong_account');
    expect(linkState(undefined, e(403, 'not_member'))).toBe('not_member');
    expect(linkState(undefined, e(429, 'rate_limited'))).toBe('error');
    expect(linkState(undefined, e(500, 'link_invalid'))).toBe('error');
    expect(linkState(undefined, new TypeError('Failed to fetch'))).toBe('error');
  });
});

describe('afterSignIn', () => {
  it('goes to the landing, through two-step when owed', () => {
    expect(afterSignIn('app')).toBe('/approve');
    expect(afterSignIn('create-workspace')).toBe('/approve');
    expect(afterSignIn('mfa')).toBe('/two-step?next=%2Fapprove');
    expect(afterSignIn('mfa-enrol')).toBe('/two-step/setup?next=%2Fapprove');
  });
});
