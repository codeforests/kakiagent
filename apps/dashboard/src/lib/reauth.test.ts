import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.ts';
import { makeGuard, ReauthCancelled, reauthMethods } from './reauth.ts';

const stale = () =>
  new ApiError(403, 'reauth_required', 'Confirm it is you', {
    error: 'reauth_required',
    methods: ['totp', 'recovery'],
  });

describe('reauthMethods', () => {
  it('reads the methods of a 403 reauth_required', () => {
    expect(reauthMethods(stale())).toEqual(['totp', 'recovery']);
  });
  it('is null for other errors and malformed bodies', () => {
    expect(reauthMethods(new ApiError(403, 'forbidden', 'no'))).toBeNull();
    expect(reauthMethods(new ApiError(403, 'reauth_required', 'x', { methods: [] }))).toBeNull();
    expect(reauthMethods(new Error('network'))).toBeNull();
  });
});

describe('makeGuard', () => {
  it('runs the action once when the session is fresh', async () => {
    const open = vi.fn();
    const fn = vi.fn().mockResolvedValue('done');
    await expect(makeGuard(open)(fn)).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the dialog with the methods, then runs the action again', async () => {
    const open = vi.fn().mockResolvedValue(true);
    const fn = vi.fn().mockRejectedValueOnce(stale()).mockResolvedValueOnce('done');
    await expect(makeGuard(open)(fn)).resolves.toBe('done');
    expect(open).toHaveBeenCalledWith(['totp', 'recovery']);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects with ReauthCancelled and does not run again when cancelled', async () => {
    const fn = vi.fn().mockRejectedValue(stale());
    await expect(makeGuard(() => Promise.resolve(false))(fn)).rejects.toBeInstanceOf(
      ReauthCancelled,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes other errors through and retries only once', async () => {
    const other = new ApiError(409, 'mfa_not_enrolled', 'x');
    await expect(makeGuard(vi.fn())(() => Promise.reject(other))).rejects.toBe(other);
    const fn = vi.fn().mockRejectedValue(stale());
    await expect(makeGuard(() => Promise.resolve(true))(fn)).rejects.toBeInstanceOf(ApiError);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
