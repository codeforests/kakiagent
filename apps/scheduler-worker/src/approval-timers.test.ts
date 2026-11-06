import type { ZoneDb } from '@kaki/db';
import { describe, expect, it, vi } from 'vitest';
import { approvalTimersOnce } from './approval-timers.js';

const zdb = {} as ZoneDb;
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('approvalTimersOnce (FEAT-055 §5.4)', () => {
  it('logs the tenants and how many timers it queued', async () => {
    const log = logger();
    await approvalTimersOnce(zdb, log, async () => [
      { tenantId: 'a', queued: 2 },
      { tenantId: 'b', queued: 3 },
    ]);
    expect(log.info).toHaveBeenCalledWith({ tenants: 2, queued: 5 }, 'approval timer scan');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('survives an error and logs it', async () => {
    const log = logger();
    const err = new Error('db down');
    await expect(
      approvalTimersOnce(zdb, log, async () => {
        throw err;
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ err }, expect.stringContaining('retrying'));
  });
});
