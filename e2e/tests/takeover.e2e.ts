import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-043 (INB-02, INB-09, INB-01 by assignee; SCR-APP-015, SCR-APP-014, SCR-WGT-002):
 * a staff member takes over a widget chat, the visitor sees them join, the assistant stays
 * quiet, their reply reaches the widget with their name; a teammate sees who has it and
 * asks for it; the owner hands back and the assistant answers again. Two staff contexts on
 * the seeded bakery (the owner, and the agent "Mei Ling"), the fake model. The simultaneous
 * take-over race is covered by the integration suites.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const LIVE = { timeout: 2000 }; // AC-1: replies reach the widget in ≤ 2 s.
const AGENT = 'agent@kaki-bakery.test';
const OWNER = 'owner@kaki-bakery.test';

/** A visitor in their own context; `ask` waits for the assistant, `say` doesn't. */
async function visitorChat(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  const agentReplies = panel.locator('[data-author="agent"]:not([data-pending])');
  const say = async (text: string) => {
    await panel.getByLabel('Message').fill(text);
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel.locator('[data-author="visitor"]').last()).toContainText(text);
  };
  const ask = async (text: string) => {
    const before = await agentReplies.count();
    await say(text);
    await expect(agentReplies).toHaveCount(before + 1);
  };
  return { context, page, panel, agentReplies, say, ask };
}

async function startChat(visitor: Awaited<ReturnType<typeof visitorChat>>, text: string) {
  const created = visitor.page.waitForResponse(
    (r) => r.url().endsWith('/widget/v1/conversations') && r.request().method() === 'POST',
  );
  await visitor.ask(text);
  return ((await (await created).json()) as { conversationId: string }).conversationId;
}

async function staff(browser: Browser, email: string, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await signIn(page, email);
  return { context, page };
}

const dock = (page: Page) => page.getByTestId('thread-dock');

test('take over, reply, be asked to hand over, hand back (AC-1–AC-7, AC-10)', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const mei = await staff(browser, AGENT);
  const owner = await staff(browser, OWNER);
  const visitor = await visitorChat(browser);
  try {
    const id = await startChat(visitor, 'what are your opening hours?');

    // Mei Ling opens it from the inbox and takes over (AC-1).
    await mei.page.goto(`/inbox/${id}`);
    await expect(dock(mei.page)).toHaveAttribute('data-mode', 'ai');
    await expectNoSeriousA11yViolations(mei.page);
    await dock(mei.page).getByRole('button', { name: 'Take over' }).click();
    await expect(dock(mei.page)).toHaveAttribute('data-mode', 'mine');
    await expect(mei.page.getByLabel('Reply to visitor')).toBeFocused();
    await expect(mei.page.getByRole('status').filter({ hasText: 'You took over' })).toBeVisible();
    await expect(mei.page.getByTestId('thread-notice').first()).toHaveText(
      'Visitor saw: Mei Ling joined the chat.',
    );

    // The visitor sees her join; their next message gets no assistant reply (AC-2, AC-3).
    await expect(
      visitor.panel.locator('.notice', { hasText: 'Mei Ling joined the chat.' }),
    ).toBeVisible(LIVE);
    const replies = await visitor.agentReplies.count();
    await visitor.say('can I order a cake for saturday?');
    await expect(mei.page.getByTestId('thread-log')).toContainText('cake for saturday', LIVE);
    await visitor.page.waitForTimeout(5000);
    await expect(visitor.agentReplies).toHaveCount(replies);
    await expect(visitor.panel.getByText(/is typing/)).toHaveCount(0);

    // Her reply reaches the widget with her name (AC-1).
    await mei.page
      .getByLabel('Reply to visitor')
      .fill('Hi, Mei Ling here. Yes, we can do Saturday.');
    await mei.page.keyboard.press('Control+Enter');
    await expect(mei.page.getByLabel('Reply to visitor')).toHaveValue('');
    const staffBubble = visitor.panel.locator('[data-author="staff"]').last();
    await expect(staffBubble).toContainText('we can do Saturday', LIVE);
    await expect(staffBubble.locator('.who')).toHaveText(/Mei Ling/);
    await expect(
      mei.page.locator('[data-author="staff"]').last().locator('.bubble-meta'),
    ).toContainText('You');
    await expectNoSeriousA11yViolations(mei.page);

    // "Mine" lists it for her (AC-7); the owner sees it under Mei Ling.
    await mei.page.getByTestId('assignee-filter').selectOption('me');
    await expect(mei.page).toHaveURL(/assignee=me/);
    await expect(
      mei.page.locator(`[data-testid="conversation-row"][data-id="${id}"]`),
    ).toBeVisible();

    // The owner sees who has it, without Close; asks for it; Mei Ling is told (AC-6).
    await owner.page.goto(`/inbox/${id}`);
    await expect(dock(owner.page)).toHaveAttribute('data-mode', 'other');
    await expect(dock(owner.page)).toContainText('Mei Ling is handling this conversation.');
    await expect(owner.page.getByRole('button', { name: 'Close conversation' })).toHaveCount(0);
    const ownerRow = owner.page.locator(`[data-testid="conversation-row"][data-id="${id}"]`);
    await expect(ownerRow.getByTestId('conversation-owner')).toContainText('Mei Ling');
    // Owners can take it from her after confirming; cancel returns focus (D1).
    const takeFrom = dock(owner.page).getByRole('button', { name: 'Take over from Mei Ling' });
    await takeFrom.click();
    await expect(owner.page.getByRole('alertdialog')).toContainText(
      'Mei Ling can no longer reply here.',
    );
    await expectNoSeriousA11yViolations(owner.page);
    await owner.page.getByRole('button', { name: 'Cancel' }).click();
    await expect(takeFrom).toBeFocused();
    await dock(owner.page).getByRole('button', { name: 'Ask Mei Ling to hand over' }).click();
    await expect(dock(owner.page).getByRole('button', { name: /Request sent/ })).toBeDisabled();
    await expect(mei.page.getByText(/asks you to hand over a conversation/)).toBeVisible(LIVE);
    await expect(mei.page.getByTestId('thread-divider').last()).toContainText(
      'asked Mei Ling to hand over',
    );

    // She hands back: the visitor is told, and the assistant answers again (AC-4).
    await mei.page.getByRole('button', { name: 'Hand back to assistant' }).click();
    await expect(dock(mei.page)).toHaveAttribute('data-mode', 'ai');
    await expect(dock(mei.page).getByRole('button', { name: 'Take over' })).toBeFocused();
    await expect(
      visitor.panel.locator('.notice', { hasText: 'Mei Ling left the chat.' }),
    ).toBeVisible(LIVE);
    await expect(dock(owner.page)).toHaveAttribute('data-mode', 'ai', LIVE);
    await visitor.ask('what are your opening hours?');
    await expect(mei.page.locator(`[data-testid="conversation-row"][data-id="${id}"]`)).toHaveCount(
      0,
    );
    await openShadowRoots(visitor.page);
    await expectNoSeriousA11yViolations(visitor.page);
  } finally {
    await Promise.all([mei.context.close(), owner.context.close(), visitor.context.close()]);
  }
});

test('at phone width, take over, send and hand back from the menu (AC-10)', async ({ browser }) => {
  test.setTimeout(90_000);
  const mei = await staff(browser, AGENT, { width: 375, height: 5000 });
  const visitor = await visitorChat(browser);
  try {
    const id = await startChat(visitor, 'do you deliver?');
    await mei.page.goto(`/inbox/${id}`);
    await dock(mei.page).getByRole('button', { name: 'Take over' }).click();
    await expect(dock(mei.page)).toHaveAttribute('data-mode', 'mine');
    await mei.page.getByLabel('Reply to visitor').fill('Yes, island-wide.');
    await mei.page.getByRole('button', { name: 'Send' }).click();
    await expect(visitor.panel.locator('[data-author="staff"]').last()).toContainText(
      'island-wide',
      LIVE,
    );
    const noScroll = await mei.page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(noScroll).toBe(true);
    await expectNoSeriousA11yViolations(mei.page);
    await mei.page.getByRole('button', { name: 'More actions' }).click();
    await mei.page.getByRole('menuitem', { name: 'Hand back to assistant' }).click();
    await expect(dock(mei.page)).toHaveAttribute('data-mode', 'ai');
  } finally {
    await Promise.all([mei.context.close(), visitor.context.close()]);
  }
});
