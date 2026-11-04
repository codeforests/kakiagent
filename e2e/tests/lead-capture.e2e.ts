import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-049 §6 (LED-01, LED-02, LED-08, LED-09, INB-11, GOV-08; SCR-WGT-003, SCR-WGT-005,
 * SCR-APP-014): a widget visitor asks to be called back, agrees on the consent card (with
 * the offers box ticked), sends the details form and sees the notice; the owner finds the
 * conversation by the phone in another spelling ("Phone matches") and sees the contact, the
 * lead and the dividers. A visitor who says Not now keeps chatting. While the AI is paused,
 * the fallback offers the contact form. Kaki Bakery's seed has a purpose statement, a
 * notice and the marketing opt-in on.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const CONSENT = 'Is it OK for us to use your details for this?';

/** Eight digits starting 9: a fresh SG mobile per run, so the contact is new. */
const mobile = () => `9${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

async function openWidget(browser: Browser, viewport = { width: 375, height: 812 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  await expect(panel).toBeVisible();
  return { page, panel };
}

async function say(panel: ReturnType<Page['getByRole']>, text: string) {
  await panel.getByLabel('Message', { exact: true }).fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
}

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }) => {
  // The paused test resumes through the API even when a step fails.
  if (page.url().startsWith('http')) await page.request.post('/api/v1/ai/resume').catch(() => 0);
});

test('agree, send details, and the owner finds the lead by phone', async ({ browser, page }) => {
  test.setTimeout(120_000);
  const digits = mobile();
  const name = `Mei Ling ${digits.slice(-4)}`;
  const { page: visitor, panel } = await openWidget(browser);

  await say(panel, 'Can someone get back to me about a birthday cake?');
  const consent = panel.getByRole('group', { name: CONSENT });
  await expect(consent).toBeVisible({ timeout: 30_000 });
  const offers = consent.getByRole('checkbox');
  await expect(offers).not.toBeChecked();
  await expectNoSeriousA11yViolations(visitor);
  await offers.check();
  await consent.getByRole('button', { name: 'Agree' }).click();

  const form = panel.getByRole('group', { name: 'Your details' });
  await expect(form.getByLabel('Name (required)')).toBeFocused();
  await expect(panel.getByText(/^You agreed · .* · Offers: yes$/)).toBeVisible();
  await form.getByLabel('Name (required)').fill(name);
  await form.getByLabel('Phone').fill('1234 5678');
  await form.getByRole('button', { name: 'Send details' }).click();
  await expect(form.getByRole('alert').first()).toContainText('Check 1 field');
  await expect(form.getByLabel('Phone')).toHaveAttribute('aria-invalid', 'true');
  await expectNoSeriousA11yViolations(visitor);
  await form.getByLabel('Phone').fill(`${digits.slice(0, 4)} ${digits.slice(4)}`);
  await form.getByRole('button', { name: 'Send details' }).click();
  await expect(panel.getByText(/has your details and will get back to you/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(panel.getByText(new RegExp(`^Details sent · ${name} · \\+65`))).toBeVisible();
  await visitor.context().close();

  // The owner: search by the phone in another spelling; the row says which field matched.
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/inbox');
  const field = page.getByRole('searchbox', { name: 'Search conversations' });
  await field.fill(`+65-${digits.slice(0, 4)}-${digits.slice(4)}`);
  const results = page.getByRole('region', { name: 'Search results' });
  const excerpt = results.getByTestId('search-excerpt').first();
  await expect(excerpt).toContainText('Phone matches ·');
  await results.getByRole('link').first().click();

  const sidebar = page.getByTestId('context-sidebar').first();
  await expect(sidebar.getByText(name, { exact: true })).toBeVisible();
  await expect(sidebar.getByText(`+65 ${digits.slice(0, 4)} ${digits.slice(4)}`)).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Copy phone' })).toBeVisible();
  const lead = sidebar.getByTestId('sidebar-lead');
  await expect(lead).toContainText('New');
  await expect(lead).toContainText('Offers · Yes');
  const dividers = page.getByTestId('thread-divider');
  await expect(dividers.filter({ hasText: 'Visitor agreed to share their details' })).toHaveCount(
    1,
  );
  await expect(dividers.filter({ hasText: 'Visitor left their details' })).toHaveCount(1);
  await expect(
    page.getByTestId('card-caption').filter({ hasText: 'Asked for consent' }),
  ).toHaveCount(1);
  await expectNoSeriousA11yViolations(page);
});

test('Not now records no details and the visitor keeps chatting', async ({ browser }) => {
  test.setTimeout(60_000);
  const { page: visitor, panel } = await openWidget(browser);
  await say(panel, 'Please contact me about catering.');
  const consent = panel.getByRole('group', { name: CONSENT });
  await expect(consent).toBeVisible({ timeout: 30_000 });
  await consent.getByRole('button', { name: 'Not now' }).click();
  await expect(panel.getByText('You chose not to share your details.')).toBeVisible();
  await expect(panel.getByText('No problem. You can keep asking questions.')).toBeVisible();
  await expect(panel.getByRole('group', { name: 'Your details' })).toHaveCount(0);
  await expect(panel.getByLabel('Message', { exact: true })).toBeFocused();
  await say(panel, 'What time do you open?');
  await expect(panel.locator('[data-author="agent"]:not([data-pending])').last()).toBeVisible({
    timeout: 30_000,
  });
  await visitor.context().close();
});

test('while the AI is paused, the fallback offers the contact form', async ({ browser, page }) => {
  test.setTimeout(90_000);
  await signIn(page, 'owner@kaki-bakery.test');
  expect((await page.request.post('/api/v1/ai/pause')).status()).toBe(200);

  const { page: visitor, panel } = await openWidget(browser);
  await panel.getByRole('button', { name: 'Leave your details' }).click();
  const form = panel.getByRole('region', { name: 'Leave your details' });
  await expect(form.getByLabel('Name (required)')).toBeFocused();
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(form.getByRole('alert').first()).toContainText(
    'Tick the box to agree before sending',
  );
  await expectNoSeriousA11yViolations(visitor);
  await form.getByLabel('Name (required)').fill('Ah Hock');
  await form.getByLabel('Email').fill(`ah.hock.${mobile()}@example.com`);
  await form.getByRole('checkbox', { name: /^I agree to / }).check();
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByRole('alert').filter({ hasText: /will get back to you/ })).toBeFocused();
  await visitor.context().close();
});
