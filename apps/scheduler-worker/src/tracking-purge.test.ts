import type { ZoneDb } from '@kaki/db';
import { describe, expect, it, vi } from 'vitest';
import { trackingPurgeOnce } from './tracking-purge.js';

const zdb = {} as ZoneDb;
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('trackingPurgeOnce (FEAT-029 §5.9; AC-9)', () => {
  it('runs the purge on the given zone and logs how many rows it deleted', async () => {
    const log = logger();
    const run = vi.fn(async () => 3);
    await trackingPurgeOnce(zdb, log, run);
    expect(run).toHaveBeenCalledWith(zdb);
    expect(log.info).toHaveBeenCalledWith({ deleted: 3 }, 'tracking purge');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('survives an error and logs it', async () => {
    const log = logger();
    const err = new Error('db down');
    await expect(
      trackingPurgeOnce(zdb, log, async () => {
        throw err;
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ err }, expect.stringContaining('retrying'));
  });
});
