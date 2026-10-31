import type { ZoneDb } from '@kaki/db';
import { describe, expect, it, vi } from 'vitest';
import { autoCloseOnce } from './auto-close.js';

const zdb = {} as ZoneDb;
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('autoCloseOnce (FEAT-042 §5.3)', () => {
  it('logs the tenants and how many conversations it queued', async () => {
    const log = logger();
    await autoCloseOnce(zdb, log, async () => [
      { tenantId: 'a', queued: 2 },
      { tenantId: 'b', queued: 3 },
    ]);
    expect(log.info).toHaveBeenCalledWith({ tenants: 2, queued: 5 }, 'auto-close scan');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('survives an error and logs it', async () => {
    const log = logger();
    const err = new Error('db down');
    await expect(
      autoCloseOnce(zdb, log, async () => {
        throw err;
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ err }, expect.stringContaining('retrying'));
  });
});
