import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, requestSignInLink, signIn } from './support.ts';

/**
 * FEAT-005 AC-15 and AC-16 (ONB-01, AUTH-01, AUTH-08; UC-01, UC-02): sign-up by an
 * emailed link (read from Mailpit), workspace creation, sign-out, an existing owner's
 * sign-in, a used link, and an ended session, with axe on each screen.
 */

test('a new owner signs up, creates a workspace and reaches setup in under a minute', async ({
  page,
}) => {
  const started = Date.now();
  const email = `owner-${started}@example.test`;

  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in to KakiAgent' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // Validation state: an address that isn't one.
  await page.getByLabel('Work email').fill('not-an-email');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByText('Enter an email address, like you@yourbusiness.sg')).toBeVisible();
  await expect(page.getByLabel('Work email')).toHaveAttribute('aria-invalid', 'true');

  const link = await requestSignInLink(page, email);
  await expect(page.getByText(`We sent a sign-in link to ${email}.`)).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.goto(link);
  await expect(page).toHaveURL(/\/welcome$/);
  // The token never stays in the address bar.
  expect(page.url()).not.toContain('token');
  await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // Validation state: nothing filled in.
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const summary = page.getByRole('alert').filter({ hasText: 'Check these fields' });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole('link', { name: 'Enter your business name' })).toBeVisible();
  await expect(summary.getByRole('link', { name: 'Agree to the terms to continue' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.getByLabel('Business name (required)').fill('Tanjong Pagar Florist');
  await page.getByRole('checkbox', { name: /I agree to the Terms of Service/ }).check();
  await page.getByRole('button', { name: 'Create workspace' }).click();

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Tell us about your business' })).toBeVisible();
  await expect(page.getByTestId('tenant-name')).toHaveText('Tanjong Pagar Florist');
  expect(Date.now() - started).toBeLessThan(60_000);

  // Sign out from the account menu; the inbox then sends the user to sign in.
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu')).toContainText(email);
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/sign-in$/);

  // The used link shows its own page with a way forward.
  await page.goto(link);
  await expect(
    page.getByRole('heading', { name: 'This link has already been used' }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('link', { name: 'Send a new link' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('the seeded bakery owner signs in by magic link and reaches the inbox', async ({ page }) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await expect(page.getByTestId('tenant-name')).toHaveText('Kaki Bakery');
});

test('a link without a valid token shows the invalid-link page', async ({ page }) => {
  await page.goto('/auth/verify');
  await expect(page.getByRole('heading', { name: "This link isn't valid" })).toBeVisible();
  await page.goto(`/auth/verify#token=${'a'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: "This link isn't valid" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('signing out of all devices ends the session on the other device', async ({
  page,
  browser,
}) => {
  await signIn(page, 'owner@kaki-bakery.test');

  const other = await browser.newContext();
  const elsewhere = await other.newPage();
  await signIn(elsewhere, 'owner@kaki-bakery.test');
  await elsewhere.getByRole('button', { name: 'Account' }).click();
  await elsewhere.getByRole('menuitem', { name: 'Sign out of all devices' }).click();
  await expect(elsewhere).toHaveURL(/\/sign-in$/);
  await other.close();

  // SCR-APP-059: the first device's next request finds its session ended.
  await page.goto('/knowledge');
  await expect(page).toHaveURL(/\/session-expired$/);
  await expect(page.getByRole('heading', { name: 'Your session has ended' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('link', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('Google sign-in failure is explained on the sign-in page', async ({ page }) => {
  await page.goto('/sign-in?error=google');
  await expect(page.getByRole('alert')).toContainText("Google sign-in didn't work");
  await expectNoSeriousA11yViolations(page);
});
