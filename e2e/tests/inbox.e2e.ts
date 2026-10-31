import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-042 (INB-01, INB-04, INB-08, AGT-13; SCR-APP-014, SCR-APP-015): a widget chat
 * reaches the inbox list and the open thread live, with its fact chips and context
 * sidebar; staff close it, a new visitor message reopens it; a crisis message lists it
 * under Flagged; at phone width the list, thread and details sheet work one at a time.
 * Against the seeded bakery and the fake model. Auto-close (30 minutes) is covered by
 * the integration suites.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const LIVE = { timeout: 2000 }; // INB-01: new messages appear in ≤ 2 s without refreshing.

const token = () =>
  Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
    '',
  );

async function createFact(page: Page, name: string, price: string): Promise<string> {
  return page.evaluate(
    async ({ n, p }) => {
      const res = await fetch('/api/v1/kb/facts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'product',
          value: { name: n, price: p },
          gstTreatment: 'inclusive',
        }),
      });
      return ((await res.json()) as { fact: { id: string } }).fact.id;
    },
    { n: name, p: price },
  );
}

/** A visitor in their own browser context; returns the panel, a send helper and the conversation ID. */
async function visitorChat(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  let replies = 0;
  const send = async (text: string) => {
    await panel.getByLabel('Message').fill(text);
    await panel.getByRole('button', { name: 'Send' }).click();
    const reply = panel.locator('[data-author="agent"]:not([data-pending])').nth(replies++);
    await expect(reply).toBeVisible();
    return reply;
  };
  return { context, page, panel, send };
}

async function firstMessage(page: Page, send: (t: string) => Promise<unknown>, text: string) {
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/widget/v1/conversations') && r.request().method() === 'POST',
  );
  await send(text);
  return ((await (await created).json()) as { conversationId: string }).conversationId;
}

test('a widget chat shows live in the inbox and thread; close, then a new message reopens it', async ({
  page: owner,
  browser,
}) => {
  await owner.setViewportSize({ width: 1440, height: 900 });
  const name = `Kueh lapis ${token()}`;
  await signIn(owner, 'owner@kaki-bakery.test');
  await createFact(owner, name, '18');
  await owner.goto('/inbox');
  await expect(owner.getByTestId('live-state')).toHaveText('Live');

  // A visitor asks; the row arrives in the Open list without a reload.
  const visitor = await visitorChat(browser);
  const id = await firstMessage(
    visitor.page,
    visitor.send,
    `how much is the ${name.toLowerCase()}?`,
  );
  const row = owner.locator(`[data-testid="conversation-row"][data-id="${id}"]`);
  await expect(row).toBeVisible(LIVE);
  await expect(row.getByTestId('conversation-preview')).toContainText('S$18.00', LIVE);
  await expect(row.getByTestId('state-chip')).toHaveText('AI handling');
  await expectNoSeriousA11yViolations(owner);

  // The thread: both messages, the answer's fact chip, and the sidebar (AC-4).
  await row.getByRole('link').click();
  await expect(owner).toHaveURL(new RegExp(`/inbox/${id}$`));
  const log = owner.getByRole('log', { name: 'Conversation' });
  await expect(log.locator('[data-author="visitor"]')).toContainText(name.toLowerCase());
  await expect(log.locator('[data-author="agent"]')).toContainText('S$18.00');
  await expect(log.getByTestId('fact-chip')).toHaveText(`Used: ${name}`);
  const sidebar = owner.getByRole('complementary', { name: 'Conversation details' });
  await expect(sidebar).toContainText('Website visitor');
  await expect(sidebar).toContainText('Website chat');
  await expect(sidebar).toContainText('Asked questions');
  await expect(sidebar.getByRole('link', { name })).toHaveAttribute('href', /\/knowledge\/facts\//);
  await expectNoSeriousA11yViolations(owner);

  // A new message reaches the open thread live (AC-1).
  await visitor.send('and do you deliver?');
  await expect(
    log.locator('[data-author="visitor"]').filter({ hasText: 'do you deliver' }),
  ).toBeVisible(LIVE);

  // Close (AC-7, AC-8): toast, chip, divider and dock; the row moves to Closed.
  await owner.getByRole('button', { name: 'Close conversation' }).click();
  await expect(owner.getByRole('status').filter({ hasText: 'Conversation closed' })).toBeVisible();
  await expect(owner.locator('.thread-header').getByTestId('state-chip')).toHaveText('Closed');
  await expect(
    owner.getByTestId('thread-divider').filter({ hasText: /^Closed by / }),
  ).toBeVisible();
  await expect(owner.getByTestId('thread-dock')).toContainText(
    'A new message from the visitor reopens it.',
  );
  await expect(row).toHaveCount(0);
  await owner
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: /^Closed/ })
    .click();
  await expect(owner).toHaveURL(/\?view=closed/);
  await expect(row).toBeVisible();

  // The visitor writes again: the same conversation reopens to AI handling.
  await visitor.send('one more question, are you open on sunday?');
  await expect(row).toHaveCount(0, LIVE);
  await owner
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: /^Open/ })
    .click();
  await expect(owner).toHaveURL(new RegExp(`/inbox/${id}$`));
  await expect(row.getByTestId('state-chip')).toHaveText('AI handling');
  await expect(
    owner.getByTestId('thread-divider').filter({ hasText: 'Reopened by a new visitor message' }),
  ).toBeVisible();
  await visitor.context.close();
});

test('a crisis message lists the conversation under Flagged (AGT-13)', async ({
  page: owner,
  browser,
}) => {
  await signIn(owner, 'owner@kaki-bakery.test');
  const visitor = await visitorChat(browser);
  const id = await firstMessage(visitor.page, visitor.send, `i want to kill myself ${token()}`);
  await visitor.context.close();

  await owner.goto('/inbox?view=flagged');
  const row = owner.locator(`[data-testid="conversation-row"][data-id="${id}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('flagged-chip')).toHaveText('Flagged');
  await row.getByRole('link').click();
  await expect(
    owner.getByTestId('thread-divider').filter({ hasText: 'Flagged: crisis message' }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(owner);
});

test('at phone width the list, thread and details sheet work one at a time', async ({
  page: owner,
  browser,
}) => {
  // A tall viewport: the fixed tab bar would otherwise overlap targets (axe target-size).
  await owner.setViewportSize({ width: 375, height: 1400 });
  await signIn(owner, 'owner@kaki-bakery.test');
  const visitor = await visitorChat(browser);
  const id = await firstMessage(visitor.page, visitor.send, `are you open today? ${token()}`);
  await visitor.context.close();

  await owner.goto('/inbox');
  const row = owner.locator(`[data-testid="conversation-row"][data-id="${id}"]`);
  await expect(row).toBeVisible();
  await expectNoSeriousA11yViolations(owner);
  const noHorizontalScroll = () =>
    owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noHorizontalScroll()).toBe(true);

  await row.getByRole('link').click();
  await expect(owner.getByRole('log', { name: 'Conversation' })).toBeVisible();
  await expect(owner.getByTestId('conversation-list')).toBeHidden();
  expect(await noHorizontalScroll()).toBe(true);
  await expectNoSeriousA11yViolations(owner);

  const details = owner.getByRole('button', { name: 'Conversation details' });
  await details.click();
  const sheet = owner.getByRole('dialog', { name: 'Conversation details' });
  await expect(sheet).toContainText('Website chat');
  await expectNoSeriousA11yViolations(owner);
  await owner.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(details).toBeFocused();

  // Close sits in the More actions menu below 640.
  await owner.getByRole('button', { name: 'More actions' }).click();
  await owner.getByRole('menuitem', { name: 'Close conversation' }).click();
  await expect(owner.locator('.thread-header').getByTestId('state-chip')).toHaveText('Closed');

  await owner.getByRole('link', { name: 'Back to inbox' }).click();
  await expect(owner).toHaveURL(/\/inbox$/);
  await expect(owner.getByTestId('conversation-list')).toBeVisible();
});
