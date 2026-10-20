import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * The walking-skeleton done-when (plan §2): a visitor message typed in the widget on
 * a host page gets the agent's reply in the widget, and the conversation appears in
 * the signed-in dashboard inbox without a reload. (FEAT-022 replaced the skeleton's
 * echo with grounded replies, so the reply is matched by author, not by text.) The path crosses every runtime role: api →
 * outbox → scheduler-worker → SQS → agent-worker → Valkey → realtime → both clients.
 */
const WIDGET_HOST = 'http://localhost:5175/';

test('a widget message gets a reply and shows up live in the inbox', async ({
  page: owner,
  browser,
}) => {
  const text = `Do you have pandan cake? ${Date.now()}`;

  // Owner signs in with an emailed link (FEAT-005) and lands in the inbox.
  await signIn(owner, 'owner@kaki-bakery.test');
  await expect(owner.getByTestId('tenant-name')).toHaveText('Kaki Bakery');
  await expect(owner.getByTestId('live-state')).toHaveText('Live');
  await expectNoSeriousA11yViolations(owner);
  const rows = owner.getByTestId('conversation-row');
  const before = await rows.count();

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
  const reply = panel.locator('[data-author="agent"]:not([data-pending])');
  await expect(reply).toBeVisible();
  const replyText = (await reply.innerText()).trim();
  await expectNoSeriousA11yViolations(visitor, 'kaki-agent');

  // The inbox updated over the WebSocket: no reload happened on this page.
  await expect(rows).toHaveCount(before + 1);
  await expect(rows.filter({ hasText: replyText }).first()).toBeVisible();
  await visitorContext.close();
});

test("the second tenant's owner cannot see the first tenant's conversations", async ({ page }) => {
  await signIn(page, 'owner@second-tenant.test');
  await expect(page.getByTestId('tenant-name')).toHaveText('Second Tenant Pte Ltd');
  await expect(page.getByTestId('live-state')).toHaveText('Live');
  await expect(page.getByTestId('conversation-row').filter({ hasText: 'pandan' })).toHaveCount(0);
});

test('the shell is styled by the generated design tokens', async ({ page }) => {
  await page.goto('/sign-in');
  const button = page.getByRole('button', { name: 'Email me a sign-in link' });
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
