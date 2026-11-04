import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, signIn } from './support.ts';

/**
 * FEAT-049 AC-12 (LED-01, LED-08; SCR-APP-043): the second tenant's owner opens Leads and
 * consent from Settings, can't switch both phone and email off, saves a field change, sees
 * the marketing wording when the opt-in is on, and puts the seeded settings back.
 */
test('Leads and consent saves fields and guards phone or email', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, 'owner@second-tenant.test');
  await page.goto('/settings');
  await page.getByRole('link', { name: /Leads and consent/ }).click();
  await expect(page.getByRole('heading', { name: 'Leads and consent', level: 1 })).toBeVisible();
  const row = (name: string) => page.getByRole('group', { name, exact: true });
  await expect(row('Name')).toBeVisible();

  const phoneWas = await row('Phone').getByRole('radio', { checked: true }).getAttribute('value');
  const emailWas = await row('Email').getByRole('radio', { checked: true }).getAttribute('value');
  await row('Phone').getByLabel('Off').check();
  await row('Email').getByLabel('Off').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const summary = page.getByRole('alert').filter({ hasText: 'Keep phone or email on' });
  await expect(summary).toBeFocused();
  await row('Phone')
    .getByLabel(phoneWas === 'off' ? 'Optional' : phoneWas!.replace(/^./, (c) => c.toUpperCase()))
    .check();
  await row('Email')
    .getByLabel(emailWas!.replace(/^./, (c) => c.toUpperCase()))
    .check();

  // The opt-in reveals its wording; it isn't saved here.
  const toggle = page.getByRole('switch', { name: 'Ask visitors if they want offers and news' });
  const marketingWas = (await toggle.getAttribute('aria-checked')) === 'true';
  if (!marketingWas) {
    await toggle.click();
    await expect(page.getByLabel('Opt-in wording (English)')).toHaveValue(/offers and news/);
    await toggle.click();
  }

  const budgetWas = await row('Budget').getByRole('radio', { checked: true }).getAttribute('value');
  const other = budgetWas === 'required' ? 'Optional' : 'Required';
  await row('Budget').getByLabel(other).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Lead settings saved' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // Put Budget back so the seed stays as it was.
  await row('Budget')
    .getByLabel(budgetWas!.replace(/^./, (c) => c.toUpperCase()))
    .check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Lead settings saved' })).toBeVisible();

  // Phone width: no sideways scroll; a tall viewport keeps the fixed tab bar off the targets.
  await page.setViewportSize({ width: 375, height: 1600 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await expectNoSeriousA11yViolations(page);
});
