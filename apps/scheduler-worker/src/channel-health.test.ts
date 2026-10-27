import type { ZoneDb } from '@kaki/db';
import { describe, expect, it, vi } from 'vitest';
import { channelHealthOnce } from './channel-health.js';

const zdb = {} as ZoneDb;
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('channelHealthOnce (FEAT-034 §5.2)', () => {
  it('logs the checked, degraded, recovered and failed counts', async () => {
    const log = logger();
    await channelHealthOnce(zdb, log, async () => ({
      checked: 3,
      degraded: 1,
      recovered: 0,
      failed: 0,
    }));
    expect(log.info).toHaveBeenCalledWith(
      { checked: 3, degraded: 1, recovered: 0, failed: 0 },
      'channel health check',
    );
  });

  it('survives an error and logs it', async () => {
    const log = logger();
    const err = new Error('db down');
    await expect(
      channelHealthOnce(zdb, log, async () => {
        throw err;
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ err }, expect.stringContaining('retrying'));
  });
});
