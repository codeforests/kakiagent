import type { ZoneDb } from '@kaki/db';
import { describe, expect, it, vi } from 'vitest';
import { gapClusterOnce } from './gap-cluster.js';

const zdb = {} as ZoneDb;
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('gapClusterOnce (FEAT-019 §5.5)', () => {
  it('logs the tenants, grouped, opened and closed counts', async () => {
    const log = logger();
    await gapClusterOnce(zdb, log, async () => [
      { tenantId: 'a', grouped: 4, opened: 2, closed: 0 },
      { tenantId: 'b', grouped: 1, opened: 1, closed: 1 },
    ]);
    expect(log.info).toHaveBeenCalledWith(
      { tenants: 2, grouped: 5, opened: 3, closed: 1 },
      'coverage gap grouping',
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('survives an error and logs it', async () => {
    const log = logger();
    const err = new Error('db down');
    await expect(
      gapClusterOnce(zdb, log, async () => {
        throw err;
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ err }, expect.stringContaining('retrying'));
  });
});
