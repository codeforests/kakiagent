import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-051 §6 (LED-07, LED-05, LED-08; SCR-WGT-003 withdrawn, SCR-APP-033, -032, -014): a
 * widget visitor leaves their details (offers ticked), then writes "please stop using my
 * details", confirms on the withdraw card and sees the stored notice; the owner sees the
 * "Consent withdrawn" chip, the lead's danger alert and the withdrawal entry, and the CSV
 * export leaves the lead out. An owner records "Only stop offers" on a second lead. Each test
 * creates its own lead through the widget, so no seeded data changes. Chat text has no digits
 * (the fake triage reads the first number as a quantity); the alert email isn't awaited
 * (quiet hours).
 */
const WIDGET_HOST = 'http://localhost:5175/';
const OWNER = 'owner@kaki-bakery.test';
const CONSENT = 'Is it OK for us to use your details for this?';

/** Eight digits starting 9: a fresh SG mobile per run, so the contact is new. */
const mobile = () => `9${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
/** A run tag without digits, for names typed into the dashboard search. */
const tag = () =>
  Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
    '',
  );

type Panel = ReturnType<Page['getByRole']>;

async function say(panel: Panel, text: string) {
  await panel.getByLabel('Message', { exact: true }).fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
}

/** A visitor agrees (offers ticked) and leaves name and phone; returns the open panel. */
async function leaveDetails(browser: Browser, name: string) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  await say(panel, 'Can someone get back to me about a birthday cake?');
  const consent = panel.getByRole('group', { name: CONSENT });
  await expect(consent).toBeVisible({ timeout: 30_000 });
  await consent.getByRole('checkbox').check();
  await consent.getByRole('button', { name: 'Agree' }).click();
  const form = panel.getByRole('group', { name: 'Your details' });
  await form.getByLabel('Name (required)').fill(name);
  const digits = mobile();
  await form.getByLabel('Phone').fill(`${digits.slice(0, 4)} ${digits.slice(4)}`);
  await form.getByRole('button', { name: 'Send details' }).click();
  await expect(panel.getByText(/has your details and will get back to you/)).toBeVisible({
    timeout: 10_000,
  });
  return { page, panel };
}

const leadRow = (page: Page, name: string) =>
  page.getByTestId('lead-row').filter({ hasText: name });

test.describe.configure({ mode: 'serial' });

test('a visitor withdraws consent in the chat; the owner sees it and the export leaves them out', async ({
  browser,
  page,
}) => {
  test.setTimeout(150_000);
  const name = `Withdraw ${tag()}`;
  const { page: visitor, panel } = await leaveDetails(browser, name);

  // The withdraw card: three choices because offers were agreed (AC-10).
  await say(panel, 'please stop using my details');
  const card = panel.getByRole('group', { name: 'Stop using your details?' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('button')).toHaveText([
    'Keep my details',
    'Just stop offers',
    'Yes, stop',
  ]);
  await expect(panel.getByLabel('Message', { exact: true })).toBeFocused();
  await expectNoSeriousA11yViolations(visitor);
  await card.getByRole('button', { name: 'Yes, stop' }).click();
  await expect(panel.getByText(/^You withdrew consent · /)).toBeVisible({ timeout: 10_000 });
  const notice = panel.getByText(/^Done\. .* will stop using your contact details/);
  await expect(notice).toBeVisible();
  await expect(notice).toBeFocused();
  await expectNoSeriousA11yViolations(visitor);
  await visitor.context().close();

  // The owner: the list chip, the lead's alert and entry, the sidebar line (AC-7).
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, OWNER);
  await page.goto('/leads?status=all');
  const row = leadRow(page, name);
  await expect(row.getByTestId('withdrawn-chip')).toHaveText('Consent withdrawn');
  await row.getByRole('link', { name }).click();
  await expect(page.getByTestId('lead-withdrawn')).toContainText('Consent withdrawn');
  await expect(page.getByTestId('lead-withdrawn')).toContainText("They're left out of exports.");
  const entry = page.getByTestId('lead-consent').filter({ hasText: 'Withdrew consent' });
  await expect(entry).toContainText('Website chat');
  await expect(page.getByRole('button', { name: 'Record withdrawal' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 375, height: 5000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await entry.getByRole('link', { name: 'See conversation' }).click();
  await expect(page.getByTestId('sidebar-withdrawn').first()).toContainText(
    /^Consent withdrawn · /,
  );

  // The export leaves the withdrawn lead out (LED-05; AC-5). Fresh sign-in: no re-auth asked.
  const res = await page.request.post('/api/v1/leads/export', { data: { status: 'all' } });
  expect(res.status()).toBe(200);
  expect(await res.text()).not.toContain(name);
});

test('an owner records "Only stop offers" a person asked for directly', async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  const name = `Offers ${tag()}`;
  const { page: visitor } = await leaveDetails(browser, name);
  await visitor.context().close();

  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, OWNER);
  await page.goto('/leads?status=all');
  await leadRow(page, name).getByRole('link', { name }).click();
  await page.getByRole('button', { name: 'Record withdrawal' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Record a consent withdrawal' });
  await expect(dialog.getByRole('radio', { name: 'Stop all use of their details' })).toBeChecked();
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole('radio', { name: 'Only stop offers' }).check();
  await dialog.getByRole('button', { name: 'Record withdrawal' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Withdrawal recorded' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Consent' })).toBeFocused();
  await expect(
    page.getByTestId('lead-consent').filter({ hasText: 'Stopped offers' }),
  ).toContainText('Recorded by');
  await expect(page.getByText(/^stopped \d+ \w+ \d{4}$/)).toBeVisible();
  // Only offers stopped: no withdrawn alert, and the button stays for a later full withdrawal.
  await expect(page.getByTestId('lead-withdrawn')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Record withdrawal' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
