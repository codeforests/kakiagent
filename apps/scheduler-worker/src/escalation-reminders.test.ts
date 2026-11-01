import type { ZoneDb } from '@kaki/db';
import { describe, expect, it, vi } from 'vitest';
import { escalationRemindersOnce } from './escalation-reminders.js';

const zdb = {} as ZoneDb;
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('escalationRemindersOnce (FEAT-044 §5.5)', () => {
  it('logs the tenants and how many reminders it queued', async () => {
    const log = logger();
    await escalationRemindersOnce(zdb, log, async () => [
      { tenantId: 'a', queued: 2 },
      { tenantId: 'b', queued: 3 },
    ]);
    expect(log.info).toHaveBeenCalledWith({ tenants: 2, queued: 5 }, 'escalation reminder scan');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('survives an error and logs it', async () => {
    const log = logger();
    const err = new Error('db down');
    await expect(
      escalationRemindersOnce(zdb, log, async () => {
        throw err;
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ err }, expect.stringContaining('retrying'));
  });
});
