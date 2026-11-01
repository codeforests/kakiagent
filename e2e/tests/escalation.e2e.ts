import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  emailWithSubject,
  expectNoSeriousA11yViolations,
  openShadowRoots,
  signIn,
} from './support.ts';

/**
 * FEAT-044 §5.9 (CHN-13, INB-05, INB-01; SCR-WGT-002, SCR-APP-014, SCR-APP-015,
 * SCR-APP-045): the Owner routes escalations to Mei Ling (the seeded agent) on Team; a
 * widget visitor presses Talk to a person and sees the notice; Mei Ling gets the alert in
 * Mailpit, finds the row under Escalated "For you" with the strip, and takes over. Routing
 * is reset to round-robin after each test so other specs see the seeded default.
 * Reminders, routing races and after-hours timing are covered by integration tests.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const LIVE = { timeout: 2000 }; // AC-1: the notice within 2 s.
const OWNER = 'owner@kaki-bakery.test';
const AGENT = 'agent@kaki-bakery.test';
const ROUND_ROBIN = { mode: 'round_robin', personUserId: null, reminderMinutes: 10 };
const NOTICE = /I've (asked|let) the team/;
// Mei Ling's alert settings: the seeded defaults, and without quiet hours for the test, so
// an after-hours (not urgent) alert is sent at once rather than held for the digest. An
// Agent can't receive approval alerts (FEAT-052 D9: 403), and events not listed keep their
// stored setting, so approval_pending is left out.
const PREFS = (quiet: boolean) => ({
  events: [
    { event: 'escalation', email: true },
    { event: 'hot_lead', email: true },
  ],
  quietHours: { enabled: quiet, start: '22:00', end: '08:00' },
});

let ownerPage: Page | null = null;

test.afterEach(async () => {
  if (!ownerPage) return;
  const res = await ownerPage.request.put('/api/v1/settings/escalation', { data: ROUND_ROBIN });
  expect(res.status()).toBe(200);
  await ownerPage.context().close();
  ownerPage = null;
});

async function staff(browser: Browser, email: string, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await signIn(page, email);
  return page;
}

async function openWidget(browser: Browser, viewport?: { width: number; height: number }) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  return { context, page, panel: page.getByRole('dialog') };
}

/** Owner: Team → Escalations → Always one person → Mei Ling, reminders after 10. */
async function routeToMeiLing(page: Page) {
  await page.goto('/settings/team');
  const card = page.getByRole('region', { name: 'Escalations' });
  await expect(
    card.getByText('When a customer asks for a person, who should we alert?'),
  ).toBeVisible();
  const save = card.getByRole('button', { name: 'Save' });
  await card.getByLabel('Always one person').check();
  // No person chosen: the error summary names the field.
  await save.click();
  await expect(card.getByRole('alert')).toContainText('Choose a person');
  await card.getByLabel('Person', { exact: true }).selectOption({ label: 'Mei Ling' });
  await card.getByLabel('Remind them after').fill('10');
  await save.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Escalation settings saved' }),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  return card;
}

test('a visitor asks for a person and Mei Ling picks it up (AC-1, AC-3, AC-4, AC-7, AC-10)', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  ownerPage = await staff(browser, OWNER);
  await routeToMeiLing(ownerPage);
  await expectNoSeriousA11yViolations(ownerPage);

  const mei = await staff(browser, AGENT);
  const visitor = await openWidget(browser);
  expect((await mei.request.put('/api/v1/me/notifications', { data: PREFS(false) })).status()).toBe(
    200,
  );
  try {
    // Mei Ling sees the routing read-only on Team.
    await mei.goto('/settings/team');
    await expect(
      mei.getByText('Escalations go to Mei Ling. Reminders after 10 minutes.'),
    ).toBeVisible();

    // The visitor presses Talk to a person before writing anything: the chat is created
    // silently, then escalated (AC-1).
    const since = new Date();
    const created = visitor.page.waitForResponse(
      (r) => r.url().endsWith('/widget/v1/conversations') && r.request().method() === 'POST',
    );
    const menuButton = visitor.panel.getByRole('button', { name: 'Chat options' });
    await menuButton.click();
    await visitor.panel.getByRole('menuitem', { name: 'Talk to a person' }).click();
    await expect(menuButton).toBeFocused();
    const id = ((await (await created).json()) as { conversationId: string }).conversationId;
    await expect(visitor.panel.locator('.notice', { hasText: NOTICE })).toBeVisible(LIVE);
    await expect(visitor.panel.locator('.notice', { hasText: NOTICE })).toHaveCount(1);
    await expectNoSeriousA11yViolations(visitor.page, 'kaki-agent');

    // The item hides while the escalation is pending.
    await menuButton.click();
    await expect(visitor.panel.getByRole('menuitem', { name: 'End chat' })).toBeVisible();
    await expect(visitor.panel.getByRole('menuitem', { name: 'Talk to a person' })).toHaveCount(0);
    await visitor.page.keyboard.press('Escape');

    // Mei Ling gets the alert (AC-4).
    const mail = await emailWithSubject(AGENT, since, 'A customer wants to talk to a person');
    expect(mail).toContain(`/inbox/${id}`);

    // Her inbox lists it under Escalated, assigned to her (AC-3, AC-7).
    await mei.goto('/inbox?view=escalated&assignee=me');
    const row = mei.locator(`[data-testid="conversation-row"][data-id="${id}"]`);
    await expect(row.getByTestId('conversation-escalation')).toContainText(
      /For you · (just now|\d+ min)/,
    );
    await expect(row.getByTestId('state-chip')).toHaveText('Escalated');
    await expectNoSeriousA11yViolations(mei);

    // The owner sees whom it was escalated to.
    await ownerPage.goto('/inbox?view=escalated');
    await expect(
      ownerPage
        .locator(`[data-testid="conversation-row"][data-id="${id}"]`)
        .getByTestId('conversation-escalation'),
    ).toContainText('For Mei Ling');

    // The conversation: the strip and the divider, then she takes over and the strip goes.
    await row.getByRole('link').click();
    const strip = mei.getByTestId('escalation-strip');
    await expect(strip).toContainText('Escalated to you');
    await expect(strip).toContainText('The visitor asked for a person.');
    await expect(
      mei
        .getByTestId('thread-divider')
        .filter({ hasText: 'Escalated to Mei Ling · visitor asked for a person' }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(mei);
    await mei.getByTestId('thread-dock').getByRole('button', { name: 'Take over' }).click();
    await expect(mei.getByTestId('thread-dock')).toHaveAttribute('data-mode', 'mine');
    await expect(strip).toHaveCount(0);
    await expect(
      visitor.panel.locator('.notice', { hasText: 'Mei Ling joined the chat.' }),
    ).toBeVisible(LIVE);
  } finally {
    await mei.request.put('/api/v1/me/notifications', { data: PREFS(true) });
    await visitor.context.close();
    await mei.context().close();
  }
});

test('at phone width, the widget menu and the Team card fit (AC-10)', async ({ browser }) => {
  test.setTimeout(90_000);
  // Tall viewport: the fixed tab bar must not cover targets for axe (STATE lessons).
  ownerPage = await staff(browser, OWNER, { width: 375, height: 1600 });
  const card = await routeToMeiLing(ownerPage);
  await expect(card.getByRole('button', { name: 'Save' })).toBeVisible();
  expect(
    await ownerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await expectNoSeriousA11yViolations(ownerPage);

  const visitor = await openWidget(browser, { width: 375, height: 1600 });
  try {
    await visitor.panel.getByRole('button', { name: 'Chat options' }).click();
    await expect(visitor.panel.getByRole('menuitem', { name: 'Talk to a person' })).toBeVisible();
    expect(
      await visitor.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectNoSeriousA11yViolations(visitor.page, 'kaki-agent');
  } finally {
    await visitor.context.close();
  }
});
