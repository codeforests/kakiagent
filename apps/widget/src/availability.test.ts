import { describe, expect, it } from 'vitest';
import { mounts } from './availability.js';

const offline = (mode: 'hidden' | 'message') => ({
  availability: {
    live: false as const,
    mode,
    message: { en: 'Closed', zh: '关闭' },
    contact: { email: null, phone: null },
  },
});

describe('loader go-live check (SCR-WGT-005, FEAT-034 AC-4)', () => {
  it('mounts while live', () => expect(mounts({ availability: { live: true } })).toBe(true));
  it('adds nothing while offline and hidden', () => expect(mounts(offline('hidden'))).toBe(false));
  it('mounts while offline with a message', () => expect(mounts(offline('message'))).toBe(true));
});
