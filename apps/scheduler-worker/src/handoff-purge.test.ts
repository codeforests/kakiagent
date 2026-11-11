import type { ZoneDb } from '@kaki/db';
import { describe, expect, it, vi } from 'vitest';
import { handoffPurgeOnce } from './handoff-purge.js';

const zdb = {} as ZoneDb;
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('handoffPurgeOnce (FEAT-038 §5.9; AC-10)', () => {
  it('runs the purge on the given zone and logs how many links it deleted', async () => {
    const log = logger();
    const run = vi.fn(async () => 3);
    await handoffPurgeOnce(zdb, log, run);
    expect(run).toHaveBeenCalledWith(zdb);
    expect(log.info).toHaveBeenCalledWith({ deleted: 3 }, 'handoff-link purge');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('survives an error and logs it', async () => {
    const log = logger();
    const err = new Error('db down');
    await expect(
      handoffPurgeOnce(zdb, log, async () => {
        throw err;
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ err }, expect.stringContaining('retrying'));
  });
});
