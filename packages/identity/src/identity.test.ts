import { describe, expect, it } from 'vitest';
import { can, issueDevSession, readDevSession } from './index.js';

const SECRET = 'x'.repeat(32);
const TENANT = '11111111-1111-4111-8111-111111111111';

describe('identity', () => {
  it('maps roles to capabilities', () => {
    expect(can('owner', 'killswitch.toggle')).toBe(true);
    expect(can('agent', 'inbox.reply')).toBe(true);
    expect(can('agent', 'settings.manage')).toBe(false);
    expect(can('admin', 'kb.manage')).toBe(true);
    expect(can('agent', 'kb.manage')).toBe(false);
  });

  it('round-trips a dev session and rejects tampering', () => {
    const token = issueDevSession(TENANT, SECRET);
    expect(readDevSession(token, SECRET)).toMatchObject({ tenantId: TENANT, role: 'owner' });
    expect(readDevSession(token + 'x', SECRET)).toBeNull();
    expect(readDevSession(token, 'y'.repeat(32))).toBeNull();
    expect(readDevSession(undefined, SECRET)).toBeNull();
    expect(readDevSession(issueDevSession(TENANT, SECRET, -1), SECRET)).toBeNull();
  });
});
