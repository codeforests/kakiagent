import { expect, test, type Browser } from '@playwright/test';
import {
  expectNoSeriousA11yViolations,
  magicLinkFor,
  openShadowRoots,
  resetSignInLimits,
} from './support.ts';

/**
 * FEAT-056 §6 (APR-03, UC-22; SCR-APP-018 link landing): a widget visitor asks for a quote,
 * the Owner's `approval_pending` alert in Mailpit carries a signed link, which opens signed
 * out at phone width, asks for sign-in, and after the emailed sign-in link lands on the
 * approval, where the Owner prices it and approves. The same link then says it was used, and
 * a tampered one that it isn't valid. Expiry, wrong account, races and switching business
 * are covered by integration tests (`apps/api/test/approval-links.int.test.ts`).
 */
const WIDGET_HOST = 'http://localhost:5175/';
const OWNER = 'owner@kaki-bakery.test';
const WAITING = /Our team is (still )?checking/;
// Phone width; axe at a tall viewport (code-map pitfall: the fixed footer and target size).
const PHONE = { width: 375, height: 5000 };

/** A run tag with no digits: the fake triage takes the first number as the quantity. */
const runTag = (prefix: string) =>
  prefix +
  Date.now()
    .toString(36)
    .replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!);

async function askForQuote(browser: Browser, text: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  await panel.getByLabel('Message', { exact: true }).fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.notice', { hasText: WAITING })).toBeVisible({ timeout: 30_000 });
  return context;
}

/** Changes the signature's last character, so the token no longer verifies. */
const tamper = (link: string) => link.slice(0, -1) + (link.endsWith('A') ? 'B' : 'A');

test('an alert link opens signed out, signs in and approves once (AC-1, AC-4, AC-5, AC-7, AC-9)', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const tag = runTag('L');
  const since = new Date(Date.now() - 1000);
  const visitor = await askForQuote(
    browser,
    `Can I get a quote for ${tag} 20 boxes of kueh lapis for Friday?`,
  );
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  try {
    // AC-1: the alert's button is a signed link to the landing.
    const link = await magicLinkFor(OWNER, since, 'approve');

    // AC-4: signed out, the landing asks for sign-in and consumes nothing.
    await page.goto(link);
    await expect(
      page.getByRole('heading', { name: 'Sign in to review this approval', level: 1 }),
    ).toBeFocused();
    expect(page.url()).not.toContain('token=');
    await expectNoSeriousA11yViolations(page);

    await resetSignInLimits();
    const signInSince = new Date(Date.now() - 1000);
    await page.getByLabel('Work email').fill(OWNER);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeFocused();
    await expect(page.getByText('Open it on this phone')).toBeVisible();

    // The sign-in link carries the approval token back, then the link opens (AC-5).
    await page.goto(await magicLinkFor(OWNER, signInSince));
    await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /^Quote for / })).toBeVisible();

    // AC-7: approve from the phone-width page, as FEAT-055.
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('button', { name: 'Add a line' }).click();
    await page.getByLabel('Line 1', { exact: true }).fill(`Kueh lapis box ${tag}`);
    await page.getByLabel('Quantity').fill('20');
    await page.getByLabel('Unit price').fill('12.50');
    await page.getByRole('button', { name: 'Approve and send' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Quote sent to the visitor' }),
    ).toBeVisible();

    // AC-5: the same link again, now signed in, is used.
    await page.goto(link);
    await expect(
      page.getByRole('heading', { name: 'This link has already been used', level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open approvals' })).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    // A changed character: not valid. (From another page, or the hash change alone would not
    // reload the landing.)
    await page.goto('about:blank');
    await page.goto(tamper(link));
    await expect(
      page.getByRole('heading', { name: "This link isn't valid", level: 1 }),
    ).toBeFocused();
    // AC-9: desktop width passes axe too, and the state works by keyboard.
    await page.setViewportSize({ width: 1440, height: 1600 });
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Open approvals' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible();
  } finally {
    await visitor.close();
    await context.close();
  }
});
