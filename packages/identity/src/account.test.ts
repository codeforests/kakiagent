import { describe, expect, it } from 'vitest';
import {
  deviceLabel,
  emailChangeConfirmEmail,
  emailChangeNoticeEmail,
  emailChangeToken,
  emailChangeUrl,
  emailInUseEmail,
  inviteToken,
  magicLinkToken,
  maskEmail,
} from './index.js';

const UA = {
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:144.0) Gecko/20100101 Firefox/144.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 16181.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

describe('deviceLabel (FEAT-008 D6)', () => {
  it.each([
    [UA.chromeWin, 'Chrome on Windows'],
    [UA.edgeWin, 'Edge on Windows'],
    [UA.safariMac, 'Safari on macOS'],
    [UA.firefoxMac, 'Firefox on macOS'],
    [UA.firefoxLinux, 'Firefox on Linux'],
    [UA.safariIphone, 'Safari on iPhone'],
    [UA.chromeIphone, 'Chrome on iPhone'],
    [UA.safariIpad, 'Safari on iPad'],
    [UA.chromeAndroid, 'Chrome on Android'],
    [UA.samsungAndroid, 'Samsung Internet on Android'],
    [UA.chromeOs, 'Chrome on ChromeOS'],
  ])('%s → %s', (ua, label) => expect(deviceLabel(ua)).toBe(label));

  it('anything else is an unknown device', () => {
    expect(deviceLabel(null)).toBe('Unknown device');
    expect(deviceLabel('')).toBe('Unknown device');
    expect(deviceLabel('curl/8.9.1')).toBe('Unknown device');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) SomeBot/1.0')).toBe('Unknown device');
  });
});

describe('email change token and emails (FEAT-008 §5.1)', () => {
  const secret = 's'.repeat(32);
  const id = '00000000-0000-4000-8000-000000000001';

  it('the token has its own domain under the shared secret', () => {
    const t = emailChangeToken(secret, id);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(emailChangeToken(secret, id)).toBe(t);
    expect(t).not.toBe(magicLinkToken(secret, id));
    expect(t).not.toBe(inviteToken(secret, id));
    expect(emailChangeToken('t'.repeat(32), id)).not.toBe(t);
  });

  it('masks the new address in the notice', () => {
    expect(maskEmail('mei.ling@example.com')).toBe('m***@example.com');
    expect(maskEmail('a@b.sg')).toBe('a***@b.sg');
    expect(maskEmail('broken')).toBe('***');
    const n = emailChangeNoticeEmail('old@example.com', 'mei.ling@example.com');
    expect(n.to).toBe('old@example.com');
    expect(n.text).toContain('m***@example.com');
    expect(n.text).not.toContain('mei.ling');
    expect(n.html).not.toContain('mei.ling');
    expect(n.text).toMatch(/sign out of all devices/);
  });

  it('the confirmation carries the link; the in-use email carries none', () => {
    const url = emailChangeUrl({ secret, appUrl: 'http://localhost:5173/' }, id);
    expect(url).toBe(`http://localhost:5173/verify-email#token=${emailChangeToken(secret, id)}`);
    const c = emailChangeConfirmEmail('new@example.com', url);
    expect(c.text).toContain(url);
    expect(c.html).toContain('verify-email#token=');
    const used = emailInUseEmail('new@example.com');
    expect(used.text).not.toMatch(/https?:|token/);
    expect(used.html).not.toMatch(/href|token/);
  });
});
