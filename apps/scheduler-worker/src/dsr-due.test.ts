import type { ZoneDb } from '@kaki/db';
import { describe, expect, it, vi } from 'vitest';
import { dsrDueOnce } from './dsr-due.js';

const zdb = {} as ZoneDb;
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('dsrDueOnce (FEAT-061 §5.6; AC-8)', () => {
  it('runs the sweep on the given zone and logs how many requests it alerted', async () => {
    const log = logger();
    const run = vi.fn(async () => 2);
    await dsrDueOnce(zdb, log, run);
    expect(run).toHaveBeenCalledWith(zdb);
    expect(log.info).toHaveBeenCalledWith({ alerted: 2 }, 'data-request due sweep');
  });

  it('stays quiet when nothing is due', async () => {
    const log = logger();
    await dsrDueOnce(zdb, log, async () => 0);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('survives an error and logs it', async () => {
    const log = logger();
    const err = new Error('db down');
    await expect(
      dsrDueOnce(zdb, log, async () => {
        throw err;
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ err }, expect.stringContaining('retrying'));
  });
});
