import { SEED_TERMS_VERSION } from '@kaki/db/setup';
import { describe, expect, it } from 'vitest';
import {
  backoffSeconds,
  can,
  CURRENT_TERMS,
  hashToken,
  isTokenShaped,
  magicLinkEmail,
  magicLinkToken,
  magicLinkUrl,
  newSessionToken,
  normaliseEmail,
  termsAreCurrent,
  workspaceSlug,
} from './index.js';

describe('capabilities', () => {
  it('maps roles to capabilities', () => {
    expect(can('owner', 'killswitch.toggle')).toBe(true);
    expect(can('agent', 'inbox.reply')).toBe(true);
    expect(can('agent', 'settings.manage')).toBe(false);
    expect(can('admin', 'kb.manage')).toBe(true);
    expect(can('agent', 'kb.manage')).toBe(false);
  });
});

describe('tokens', () => {
  it('session tokens are 256 random bits in base64url', () => {
    const a = newSessionToken();
    expect(isTokenShaped(a)).toBe(true);
    expect(newSessionToken()).not.toBe(a);
    expect(hashToken(a)).toHaveLength(32);
    expect(isTokenShaped('short')).toBe(false);
    expect(isTokenShaped(`${a}=`)).toBe(false);
  });

  it('magic-link tokens are derived from the link ID under the secret (D6)', () => {
    const id = '9f1c6a9e-1d1b-4d55-8f15-3b6c0e8a2a11';
    const t = magicLinkToken('s'.repeat(32), id);
    expect(isTokenShaped(t)).toBe(true);
    expect(magicLinkToken('s'.repeat(32), id)).toBe(t);
    expect(magicLinkToken('x'.repeat(32), id)).not.toBe(t);
    expect(magicLinkUrl({ secret: 's'.repeat(32), appUrl: 'http://localhost:5173/' }, id)).toBe(
      `http://localhost:5173/auth/verify#token=${t}`,
    );
  });
});

describe('email', () => {
  it('normalises addresses', () => {
    expect(normaliseEmail('  Owner@Kaki-Bakery.TEST ')).toBe('owner@kaki-bakery.test');
  });

  it('builds the sign-in email with the link in text and HTML', () => {
    const e = magicLinkEmail('a@b.sg', 'http://x/auth/verify#token=a&b');
    expect(e.to).toBe('a@b.sg');
    expect(e.text).toContain('http://x/auth/verify#token=a&b');
    expect(e.html).toContain('href="http://x/auth/verify#token=a&#38;b"');
    expect(e.text).toContain('15 minutes');
  });

  it('backs off 10 s, doubling, capped at 2 minutes', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffSeconds)).toEqual([10, 20, 40, 80, 120, 120]);
  });
});

describe('terms (AUTH-08)', () => {
  it('the dev seed accepted the current versions', () => {
    for (const d of Object.values(CURRENT_TERMS)) expect(d.version).toBe(SEED_TERMS_VERSION);
  });

  it('accepts only the current version of every document', () => {
    const v = CURRENT_TERMS.tos.version;
    expect(termsAreCurrent({ tos: v, aup: v, dpa: v })).toBe(true);
    expect(termsAreCurrent({ tos: v, aup: v, dpa: '2020-01-01' })).toBe(false);
  });
});

describe('workspaceSlug', () => {
  it('keeps ASCII letters and digits and adds the suffix', () => {
    expect(workspaceSlug('Kaki Bakery Pte. Ltd.', 'abc123')).toBe('kaki-bakery-pte-ltd-abc123');
    expect(workspaceSlug('咖啡店', 'abc123')).toBe('workspace-abc123');
    expect(workspaceSlug('Café Ümlaut', 'abc123')).toBe('cafe-umlaut-abc123');
    expect(workspaceSlug('x'.repeat(60), 'abc123')).toBe(`${'x'.repeat(40)}-abc123`);
    expect(workspaceSlug('Kaki').length).toBe('kaki-'.length + 6);
  });
});
