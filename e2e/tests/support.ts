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

/** Waits for the newest sign-in email to `email` sent after `since`, and returns its link. */
export async function magicLinkFor(email: string, since: Date): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const query = encodeURIComponent(`to:"${email}"`);
    const list = (await (await fetch(`${MAILPIT}/search?query=${query}`)).json()) as {
      messages: { ID: string; Created: string }[];
    };
    const fresh = list.messages.find((m) => new Date(m.Created) >= since);
    if (fresh) {
      const msg = (await (await fetch(`${MAILPIT}/message/${fresh.ID}`)).json()) as {
        Text: string;
      };
      const link = /https?:\/\/\S+\/auth\/verify#token=[\w-]+/.exec(msg.Text)?.[0];
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no sign-in email reached ${email}`);
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
