import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, requestSignInLink } from './support.ts';

/**
 * FEAT-035 AC-1, AC-2, AC-4 and AC-9 (ONB-02, ONB-09; UC-03): a new owner's wizard in the focused
 * shell, Skip and Save and exit with progress kept, Home's "Continue setup", the go-live check
 * blocked with its Fix links, and the Channels page's Go live refused before the first go-live.
 */

async function signUp(page: Page) {
  const email = `onboarding-${Date.now()}@example.test`;
  await page.goto(await requestSignInLink(page, email));
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByLabel('Business name (required)').fill('Joo Chiat Florist');
  await page.getByRole('checkbox', { name: /I agree to the Terms of Service/ }).check();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/setup$/);
}

const stepLine = (page: Page) => page.locator('.wizard-header__step');

test('a new owner moves through the wizard, leaves, resumes, and is held at the go-live check', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signUp(page);

  // Step 1 in the focused shell: no sidebar or tab bar, the step header.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Tell us about your business' }),
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(stepLine(page)).toHaveText('Step 1 of 7 · Business profile');
  await expect(page.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute(
    'aria-valuetext',
    '0 of 7 steps finished',
  );
  await expect(page.getByRole('link', { name: 'Business profile' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(page.getByRole('button', { name: 'Skip for now' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);

  // Save → step 2.
  await page.getByLabel('Contact email').fill('hello@joochiat-florist.test');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page).toHaveURL(/\/setup\/sources$/);
  await expect(stepLine(page)).toHaveText('Step 2 of 7 · Add your sources');
  await expect(page.getByRole('link', { name: /Business profile done/ })).toBeVisible();

  // Skip step 2 → step 3; the step list marks it skipped.
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page).toHaveURL(/\/setup\/review$/);
  await expect(stepLine(page)).toHaveText('Step 3 of 7 · Review your facts');
  await expect(
    page.getByRole('status').filter({ hasText: 'Skipped. You can come back to it' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Add your sources/ })).toContainText('Skipped');
  await expect(page.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute(
    'aria-valuetext',
    '2 of 7 steps finished',
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Review your facts' })).toBeFocused();

  // Save and exit → Home's card names step 3, also after a reload (AC-1).
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Setup saved. Pick up where you left off from Home.' }),
  ).toBeVisible();
  const card = page.getByRole('region', { name: 'Finish setting up your assistant' });
  await expect(card).toContainText('Step 3 of 7: Review your facts. 2 of 7 steps finished.');
  await expectNoSeriousA11yViolations(page);
  await page.reload();
  await expect(card).toContainText('Step 3 of 7: Review your facts.');
  await card.getByRole('link', { name: 'Continue setup' }).click();
  await expect(page).toHaveURL(/\/setup\/review$/);

  // Jump to Go live from the step list: blocked rows with Fix links, Go live disabled (AC-4).
  await page.getByRole('link', { name: 'Go live' }).click();
  await expect(page).toHaveURL(/\/setup\/go-live$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Ready to go live?' })).toBeVisible();
  const required = page.getByRole('list', { name: 'Required before going live' });
  await expect(required.getByRole('listitem')).toHaveCount(7);
  await expect(page.getByTestId('readiness-approved_fact')).toContainText('missing');
  await expect(
    page.getByTestId('readiness-approved_fact').getByRole('link', { name: /Fix/ }),
  ).toHaveAttribute('href', '/setup/review');
  await expect(
    page.getByTestId('readiness-disclosure').getByRole('link', { name: /Fix/ }),
  ).toHaveAttribute('href', '/setup/rules#assistant');
  const goLive = page.getByRole('button', { name: 'Go live' });
  await expect(goLive).toBeDisabled();
  await expect(page.getByText('Fix the missing items to go live.')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Website chat widget' })).toBeChecked();

  // axe at 1280 and 375 (tall, AGENTS pitfall), light and dark (AC-9).
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectNoSeriousA11yViolations(page);
    await page.setViewportSize({ width: 375, height: 5000 });
    await expect(page.getByRole('button', { name: 'All steps' })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 900 });

  // The Channels page's Go live is refused before the first go-live (AC-4).
  await page.goto('/settings/channels');
  await page.getByRole('button', { name: 'Go live' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Go live' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Finish the go-live check first.' });
  await expect(alert).toBeFocused();
  await expect(alert.getByRole('link', { name: 'Open the go-live check' })).toHaveAttribute(
    'href',
    '/setup/go-live',
  );
  await expect(page.locator('.channel-card').getByText('Not live yet')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
