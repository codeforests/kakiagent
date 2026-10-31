import { expect, test, type Page } from '@playwright/test';
import {
  emailWithSubject,
  expectNoSeriousA11yViolations,
  magicLinkFor,
  requestSignInLink,
  signIn,
} from './support.ts';

/**
 * FEAT-008 §5.5 (AC-1–AC-8): a new address signs in and creates a workspace, so the dev
 * Owners never change. It sets and clears its name, changes its email (the old address is
 * told and still signs in until the link is opened), confirms it, signs out another
 * device from the list and signs in with the new address to the same workspace.
 */

/** Axe at desktop, at phone width (tall, so the tab bar covers nothing), and in dark. */
async function axeEverywhere(page: Page) {
  await expectNoSeriousA11yViolations(page);
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 375, height: 5000 });
  await expectNoSeriousA11yViolations(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'light' });
}

const toast = (page: Page, text: string) =>
  expect(page.getByRole('status').filter({ hasText: text })).toBeVisible();

test('a user names themselves, changes their email and signs out another device', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const run = Date.now();
  const user = `acct+${run}@kaki-bakery.test`;
  const next = `acct2+${run}@kaki-bakery.test`;
  const business = `Account Test ${run}`;

  // A fresh user with its own workspace, created through the API.
  await page.goto(await requestSignInLink(page, user));
  await expect(page).toHaveURL(/\/welcome$/);
  const options = (await (await page.request.get('/api/v1/auth/options')).json()) as {
    terms: { document: 'tos' | 'aup' | 'dpa'; version: string }[];
  };
  const accepted = Object.fromEntries(options.terms.map((t) => [t.document, t.version]));
  const created = await page.request.post('/api/v1/workspaces', {
    data: { businessName: business, accepted },
  });
  expect(created.status()).toBe(201);

  // SCR-APP-055, default (AC-8).
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Devices' })).toBeVisible();
  await expect(page.getByText("You're only signed in here.")).toBeVisible();
  await expect(page.getByTestId('device')).toHaveCount(1);
  await axeEverywhere(page);

  // Name: refused, set, shown in the menu, then cleared (AC-1).
  const name = page.getByLabel('Your name');
  await name.fill('Mei\u0007Ling');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Use up to 60 letters, numbers and spaces.')).toBeVisible();
  await name.fill('Mei Ling');
  await page.getByRole('button', { name: 'Save' }).click();
  await toast(page, 'Name saved.');
  await expect(name).toBeFocused();
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu')).toContainText('Mei Ling');
  await expect(page.getByRole('button', { name: 'Account' })).toHaveText('M');
  await page.keyboard.press('Escape');
  await name.fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByText('Your team sees your email address until you add a name.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toHaveText('A');

  // Email change: the same address is refused; a new one gets the link, the old one the
  // notice, and nothing changes yet (AC-2, AC-3, AC-4).
  await page.getByRole('button', { name: 'Change email' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change your email address' });
  await dialog.getByLabel('New email address').fill(user);
  await dialog.getByRole('button', { name: 'Send link' }).click();
  await expect(dialog.getByText("That's already your email address.")).toBeVisible();
  const since = new Date(Date.now() - 1000);
  await dialog.getByLabel('New email address').fill(next);
  await dialog.getByRole('button', { name: 'Send link' }).click();
  await toast(page, `Check ${next} for the link.`);
  await expect(page.getByText(`Waiting for you to confirm ${next}`)).toBeVisible();
  const link = await magicLinkFor(next, since, 'verify-email');
  const notice = await emailWithSubject(user, since, 'Your KakiAgent sign-in email is changing');
  expect(notice).not.toContain(next);
  await axeEverywhere(page);

  // Until it's confirmed the old address still signs in: a second device (AC-2).
  const other = await browser.newContext();
  const second = await other.newPage();
  await signIn(second, user);

  // Confirm, then the link is used (AC-2, AC-8).
  await page.goto(link);
  await expect(
    page.getByRole('heading', { name: `Your email address is now ${next}` }),
  ).toBeFocused();
  expect(page.url()).not.toContain('token=');
  await axeEverywhere(page);
  await page.goto('about:blank');
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'This link was already used' })).toBeVisible();
  await axeEverywhere(page);
  await page.goto('/verify-email');
  await expect(page.getByRole('heading', { name: "This link doesn't work" })).toBeVisible();
  await axeEverywhere(page);

  // The states the real flow can't reach on demand, stubbed (AC-8).
  for (const [status, error, heading] of [
    [400, 'link_expired', 'This link has expired'],
    [409, 'email_taken', 'That address already has an account'],
    [500, 'error', "We couldn't confirm your email address."],
  ] as const) {
    await page.route('**/api/v1/email-change/confirm', (route) =>
      route.fulfill({ status, json: { error, message: error } }),
    );
    await page.goto('about:blank');
    await page.goto('/verify-email#token=stubbed');
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await axeEverywhere(page);
    await page.unroute('**/api/v1/email-change/confirm');
  }

  // My account shows the new address.
  await page.goto('/account');
  await expect(page.locator('.account-card__address')).toHaveText(next);

  // Devices: two listed, the other one signed out; its next load needs sign-in (AC-5).
  await expect(page.getByTestId('device')).toHaveCount(2);
  await expect(page.getByTestId('device').first()).toContainText('This device');
  await axeEverywhere(page);
  await page
    .getByTestId('device')
    .nth(1)
    .getByRole('button', { name: /^Sign out / })
    .click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('device')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Devices' })).toBeFocused();
  await second.goto('/inbox');
  await expect(second).toHaveURL(/\/(sign-in|session-expired)$/);

  // The new address signs in to the same workspace.
  await signIn(second, next);
  await expect(second.getByTestId('tenant-name')).toHaveText(business);
  await other.close();
});
