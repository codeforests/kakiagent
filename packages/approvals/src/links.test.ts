import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_LINK_TTL_S,
  approvalLinkKey,
  approvalLinkUrl,
  readApprovalLink,
  signApprovalLink,
} from './links.js';

const key = approvalLinkKey('magic-link-secret-for-tests');
const subject = {
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  approvalId: '00000000-0000-4000-8000-0000000000a2',
  userId: '00000000-0000-4000-8000-0000000000a3',
};
const now = new Date('2026-11-06T02:00:00Z');
const later = (s: number) => new Date(now.getTime() + s * 1000);

/** A token with the given claims, signed with the right key (so only the shape is wrong). */
function forge(claims: unknown, k = key) {
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${p}.${createHmac('sha256', k).update(p).digest('base64url')}`;
}
const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as Record<string, unknown>;

describe('approval link tokens (FEAT-056 §5.1; AC-1, AC-2, AC-3)', () => {
  it('round-trips the subject with a 24-hour expiry and a fresh nonce each time', () => {
    const a = signApprovalLink(key, subject, now);
    const b = signApprovalLink(key, subject, now);
    expect(a).not.toBe(b);
    const read = readApprovalLink(key, a, now);
    expect(read).toEqual({
      ok: true,
      claims: {
        ...subject,
        expiresAt: now.getTime() / 1000 + APPROVAL_LINK_TTL_S,
        nonce: claimsOf(a).n,
      },
    });
    expect(a.length).toBeLessThan(300);
  });

  it('the key is derived from the secret with a label, not the secret itself', () => {
    expect(key.equals(Buffer.from('magic-link-secret-for-tests'))).toBe(false);
    expect(approvalLinkKey('other').equals(key)).toBe(false);
  });

  it('any changed character is invalid', () => {
    const token = signApprovalLink(key, subject, now);
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '.') continue;
      const c = token[i] === 'A' ? 'B' : 'A';
      const changed = token.slice(0, i) + c + token.slice(i + 1);
      expect(readApprovalLink(key, changed, now), `index ${i}`).toEqual({
        ok: false,
        error: 'link_invalid',
      });
    }
  });

  it('another key, another version, bad JSON, a bad shape or a broken format is invalid', () => {
    const token = signApprovalLink(key, subject, now);
    const invalid = { ok: false, error: 'link_invalid' };
    expect(readApprovalLink(approvalLinkKey('other'), token, now)).toEqual(invalid);
    const c = claimsOf(token);
    expect(readApprovalLink(key, forge({ ...c, v: 2 }), now)).toEqual(invalid);
    expect(readApprovalLink(key, forge({ ...c, t: 'not-a-uuid' }), now)).toEqual(invalid);
    expect(readApprovalLink(key, forge({ ...c, e: 1.5 }), now)).toEqual(invalid);
    expect(readApprovalLink(key, forge({ ...c, n: 'short' }), now)).toEqual(invalid);
    expect(readApprovalLink(key, forge({ ...c, extra: 1 }), now)).toEqual(invalid);
    expect(readApprovalLink(key, forge([c]), now)).toEqual(invalid);
    const notJson = Buffer.from('{oops').toString('base64url');
    const sig = createHmac('sha256', key).update(notJson).digest('base64url');
    expect(readApprovalLink(key, `${notJson}.${sig}`, now)).toEqual(invalid);
    for (const bad of ['', '.', 'abc', `${token}.x`, token.replace('.', '.+')]) {
      expect(readApprovalLink(key, bad, now)).toEqual(invalid);
    }
  });

  it('a forged expiry is invalid, not expired', () => {
    const token = signApprovalLink(key, subject, now);
    const c = claimsOf(token);
    const p = Buffer.from(JSON.stringify({ ...c, e: Number(c.e) + 3600 })).toString('base64url');
    expect(
      readApprovalLink(key, `${p}.${token.split('.')[1]}`, later(APPROVAL_LINK_TTL_S + 60)),
    ).toEqual({
      ok: false,
      error: 'link_invalid',
    });
  });

  it('works until 24 hours and is expired one second after', () => {
    const token = signApprovalLink(key, subject, now);
    expect(readApprovalLink(key, token, later(APPROVAL_LINK_TTL_S - 1)).ok).toBe(true);
    expect(readApprovalLink(key, token, later(APPROVAL_LINK_TTL_S)).ok).toBe(true);
    expect(readApprovalLink(key, token, later(APPROVAL_LINK_TTL_S + 1))).toEqual({
      ok: false,
      error: 'link_expired',
    });
  });

  it('the URL carries the token in the fragment of /approve', () => {
    const url = approvalLinkUrl(key, 'https://app.example.test/', subject, now);
    expect(url).toMatch(/^https:\/\/app\.example\.test\/approve#token=[\w-]+\.[\w-]+$/);
    expect(readApprovalLink(key, url.split('#token=')[1]!, now).ok).toBe(true);
  });
});
