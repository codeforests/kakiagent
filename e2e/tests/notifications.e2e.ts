import { expect, test, type Page } from '@playwright/test';
import { emailWithSubject, expectNoSeriousA11yViolations, signIn } from './support.ts';

/**
 * FEAT-052 §5.7 (AC-1, AC-5, AC-6, AC-11): the bakery Owner opens Notifications from the
 * account menu, sees the defaults, turns an alert off (it persists), saves quiet hours and
 * sends a test alert that reaches Mailpit with the settings link. Defaults are restored
 * after each run so the dev Owner's alerts stay as seeded.
 */

const OWNER = 'owner@kaki-bakery.test';
const DEFAULTS = {
  events: [
    { event: 'escalation', email: true },
    { event: 'approval_pending', email: true },
    { event: 'hot_lead', email: true },
  ],
  quietHours: { enabled: true, start: '22:00', end: '08:00' },
};

const toast = (page: Page, text: string) =>
  expect(page.getByRole('status').filter({ hasText: text })).toBeVisible();
const emailSwitch = (page: Page, label: string) =>
  page.getByRole('switch', { name: `Email alerts: ${label}` });

test.afterEach(async ({ page }) => {
  const res = await page.request.put('/api/v1/me/notifications', { data: DEFAULTS });
  expect(res.status()).toBe(200);
});

test('an Owner chooses their alerts, sets quiet hours and sends a test alert', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);
  // Start from the defaults whatever an earlier run left.
  expect((await page.request.put('/api/v1/me/notifications', { data: DEFAULTS })).status()).toBe(
    200,
  );

  // The account menu leads to SCR-APP-056.
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Notifications' }).click();
  await expect(page).toHaveURL(/\/account\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();

  // Defaults (AC-5, AC-6): every event on, quiet hours on 22:00–08:00 Singapore time.
  for (const label of ['A customer asks for a person', 'A reply needs approval', 'New hot lead'])
    await expect(emailSwitch(page, label)).toHaveAttribute('aria-checked', 'true');
  await expect(
    page.getByRole('switch', { name: 'Hold alerts during quiet hours' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('22:00');
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('08:00');
  await expect(page.getByText(/^Overnight, 22:00 to 08:00\. Singapore time\./)).toBeVisible();
  await expect(page.getByText(`Alerts go to ${OWNER}.`)).toBeVisible();

  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 375, height: 5000 });
  await expectNoSeriousA11yViolations(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Turn the escalation email off; it applies on change and persists (AC-5).
  const escalation = emailSwitch(page, 'A customer asks for a person');
  await escalation.click();
  await toast(page, 'Saved.');
  await expect(escalation).toBeFocused();
  await page.reload();
  await expect(emailSwitch(page, 'A customer asks for a person')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(emailSwitch(page, 'New hot lead')).toHaveAttribute('aria-checked', 'true');

  // Quiet hours: the same start and end is refused, a daytime window saves (AC-6).
  const save = page.getByRole('button', { name: 'Save quiet hours' });
  await expect(save).toBeDisabled();
  await page.getByLabel('To', { exact: true }).fill('22:00');
  await save.click();
  await expect(page.getByText('Pick a different end time.')).toBeVisible();
  await expect(page.getByLabel('To', { exact: true })).toBeFocused();
  await page.getByLabel('From', { exact: true }).fill('12:00');
  await page.getByLabel('To', { exact: true }).fill('14:00');
  await save.click();
  await toast(page, 'Quiet hours saved.');
  await page.reload();
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('12:00');
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('14:00');

  // Quiet hours off hides the times.
  await page.getByRole('switch', { name: 'Hold alerts during quiet hours' }).click();
  await expect(page.getByText('Every alert is emailed as it happens.')).toBeVisible();
  await expect(page.getByLabel('From', { exact: true })).toHaveCount(0);

  // The test alert reaches the inbox with the settings link (AC-1, AC-11).
  const since = new Date(Date.now() - 1000);
  await page.getByRole('button', { name: 'Send me a test alert' }).click();
  await toast(page, `Test alert sent to ${OWNER}. It should arrive within a minute.`);
  const text = await emailWithSubject(OWNER, since, 'Test alert from KakiAgent');
  expect(text).toMatch(/\/account\/notifications/);

  // A second one within the minute is rate-limited (D11).
  await page.getByRole('button', { name: 'Send me a test alert' }).click();
  await expect(page.getByText(/^You just sent one\. Try again in \d+ seconds\.$/)).toBeVisible();
});
