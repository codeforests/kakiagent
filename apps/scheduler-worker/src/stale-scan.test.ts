import type { ZoneDb } from '@kaki/db';
import { describe, expect, it, vi } from 'vitest';
import { staleScanOnce } from './stale-scan.js';

const zdb = {} as ZoneDb;
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('staleScanOnce (FEAT-018 §5.5)', () => {
  it('logs the tenants, flagged and closed counts', async () => {
    const log = logger();
    await staleScanOnce(zdb, log, async () => [
      { tenantId: 'a', flagged: 2, closed: 1 },
      { tenantId: 'b', flagged: 3, closed: 0 },
    ]);
    expect(log.info).toHaveBeenCalledWith({ tenants: 2, flagged: 5, closed: 1 }, 'stale fact scan');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('survives an error and logs it', async () => {
    const log = logger();
    const err = new Error('db down');
    await expect(
      staleScanOnce(zdb, log, async () => {
        throw err;
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ err }, expect.stringContaining('retrying'));
  });
});
