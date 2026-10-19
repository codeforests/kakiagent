import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * The walking-skeleton done-when (plan §2): a visitor message typed in the widget on
 * a host page comes back as the echo reply in the widget, and appears in the signed-in
 * dashboard inbox without a reload. The path crosses every runtime role: api →
 * outbox → scheduler-worker → SQS → agent-worker → Valkey → realtime → both clients.
 */
const WIDGET_HOST = 'http://localhost:5175/';

/**
 * The widget renders into a closed shadow root (ADR-016), which Playwright cannot
 * pierce. In this test only, attachShadow is forced open; production stays closed.
 */
async function openShadowRoots(page: Page) {
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      return attach.call(this, { ...init, mode: 'open' });
    };
  });
}

async function expectNoSeriousA11yViolations(page: Page, include?: string) {
  const builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
  ]);
  const results = await (include ? builder.include(include) : builder).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

test('a widget message is echoed to the visitor and shows up live in the inbox', async ({
  page: owner,
  browser,
}) => {
  const text = `Do you have pandan cake? ${Date.now()}`;

  // Owner signs in (dev-only sign-in) and opens the inbox.
  await owner.goto('/sign-in');
  await owner.getByRole('button', { name: 'Sign in as the Kaki Bakery owner' }).click();
  await expect(owner).toHaveURL(/\/inbox$/);
  await expect(owner.getByTestId('tenant-name')).toHaveText('Kaki Bakery');
  await expect(owner.getByTestId('live-state')).toHaveText('Live');
  await expectNoSeriousA11yViolations(owner);

  // A visitor opens the host page and chats.
  // A separate browser context: the visitor shares no cookies or storage with the owner.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await openShadowRoots(visitor);
  await visitor.goto(WIDGET_HOST);
  await visitor.getByRole('button', { name: /^Chat with / }).click();
  const panel = visitor.getByRole('dialog');
  await expect(panel).toBeVisible();
  await panel.getByLabel('Message').fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();

  await expect(panel.locator('[data-author="visitor"]').filter({ hasText: text })).toBeVisible();
  await expect(
    panel.locator('[data-author="agent"]').filter({ hasText: `Echo: ${text}` }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(visitor, 'kaki-agent');

  // The inbox updated over the WebSocket: no reload happened on this page.
  const row = owner.getByTestId('conversation-row').filter({ hasText: `Echo: ${text}` });
  await expect(row).toBeVisible();
  await visitorContext.close();
});

test("the second tenant's owner cannot see the first tenant's conversations", async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: "Sign in as the second tenant's owner" }).click();
  await expect(page.getByTestId('tenant-name')).toHaveText('Second Tenant Pte Ltd');
  await expect(page.getByTestId('live-state')).toHaveText('Live');
  await expect(page.getByTestId('conversation-row').filter({ hasText: 'pandan' })).toHaveCount(0);
});

test('the shell is styled by the generated design tokens', async ({ page }) => {
  await page.goto('/sign-in');
  const button = page.getByRole('button', { name: 'Sign in as the Kaki Bakery owner' });
  // Without @kaki/design-tokens' CSS the variable is empty and the button unstyled.
  const { token, background } = await button.evaluate((el) => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--color-accent-default)';
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { token, background: getComputedStyle(el).backgroundColor };
  });
  expect(token).not.toBe('rgba(0, 0, 0, 0)');
  expect(background).toBe(token);
});
