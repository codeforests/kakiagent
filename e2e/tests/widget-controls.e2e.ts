import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-033 (CHN-13, CHN-02; SCR-WGT-002 menu, SCR-WGT-006): the visitor ends the chat
 * from the header menu by keyboard, the inbox lists it closed, Start a new chat opens a
 * new conversation; a Chinese reply switches the chrome to 中文; the privacy link shows
 * only when the config has one (stubbed: no tenant has one until FEAT-058). This spec only
 * creates conversations, so it restores nothing.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const SITES = 'http://localhost:5175/sites';
const DASHBOARD = 'http://localhost:5173';
const PRIVACY = 'https://kakibakery.test/privacy';

type Panel = ReturnType<Page['getByRole']>;

async function openPanel(page: Page, url = WIDGET_HOST) {
  await openShadowRoots(page);
  await page.goto(url);
  await page.getByRole('button', { name: /^Chat with / }).click();
  return page.getByRole('dialog');
}

async function ask(panel: Panel, text: string, nth: number, send = 'Send') {
  await panel.getByRole('textbox').fill(text);
  await panel.getByRole('button', { name: send }).click();
  const reply = panel.locator('[data-author="agent"]:not([data-pending])').nth(nth);
  await expect(reply).toBeVisible();
  return reply;
}

/** The conversation ID from the next create call (same-origin CORS, so a response). */
function nextConversation(page: Page) {
  return page
    .waitForResponse(
      (r) => r.url().endsWith('/widget/v1/conversations') && r.request().method() === 'POST',
    )
    .then(async (r) => ((await r.json()) as { conversationId: string }).conversationId);
}

/** The config with a privacy URL, read through `route.fetch()` (code-map E2E pitfalls). */
async function withPrivacyUrl(page: Page) {
  await page.route(/\/widget\/v1\/config/, async (route) => {
    const res = await route.fetch();
    const body = { ...((await res.json()) as object), privacyNoticeUrl: PRIVACY };
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
}

test('the visitor ends the chat by keyboard and starts a new one', async ({ page, browser }) => {
  const created = nextConversation(page);
  const panel = await openPanel(page);
  // No conversation and no privacy URL: nothing to offer, so no menu button.
  await expect(panel.getByRole('button', { name: 'Chat options' })).toHaveCount(0);
  await ask(panel, 'What time do you open on Saturday?', 0);
  const conversationId = await created;

  // Menu-button pattern: ArrowDown opens on the first item; Escape closes the menu only.
  const menuButton = panel.getByRole('button', { name: 'Chat options' });
  await menuButton.focus();
  await page.keyboard.press('ArrowDown');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  const endItem = panel.getByRole('menuitem', { name: 'End chat' });
  await expect(endItem).toBeFocused();
  await expectNoSeriousA11yViolations(page, 'kaki-agent');
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('menu')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(menuButton).toBeFocused();

  // Confirm card: focus on its title; Keep chatting returns focus to the menu button.
  await page.keyboard.press('Enter');
  await expect(endItem).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = panel.getByRole('group', { name: 'End this chat?' });
  await expect(confirm.getByRole('heading', { name: 'End this chat?' })).toBeFocused();
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'kaki-agent');
  await confirm.getByRole('button', { name: 'Keep chatting' }).click();
  await expect(panel.getByRole('textbox')).toBeEnabled();
  await expect(menuButton).toBeFocused();

  // End it: the done card, and the menu no longer offers End chat.
  await page.keyboard.press('ArrowUp');
  await expect(endItem).toBeFocused();
  await page.keyboard.press('Enter');
  await confirm.getByRole('button', { name: 'End chat' }).click();
  const done = panel.getByRole('group', { name: 'Chat ended' });
  await expect(done.getByRole('heading', { name: 'Chat ended' })).toBeFocused();
  await expect(done).toContainText('The business keeps a record of this chat.');
  await expect(panel.getByRole('button', { name: 'Chat options' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'kaki-agent');

  // The owner's inbox lists it closed (AC-1).
  const context = await browser.newContext();
  try {
    const dashboard = await context.newPage();
    await signIn(dashboard, 'owner@kaki-bakery.test');
    const res = await dashboard.request.get(`${DASHBOARD}/api/v1/conversations`);
    expect(res.ok()).toBe(true);
    const { conversations } = (await res.json()) as {
      conversations: { id: string; status: string }[];
    };
    expect(conversations.find((c) => c.id === conversationId)).toMatchObject({
      status: 'closed',
    });
  } finally {
    await context.close();
  }

  // Start a new chat: the greeting again, and the next message opens a new conversation.
  await done.getByRole('button', { name: 'Start a new chat' }).click();
  await expect(panel.locator('ol.log > li.empty')).toBeVisible();
  await expect(panel.getByRole('textbox')).toBeFocused();
  const again = nextConversation(page);
  await ask(panel, 'Do you deliver?', 0);
  expect(await again).not.toBe(conversationId);
});

test('a Chinese reply switches the chrome to 中文 and an English one switches it back', async ({
  page,
}) => {
  const panel = await openPanel(page);
  const mountLang = () => panel.evaluate((el) => el.parentElement?.getAttribute('lang'));
  expect(await mountLang()).toBe('en');
  await ask(panel, '请问周末营业时间？', 0);
  await expect(panel.getByRole('button', { name: '发送' })).toBeVisible();
  await expect(panel.getByRole('textbox')).toHaveAttribute('placeholder', '输入您的消息');
  await expect(panel.getByRole('button', { name: '聊天选项' })).toBeVisible();
  expect(await mountLang()).toBe('zh-Hans');
  await ask(panel, 'What are your weekend hours?', 1, '发送');
  await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible();
  expect(await mountLang()).toBe('en');
});

test('the privacy notice opens in a new tab from the menu and the footer', async ({ page }) => {
  await withPrivacyUrl(page);
  // A dark host page (the wix fixture): axe in the dark theme too (AC-8).
  const panel = await openPanel(page, `${SITES}/wix.html`);
  const footer = panel.locator('p.foot').getByRole('link', {
    name: 'Privacy notice (opens in a new tab)',
  });
  await expect(footer).toHaveAttribute('href', PRIVACY);
  await expect(footer).toHaveAttribute('target', '_blank');
  await expect(footer).toHaveAttribute('rel', 'noopener noreferrer');

  // Before a conversation the menu holds only the privacy item.
  const menuButton = panel.getByRole('button', { name: 'Chat options' });
  await menuButton.focus();
  await page.keyboard.press('Enter');
  const item = panel.getByRole('menuitem', { name: 'Privacy notice (opens in a new tab)' });
  await expect(item).toBeFocused();
  await expect(panel.getByRole('menuitem')).toHaveCount(1);
  await expect(item).toHaveAttribute('href', PRIVACY);
  await expect(item).toHaveAttribute('target', '_blank');
  await expect(item).toHaveAttribute('rel', 'noopener noreferrer');
  await expectNoSeriousA11yViolations(page, 'kaki-agent');
  // Tab leaves the menu and closes it.
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('menu')).toHaveCount(0);
});
