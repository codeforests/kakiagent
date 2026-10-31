import { createHmac } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { Redis } from 'iovalkey';
import { expect, type Page } from '@playwright/test';

/**
 * The widget renders into a closed shadow root (ADR-016), which Playwright cannot
 * pierce. In this test only, attachShadow is forced open; production stays closed.
 */
export async function openShadowRoots(page: Page) {
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      return attach.call(this, { ...init, mode: 'open' });
    };
  });
}

export async function expectNoSeriousA11yViolations(page: Page, include?: string) {
  const builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
  ]);
  const results = await (include ? builder.include(include) : builder).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

const MAILPIT = 'http://localhost:8025/api/v1';

/**
 * The sign-in links rate limit (AUTH-01: 5 per address, 20 per IP in 15 minutes) would
 * stop repeated local runs. Tests clear its counters; nothing else is touched.
 */
async function resetSignInLimits() {
  const valkey = new Redis(process.env.VALKEY_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
  });
  await valkey.connect();
  const keys = await valkey.keys('rl:ml:*');
  if (keys.length) await valkey.del(...keys);
  valkey.disconnect();
}

/**
 * Waits for the newest email to `email` sent after `since` holding a link to `path`
 * (a sign-in link by default, `invite` for an invitation, FEAT-007, `verify-email` for an
 * email change, FEAT-008), and returns it.
 */
export async function magicLinkFor(
  email: string,
  since: Date,
  path: 'auth/verify' | 'invite' | 'verify-email' = 'auth/verify',
): Promise<string> {
  const pattern = new RegExp(`https?://\\S+/${path}#token=[\\w-]+`);
  for (let i = 0; i < 60; i++) {
    const query = encodeURIComponent(`to:"${email}"`);
    const list = (await (await fetch(`${MAILPIT}/search?query=${query}`)).json()) as {
      messages: { ID: string; Created: string }[];
    };
    for (const fresh of list.messages.filter((m) => new Date(m.Created) >= since)) {
      const msg = (await (await fetch(`${MAILPIT}/message/${fresh.ID}`)).json()) as {
        Text: string;
      };
      const link = pattern.exec(msg.Text)?.[0];
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no email with a ${path} link reached ${email}`);
}

/** Waits for an email to `email` sent after `since` with this subject; returns its text. */
export async function emailWithSubject(
  email: string,
  since: Date,
  subject: string,
): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const query = encodeURIComponent(`to:"${email}" subject:"${subject}"`);
    const list = (await (await fetch(`${MAILPIT}/search?query=${query}`)).json()) as {
      messages: { ID: string; Created: string }[];
    };
    const fresh = list.messages.find((m) => new Date(m.Created) >= since);
    if (fresh) {
      const msg = (await (await fetch(`${MAILPIT}/message/${fresh.ID}`)).json()) as {
        Text: string;
      };
      return msg.Text;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no email "${subject}" reached ${email}`);
}

/** Asks for a sign-in link on SCR-APP-001 and returns it from Mailpit (FEAT-005). */
export async function requestSignInLink(page: Page, email: string): Promise<string> {
  await resetSignInLimits();
  const since = new Date(Date.now() - 1000);
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  return magicLinkFor(email, since);
}

/** Signs in an existing member through the emailed link and lands in the inbox. */
export async function signIn(page: Page, email: string) {
  await page.goto(await requestSignInLink(page, email));
  await expect(page).toHaveURL(/\/inbox$/);
}

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as `@kaki/identity` checks it (FEAT-006 §5.6).
 * `secret` is the base32 key from setup; `step` defaults to the current 30 s step.
 */
export function totp(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/[\s=]/g, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const at = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
