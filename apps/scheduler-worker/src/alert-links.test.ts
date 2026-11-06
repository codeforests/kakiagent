import { approvalLinkKey, readApprovalLink } from '@kaki/approvals';
import { describe, expect, it } from 'vitest';
import { alertLinkOf } from './alert-links.js';

const key = approvalLinkKey('secret-for-tests');
const now = new Date('2026-11-06T02:00:00Z');
const T = '00000000-0000-4000-8000-0000000000a1';
const A = '00000000-0000-4000-8000-0000000000a2';
const U1 = '00000000-0000-4000-8000-0000000000a3';
const U2 = '00000000-0000-4000-8000-0000000000a4';

describe('alertLinkOf (FEAT-056 §5.2; AC-1)', () => {
  const linkOf = alertLinkOf(key, 'https://app.test', () => now);
  const pending = (userId: string) =>
    linkOf({ tenantId: T, userId, kind: 'approval_pending', subject: { type: 'approval', id: A } });

  it('mints a signed link per recipient that reads back as that user, approval and tenant', () => {
    const [l1, l2] = [pending(U1)!, pending(U2)!];
    expect(l1).not.toBe(l2);
    for (const [link, user] of [
      [l1, U1],
      [l2, U2],
    ] as const) {
      const read = readApprovalLink(key, link.split('#token=')[1]!, now);
      expect(read).toMatchObject({
        ok: true,
        claims: {
          tenantId: T,
          approvalId: A,
          userId: user,
          expiresAt: now.getTime() / 1000 + 86_400,
        },
      });
    }
  });

  it('other kinds keep their dashboard page', () => {
    expect(
      linkOf({
        tenantId: T,
        userId: U1,
        kind: 'approval_undeliverable',
        subject: { type: 'approval', id: A },
      }),
    ).toBeNull();
    expect(
      linkOf({
        tenantId: T,
        userId: U1,
        kind: 'escalation',
        subject: { type: 'conversation', id: A },
      }),
    ).toBeNull();
  });
});
