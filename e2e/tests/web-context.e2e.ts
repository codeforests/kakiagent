import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-029 §6 (AGT-05, CHN-03, INB-04; SCR-WGT-007, SCR-APP-037, SCR-APP-015): the owner
 * turns on consent mode; a visitor's widget sends no page events before "Allow", then
 * tracks two pages and asks a question; the inbox sidebar shows Now on and Viewed. With
 * tracking off, the next conversation shows only Now on. The dev tenant's mode goes back to
 * `on` after each test, so other specs keep the default.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const PROMPT = 'Help us help you faster?';

type Panel = ReturnType<Page['getByRole']>;

async function visitorPage(browser: Browser, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await openShadowRoots(page);
  // Page events that reached the api (the beacon's body is JSON text).
  const events: string[] = [];
  page.on('requestfinished', (r) => {
    if (r.url().includes('/widget/v1/events')) events.push(r.postData() ?? '');
  });
  await page.goto(WIDGET_HOST);
  return { page, events };
}

async function openPanel(page: Page): Promise<Panel> {
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  await expect(panel).toBeVisible();
  return panel;
}

/** A same-document route change, like a single-page site's link. */
const goTo = (page: Page, path: string) => page.evaluate((p) => history.pushState({}, '', p), path);

/** The conversation ID from the next create call. */
function nextConversation(page: Page) {
  return page
    .waitForResponse(
      (r) => r.url().endsWith('/widget/v1/conversations') && r.request().method() === 'POST',
    )
    .then(async (r) => ((await r.json()) as { conversationId: string }).conversationId);
}

async function ask(panel: Panel, text: string) {
  await panel.getByLabel('Message', { exact: true }).fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('[data-author="agent"]:not([data-pending])').first()).toBeVisible({
    timeout: 30_000,
  });
}

const trackingSection = (page: Page) => page.getByRole('region', { name: 'Visitor tracking' });

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }) => {
  if (page.url().startsWith('http'))
    await page.request.put('/api/v1/widget/tracking', { data: { mode: 'on' } }).catch(() => 0);
});

test('consent mode: nothing before Allow, then the inbox shows the pages', async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/settings/widget');
  const section = trackingSection(page);
  const track = section.getByRole('switch', { name: 'Track pages visitors view' });
  const consent = section.getByRole('switch', { name: 'Ask visitors first (consent mode)' });
  await expect(track).toHaveAttribute('aria-checked', 'true');
  await expect(consent).toHaveAttribute('aria-checked', 'false');
  await consent.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Tracking settings saved.' }),
  ).toBeVisible();
  await expect(consent).toHaveAttribute('aria-checked', 'true');
  await expectNoSeriousA11yViolations(page, 'section[aria-labelledby="widget-tracking"]');

  // Phone width: the prompt passes axe too (tall viewport: code-map E2E pitfalls).
  const phone = await visitorPage(browser, { width: 375, height: 5000 });
  const phonePanel = await openPanel(phone.page);
  await expect(phonePanel.getByRole('group', { name: PROMPT })).toBeVisible();
  await expectNoSeriousA11yViolations(phone.page);
  await phone.page.context().close();

  const { page: visitor, events } = await visitorPage(browser);
  await goTo(visitor, '/menu');
  await visitor.waitForTimeout(2_000);
  const panel = await openPanel(visitor);
  const prompt = panel.getByRole('group', { name: PROMPT });
  await expect(prompt).toBeVisible();
  await expectNoSeriousA11yViolations(visitor);
  expect(events).toHaveLength(0);

  await prompt.getByRole('button', { name: 'Allow' }).click();
  await expect(panel.getByText('Thanks. You can stop this from the menu.')).toBeVisible();
  await expect(panel.getByLabel('Message', { exact: true })).toBeFocused();
  await goTo(visitor, '/catering');
  await expect
    .poll(() => events.some((e) => e.includes('"/catering"')), { timeout: 15_000 })
    .toBe(true);
  expect(events.some((e) => e.includes('"/menu"'))).toBe(true);

  const created = nextConversation(visitor);
  await ask(panel, 'Do you do catering for 30 people?');
  const conversationId = await created;
  await visitor.context().close();

  await page.goto(`/inbox/${conversationId}`);
  const intent = page.getByTestId('context-sidebar').first().getByTestId('web-intent');
  await expect(intent).toContainText('Now on');
  await expect(intent).toContainText('/catering');
  await expect(intent).toContainText('Viewed');
  await expect(intent).toContainText('/menu');
});

test('tracking off: the next conversation shows only the current page', async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/settings/widget');
  const section = trackingSection(page);
  const track = section.getByRole('switch', { name: 'Track pages visitors view' });
  await expect(track).toHaveAttribute('aria-checked', 'true');
  await track.click();
  await expect(track).toHaveAttribute('aria-checked', 'false');
  const consent = section.getByRole('switch', { name: 'Ask visitors first (consent mode)' });
  await expect(consent).toHaveAttribute('aria-disabled', 'true');
  await expect(section.getByText('Turn on tracking to use this.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'section[aria-labelledby="widget-tracking"]');

  const { page: visitor, events } = await visitorPage(browser);
  await goTo(visitor, '/menu');
  const panel = await openPanel(visitor);
  await expect(panel.getByRole('group', { name: PROMPT })).toHaveCount(0);
  const created = nextConversation(visitor);
  await ask(panel, 'What time do you open on Sunday?');
  const conversationId = await created;
  expect(events).toHaveLength(0);
  await visitor.context().close();

  await page.goto(`/inbox/${conversationId}`);
  const sidebar = page.getByTestId('context-sidebar').first();
  const intent = sidebar.getByTestId('web-intent');
  await expect(intent).toContainText('/menu');
  await expect(intent).not.toContainText('Viewed');
  await expect(sidebar.getByText("Page history isn't shared for this visitor.")).toBeVisible();
});
