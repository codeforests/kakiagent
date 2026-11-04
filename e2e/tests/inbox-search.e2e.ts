import { expect, test, type Browser } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-046 (INB-11; SCR-APP-014 search): a widget message is found from the inbox by a
 * unique word and by part of an email, the result opens at the matched message, Back keeps
 * the results, and the second tenant's search finds nothing of it. The text goes only in
 * the POST body. Axe at 1280 and at 375 (tall viewport). Against the seeded bakery and the
 * fake model.
 */
const WIDGET_HOST = 'http://localhost:5175/';

const token = () =>
  Array.from({ length: 10 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
    '',
  );

async function visitorSays(browser: Browser, text: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  await panel.getByLabel('Message').fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('[data-author="agent"]:not([data-pending])').first()).toBeVisible();
  await context.close();
}

test('search finds a chat by a word and by part of an email, opens it at the match, and stays in the tenant', async ({
  page: owner,
  browser,
}) => {
  const word = `kueh${token()}`;
  const user = `mei.${token()}`;
  await visitorSays(browser, `Do you have ${word} today? Email me at ${user}@example.com`);

  await owner.setViewportSize({ width: 1280, height: 900 });
  await signIn(owner, 'owner@kaki-bakery.test');
  await owner.goto('/inbox');
  const field = owner.getByRole('searchbox', { name: 'Search conversations' });
  const results = owner.getByRole('region', { name: 'Search results' });

  // By the unique word: one POST with the text in its body, never in the URL.
  const searched = owner.waitForRequest(
    (r) => r.url().endsWith('/api/v1/conversations/search') && r.method() === 'POST',
  );
  const urls: string[] = [];
  owner.on('request', (r) => urls.push(r.url()));
  await field.fill(word);
  const request = await searched;
  expect(request.postDataJSON()).toMatchObject({ q: word });
  await expect(results.getByRole('status')).toHaveText('1 conversation matches');
  await expect(owner.getByRole('navigation', { name: 'Views' })).toHaveCount(0);
  const excerpt = results.getByTestId('search-excerpt');
  await expect(excerpt).toContainText(/^(Visitor|Assistant):/);
  await expect(excerpt.locator('mark').first()).toHaveText(word);
  await expectNoSeriousA11yViolations(owner);

  // By part of the email.
  await field.fill(user);
  await expect(results.getByTestId('search-excerpt').locator('mark').first()).toHaveText(user);
  expect(urls.filter((u) => u.includes(word) || u.includes(user))).toEqual([]);

  // Opening the result marks the matched message; Escape brings the tabs back.
  await results.getByRole('link').first().click();
  const matched = owner.locator('[data-match="true"]');
  await expect(matched).toContainText(word);
  await expect(matched.locator('.bubble')).toHaveClass(/bubble--match/);
  await expect(results.getByTestId('search-excerpt')).toBeVisible();
  await field.press('Escape');
  await expect(field).toHaveValue('');
  await expect(owner.getByRole('navigation', { name: 'Views' })).toBeVisible();

  // No match.
  await field.fill(`zq${token()}`);
  await field.press('Enter');
  await expect(owner.getByRole('heading', { name: /^No conversations match/ })).toBeVisible();
  await owner.getByRole('button', { name: 'Clear search' }).last().click();
  await expect(field).toHaveValue('');

  // Phone width: one pane at a time; Back keeps the results; nothing scrolls sideways.
  await owner.setViewportSize({ width: 375, height: 5000 });
  await owner.goto('/inbox');
  await field.fill(word);
  await expect(results.getByRole('status')).toHaveText('1 conversation matches');
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(owner);
  await results.getByRole('link').first().click();
  await expect(owner.locator('[data-match="true"]')).toContainText(word);
  await owner.getByRole('link', { name: 'Back to inbox' }).click();
  await expect(field).toHaveValue(word);
  await expect(results.getByRole('link')).toHaveCount(1);

  // The top bar's entry from another page focuses the field.
  await owner.goto('/settings');
  await owner.getByRole('button', { name: 'Search conversations' }).click();
  await expect(owner).toHaveURL(/\/inbox$/);
  await expect(field).toBeFocused();

  // The second tenant finds nothing of the bakery's chat.
  const other = await browser.newContext();
  const second = await other.newPage();
  await second.setViewportSize({ width: 1280, height: 900 });
  await signIn(second, 'owner@second-tenant.test');
  await second.goto('/inbox');
  await second.getByRole('searchbox', { name: 'Search conversations' }).fill(word);
  await expect(second.getByRole('heading', { name: /^No conversations match/ })).toBeVisible();
  await other.close();
});
