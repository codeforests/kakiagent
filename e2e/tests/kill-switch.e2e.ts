import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-057 AC-3, AC-4, AC-5, AC-8, AC-9, AC-10 (GOV-08, UC-31; SCR-APP-058, SCR-WGT-005):
 * the owner pauses the AI from the top-bar pill, the banner shows on every page, a visitor
 * sees the paused notice with the composer enabled and gets the fallback once, then the
 * owner resumes from the banner and the next visitor message gets an AI answer.
 * `afterEach` resumes the AI through the API, so a failed step never leaves the shared dev
 * tenant paused for later specs (and browsers).
 */
const WIDGET_HOST = 'http://localhost:5175/';

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }) => {
  await page.request.post('/api/v1/ai/resume').catch(() => undefined);
});

const pill = (page: Page, state: string) =>
  page.getByRole('button', { name: `${state}. Pause or resume the AI` });

/** A visitor in its own browser context (axe needs one made by `browser.newContext()`). */
async function visit(page: Page) {
  const context = await page.context().browser()!.newContext();
  const visitor = await context.newPage();
  await openShadowRoots(visitor);
  const config = visitor.waitForResponse(/\/widget\/v1\/config/);
  await visitor.goto(WIDGET_HOST);
  expect((await config).status()).toBe(200);
  await visitor.getByRole('button', { name: /^Chat with / }).click();
  const panel = visitor.getByRole('dialog');
  await expect(panel).toBeVisible();
  return { visitor, panel };
}

test('the owner pauses the AI; visitors get the fallback; resuming brings answers back', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page, 'owner@kaki-bakery.test');
  await expect(pill(page, 'AI live')).toBeVisible();

  // The dialog first; Cancel changes nothing.
  await pill(page, 'AI live').click();
  const dialog = page.getByRole('alertdialog', { name: 'Pause AI on all channels?' });
  await expect(dialog).toContainText('stops replying everywhere within 5 seconds');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  const fallback = (
    await dialog.getByRole('group', { name: 'What visitors see' }).locator('p').first().innerText()
  )
    .trim()
    .replace(/^“|”$/g, '');
  expect(fallback.length).toBeGreaterThan(0);
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(pill(page, 'AI live')).toBeVisible();

  // Pause: the pill changes only once the server has answered, within 5 s.
  await pill(page, 'AI live').click();
  await dialog.getByRole('button', { name: 'Pause AI now' }).click();
  await expect(pill(page, 'AI paused')).toBeVisible({ timeout: 5_000 });
  await expect(
    page.getByRole('status').filter({ hasText: 'AI paused on all channels.' }),
  ).toBeVisible();
  await expect(pill(page, 'AI paused')).toBeFocused();
  const banner = page.getByRole('region', { name: 'AI paused' });
  await expect(banner).toContainText('AI is paused on all channels.');
  await expect(banner.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('link', { name: 'Knowledge' }).first().click();
  await expect(banner).toBeVisible();

  // The visitor: the paused notice above an enabled composer, no greeting; one fallback.
  const { visitor, panel } = await visit(page);
  const notice = panel.getByRole('region', { name: /^Message from / });
  await expect(notice).toContainText(fallback);
  await expect(panel.locator('.empty')).toHaveCount(0);
  await expect(panel.getByLabel('Message', { exact: true })).toBeEnabled();
  await expectNoSeriousA11yViolations(visitor, 'kaki-agent');
  await visitor.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(visitor, 'kaki-agent');
  await visitor.emulateMedia({ colorScheme: 'light' });
  await panel.getByLabel('Message', { exact: true }).fill('Do you have kaya toast today?');
  await panel.getByRole('button', { name: 'Send' }).click();
  const system = panel.locator('[data-author="system"]');
  await expect(system).toHaveCount(1, { timeout: 5_000 });
  await expect(system).toContainText(fallback);
  await expect(panel.locator('[data-author="agent"]')).toHaveCount(0);

  // Resume from the banner: pill back to live, banner gone.
  await banner.getByRole('button', { name: 'Resume AI' }).click();
  const resume = page.getByRole('alertdialog', { name: 'Resume AI?' });
  await expect(resume).toContainText(/Paused since \d{1,2}:\d{2} [ap]m, \d{1,2} \w{3}/);
  await resume.getByRole('button', { name: 'Resume AI' }).click();
  await expect(pill(page, 'AI live')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('status').filter({ hasText: 'AI resumed.' })).toBeVisible();
  await expect(banner).toHaveCount(0);

  // The next visitor message gets an AI answer.
  await panel.getByLabel('Message', { exact: true }).fill('What time do you open?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('[data-author="agent"]:not([data-pending])')).toBeVisible({
    timeout: 30_000,
  });
  await visitor.context().close();
});

test('at 375 px the pill is short and the dialog is a bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'owner@kaki-bakery.test');
  const button = pill(page, 'AI live');
  await expect(button.locator('.status-pill__short')).toHaveText('Live');
  await expect(button.locator('.status-pill__short')).toBeVisible();
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await button.click();
  const dialog = page.getByRole('alertdialog', { name: 'Pause AI on all channels?' });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  // A bottom sheet sits on the bottom edge; a centred dialog would end well above it.
  expect(box.y + box.height).toBeGreaterThan(780);
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});
