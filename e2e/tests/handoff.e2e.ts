import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  emailWithSubject,
  expectNoSeriousA11yViolations,
  openShadowRoots,
  signIn,
} from './support.ts';

/**
 * FEAT-038 §6 (CHN-07, UC-26; SCR-WGT-004, SCR-WGT-002 moved, SCR-APP-015): a widget visitor
 * continues the same conversation by email (the agent's card, the confirmation email, the
 * hosted confirm page, the recap email) and on Telegram (the menu's card, the deep link's
 * `/start c-…` through the fake Bot API); the open widget shows the moved state without a
 * reload, and the inbox shows the "Moved to …" divider and the recap.
 *
 * Telegram is `scripts/telegram-fake.mjs` (:5177); each run uses its own bot and chat IDs.
 * `afterEach` takes email offline and disconnects the bot, so later specs find the dev tenant
 * as before. Chat text has no digits (the fake triage reads the first number as a quantity).
 */
const WIDGET_HOST = 'http://localhost:5175/';
const OWNER = 'owner@kaki-bakery.test';
const FAKE = 'http://localhost:5177';
const CARD = 'Continue this chat elsewhere';

// Letters only: the fake triage reads the first number in a message as a quantity.
const tag = () =>
  Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
    '',
  );
const randomId = (digits: number) =>
  Number(
    String(1 + Math.floor(Math.random() * 9)) +
      Array.from({ length: digits - 1 }, () => Math.floor(Math.random() * 10)).join(''),
  );

type Panel = ReturnType<Page['getByRole']>;
interface Connection {
  id: string;
  state: string;
  version: number;
}

async function say(panel: Panel, text: string) {
  await panel.getByLabel('Message', { exact: true }).fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
}

/** A visitor in a fresh browser context with the widget open. */
async function openWidget(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  return { page, panel: page.getByRole('dialog') };
}

/** The widget passes axe at desktop and at phone width (tall: the log grows). */
async function widgetA11y(page: Page) {
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 375, height: 5000 });
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function goLive(page: Page, connection: Connection | null) {
  expect(connection).not.toBeNull();
  if (connection!.state === 'live') return;
  const res = await page.request.post(`/api/v1/channels/${connection!.id}/live`, {
    data: { version: connection!.version },
  });
  expect(res.ok()).toBe(true);
}

async function emailConnection(page: Page): Promise<Connection | null> {
  const res = await page.request.get('/api/v1/channels/email');
  return ((await res.json()) as { connection: Connection | null }).connection;
}
async function telegramView(page: Page) {
  const res = await page.request.get('/api/v1/channels/telegram');
  return (await res.json()) as {
    connected: boolean;
    connection: Connection | null;
    settingsVersion: number;
  };
}

/** Email offline, Telegram disconnected: the dev tenant as the other specs expect it. */
async function restore(page: Page) {
  const email = await emailConnection(page);
  if (email?.state === 'live')
    await page.request.post(`/api/v1/channels/${email.id}/offline`, {
      data: { version: email.version },
    });
  const tg = await telegramView(page);
  if (tg.connection?.state === 'live')
    await page.request.post(`/api/v1/channels/${tg.connection.id}/offline`, {
      data: { version: tg.connection.version },
    });
  if (tg.connected) {
    const fresh = await telegramView(page);
    await page.request.delete('/api/v1/channels/telegram', {
      data: { settingsVersion: fresh.settingsVersion },
    });
  }
}

/** The conversation whose visitor wrote `run`. */
async function conversationOf(page: Page, run: string): Promise<string> {
  let id = '';
  await expect(async () => {
    const res = await page.request.post('/api/v1/conversations/search', { data: { q: run } });
    const { results } = (await res.json()) as { results: { conversation: { id: string } }[] };
    expect(results).toHaveLength(1);
    id = results[0]!.conversation.id;
  }).toPass({ timeout: 15_000 });
  return id;
}

test.describe.configure({ mode: 'serial' });

let ownerPage: Page | null = null;
test.afterEach(async () => {
  if (ownerPage) await restore(ownerPage);
  ownerPage = null;
});

test('a widget visitor continues the same chat by email (AC-6, AC-7, AC-8, AC-11, AC-12)', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const run = tag();
  const address = `handoff.${run}@example.test`;
  await signIn(page, OWNER);
  ownerPage = page;
  await restore(page);
  if (!(await emailConnection(page))) {
    const created = await page.request.post('/api/v1/channels/email');
    expect(created.ok()).toBe(true);
  }
  await goLive(page, await emailConnection(page));

  // The agent offers the card (AC-9's stored card); only email is live.
  const visitor = await openWidget(browser);
  const { panel } = visitor;
  await say(panel, `Hello ${run}, can you email me instead?`);
  const card = panel.getByRole('group', { name: CARD });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('button', { name: 'Continue on Telegram' })).toHaveCount(0);
  await widgetA11y(visitor.page);

  // The email form: a malformed address is caught on the field (AC-12).
  await card.getByRole('button', { name: 'Continue by email' }).click();
  const field = card.getByLabel('Your email');
  await expect(field).toBeFocused();
  await field.fill('not an email');
  await card.getByRole('button', { name: 'Send link' }).click();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(card.getByText('Enter an email address, like hello@example.com')).toBeVisible();
  await widgetA11y(visitor.page);

  // Sent: the masked address; the confirmation email holds the one-time link (AC-6).
  const since = new Date();
  await field.fill(address);
  await card.getByRole('button', { name: 'Send link' }).click();
  await expect(card.getByText(/Check your inbox at h\*\*\*@example\.test/)).toBeVisible();
  await widgetA11y(visitor.page);
  const confirm = await emailWithSubject(address, since, 'Continue your chat with');
  const link = /https?:\/\/\S+\/continue\/[\w.-]+/.exec(confirm)?.[0];
  expect(link).toBeTruthy();

  // The hosted confirm page: GET never consumes, the POST moves the chat (AC-7).
  const confirmPage = await visitor.page.context().newPage();
  await confirmPage.goto(link!);
  await confirmPage.reload();
  await expect(confirmPage.getByRole('heading', { level: 1 })).toHaveText('Continue by email');
  await expectNoSeriousA11yViolations(confirmPage);
  await confirmPage.getByRole('button', { name: 'Continue by email' }).click();
  await expect(confirmPage.getByRole('heading', { level: 1 })).toHaveText("You're all set");
  await expectNoSeriousA11yViolations(confirmPage);
  // A second use shows the expired page.
  await confirmPage.goto(link!);
  await expect(confirmPage.getByRole('heading', { level: 1 })).toHaveText('This link has expired');
  await confirmPage.close();

  // The recap arrives as the thread's first email (AC-7).
  const recap = await emailWithSubject(address, since, 'Your chat with');
  expect(recap).toContain(run);

  // The open widget shows the moved state without a reload (AC-8).
  await expect(panel.getByText('This chat continues by email.')).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText('Reply to our email to carry on.')).toBeVisible();
  await expect(panel.getByLabel('Message', { exact: true })).toHaveCount(0);
  await widgetA11y(visitor.page);

  // The inbox: the divider and the recap on the same conversation (AC-11).
  const conversationId = await conversationOf(page, run);
  await page.goto(`/inbox/${conversationId}`);
  await expect(
    page.getByTestId('thread-divider').filter({ hasText: 'Moved to email' }),
  ).toBeVisible();
  const recapRow = page.getByTestId('thread-recap');
  await expect(recapRow).toContainText('Recap sent by email');
  await expectNoSeriousA11yViolations(page);

  // Start a new chat here: a fresh widget conversation (AC-8).
  await panel.getByRole('button', { name: 'Start a new chat here' }).click();
  await expect(panel.getByLabel('Message', { exact: true })).toBeFocused();
  await visitor.page.context().close();
});

test('a widget visitor continues the same chat on Telegram (AC-1, AC-3, AC-8, AC-11, AC-12)', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const run = tag();
  const botId = randomId(9);
  const username = `kaki_${botId}_bot`;
  await signIn(page, OWNER);
  ownerPage = page;
  await restore(page);
  const connected = await page.request.post('/api/v1/channels/telegram', {
    data: { token: `${botId}:fixture${tag()}${'x'.repeat(30)}` },
  });
  expect(connected.ok()).toBe(true);
  await goLive(page, (await telegramView(page)).connection);

  // From the menu (AC-1: only Telegram is live, so the item names it).
  const visitor = await openWidget(browser);
  const { panel } = visitor;
  await say(panel, `Hello ${run}, what time do you open?`);
  await expect(panel.locator('[data-author="agent"]').first()).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('button', { name: 'Chat options' }).click();
  await panel.getByRole('menuitem', { name: 'Continue on Telegram' }).click();
  const card = panel.getByRole('group', { name: CARD });
  await expect(card.getByRole('button', { name: 'Continue on Telegram' })).toBeFocused();
  await widgetA11y(visitor.page);

  // The deep link: a new tab, the bot's `start` code (AC-2).
  await card.getByRole('button', { name: 'Continue on Telegram' }).click();
  const open = card.getByRole('link', { name: /Open Telegram/ });
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute('target', '_blank');
  const href = (await open.getAttribute('href'))!;
  expect(href).toMatch(new RegExp(`^https://t\\.me/${username}\\?start=c-`));
  const code = new URL(href).searchParams.get('start')!;
  await widgetA11y(visitor.page);

  // The customer taps Start: the same conversation moves and the recap reaches the chat (AC-3).
  const customer = randomId(9);
  const chat = {
    from: { id: customer, is_bot: false, first_name: 'Siti', language_code: 'en' },
    chat: { id: customer, first_name: 'Siti', type: 'private' },
  };
  let updateId = randomId(6);
  const deliver = async (text: string) => {
    const res = await fetch(`${FAKE}/_fake/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        botId,
        update: {
          update_id: updateId++,
          message: { message_id: updateId, date: 0, ...chat, text },
        },
      }),
    });
    return ((await res.json()) as { status: number }).status;
  };
  expect(await deliver(`/start ${code}`)).toBe(200);
  await expect(async () => {
    const sent = (await (await fetch(`${FAKE}/_fake/sent?botId=${botId}`)).json()) as {
      method: string;
      chatId: number;
      text?: string;
    }[];
    expect(sent.some((s) => s.chatId === customer && s.method === 'sendMessage')).toBe(true);
  }).toPass({ timeout: 30_000 });

  // The open widget shows the moved state without a reload (AC-8).
  await expect(panel.getByText('This chat continues on Telegram.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(panel.getByRole('link', { name: /Open Telegram/ }).last()).toHaveAttribute(
    'href',
    `https://t.me/${username}`,
  );
  await expect(panel.getByLabel('Message', { exact: true })).toHaveCount(0);
  await widgetA11y(visitor.page);

  // The customer's next Telegram message joins the same conversation (AC-3).
  const followUp = `Thanks ${run}, see you soon`;
  expect(await deliver(followUp)).toBe(200);
  const conversationId = await conversationOf(page, run);
  await page.goto(`/inbox/${conversationId}`);
  await expect(page.getByTestId('thread-message').filter({ hasText: followUp })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByTestId('thread-divider').filter({ hasText: 'Moved to Telegram' }),
  ).toBeVisible();
  await expect(page.getByTestId('thread-recap')).toContainText('Recap sent on Telegram');
  await expectNoSeriousA11yViolations(page);
  // Every reply has gone out before `afterEach` disconnects the bot: a send after it is
  // rejected and leaves Telegram degraded, and its banner would follow every later spec.
  await expect(async () => {
    const res = await page.request.get(`/api/v1/conversations/${conversationId}`);
    const { messages } = (await res.json()) as {
      messages: { author: string; delivery?: { status: string } | null }[];
    };
    expect(messages.some((m) => m.author === 'agent' && m.delivery?.status === 'sent')).toBe(true);
    expect(messages.filter((m) => m.delivery?.status === 'sending')).toEqual([]);
  }).toPass({ timeout: 30_000 });
  await visitor.page.context().close();
});
