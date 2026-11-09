import type { ZoneDb } from '@kaki/db';
import { describe, expect, it, vi } from 'vitest';
import { channelDeliveriesOnce } from './channel-deliveries.js';

const zdb = {} as ZoneDb;
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('channelDeliveriesOnce (FEAT-036 §5.3)', () => {
  it('logs re-queued and timed-out deliveries, and purges at most hourly', async () => {
    const log = logger();
    const purge = vi.fn(async () => 4);
    const run = {
      due: async () => [
        { outcome: 'due' as const },
        { outcome: 'timed_out' as const },
        { outcome: 'due' as const },
      ],
      purge,
    };
    let t = 10_000_000;
    await channelDeliveriesOnce(zdb, log, run, () => t);
    expect(log.info).toHaveBeenCalledWith({ requeued: 2, timedOut: 1 }, 'delivery sweep');
    expect(log.info).toHaveBeenCalledWith({ purged: 4 }, 'inbound events purged');
    t += 60_000;
    await channelDeliveriesOnce(zdb, log, run, () => t);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('survives an error and logs it', async () => {
    const log = logger();
    const err = new Error('db down');
    await channelDeliveriesOnce(zdb, log, {
      due: async () => {
        throw err;
      },
      purge: async () => 0,
    });
    expect(log.error).toHaveBeenCalledWith({ err }, expect.stringContaining('retrying'));
  });
});
