import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, signIn } from './support.ts';

/**
 * FEAT-037 AC-2, AC-3, AC-5, AC-6, AC-8 (CHN-05, CHN-12, LED-04; SCR-APP-039, SCR-APP-036,
 * SCR-APP-056, SCR-APP-014): the Owner connects a bot and goes live; a private message gets an
 * AI reply through the Bot API and lands in the inbox; a staff reply is sent; a group gets one
 * reply and the bot leaves; the Owner links Telegram for alerts with the `start` code and an
 * escalation reaches it; a revoked token shows as degraded after a check.
 *
 * Telegram is `scripts/telegram-fake.mjs` (:5177, started by the Playwright config). Each run
 * uses its own bot ID and chat IDs, so the three browsers don't see each other's messages;
 * `afterEach` disconnects the bot and restores the alert settings, so later specs find the dev
 * tenant as before (no Telegram column on Notifications).
 */
const OWNER = 'owner@kaki-bakery.test';
const FAKE = 'http://localhost:5177';
const ROUND_ROBIN = { mode: 'round_robin', personUserId: null, reminderMinutes: 10 };
// The seeded alert defaults (FEAT-052): every event on, quiet hours 22:00–08:00.
const DEFAULT_PREFS = {
  events: [
    { event: 'escalation', email: true },
    { event: 'approval_pending', email: true },
    { event: 'hot_lead', email: true },
    { event: 'consent_withdrawn', email: true },
  ],
  quietHours: { enabled: true, start: '22:00', end: '08:00' },
};

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
const tokenFor = (botId: number) => `${botId}:fixture${tag()}${'x'.repeat(30)}`;

interface Sent {
  method: 'sendMessage' | 'leaveChat';
  chatId: number;
  text?: string;
}
const sentTo = async (botId: number, chatId: number): Promise<Sent[]> =>
  ((await (await fetch(`${FAKE}/_fake/sent?botId=${botId}`)).json()) as Sent[]).filter(
    (s) => s.chatId === chatId,
  );
/** Waits until the bot has sent `count` calls to `chatId`; returns them. */
async function waitSent(botId: number, chatId: number, count: number): Promise<Sent[]> {
  for (let i = 0; i < 120; i++) {
    const list = await sentTo(botId, chatId);
    if (list.length >= count) return list;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`fewer than ${count} Bot API calls to chat ${chatId}`);
}

let updateId = randomId(6);
/** Telegram delivers an update to the bot's webhook; answers the hook's status. */
async function deliver(botId: number, message: Record<string, unknown>) {
  const res = await fetch(`${FAKE}/_fake/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      botId,
      update: { update_id: updateId++, message: { message_id: updateId, date: 0, ...message } },
    }),
  });
  return ((await res.json()) as { status: number }).status;
}
const privateChat = (id: number, first: string, username: string) => ({
  from: { id, is_bot: false, first_name: first, username, language_code: 'en' },
  chat: { id, first_name: first, username, type: 'private' },
});

/** Disconnects the bot (if any) and puts the Owner's alerts and escalation routing back. */
async function restore(page: Page) {
  const res = await page.request.get('/api/v1/channels/telegram');
  if (res.ok()) {
    const tg = (await res.json()) as {
      connected: boolean;
      connection: { id: string; state: string; version: number } | null;
      settingsVersion: number;
    };
    if (tg.connection?.state === 'live')
      await page.request.post(`/api/v1/channels/${tg.connection.id}/offline`, {
        data: { version: tg.connection.version },
      });
    if (tg.connected) {
      const fresh = (await (await page.request.get('/api/v1/channels/telegram')).json()) as {
        settingsVersion: number;
      };
      await page.request.delete('/api/v1/channels/telegram', {
        data: { settingsVersion: fresh.settingsVersion },
      });
    }
  }
  await page.request.delete('/api/v1/me/notifications/telegram');
  await page.request.put('/api/v1/me/notifications', { data: DEFAULT_PREFS });
  await page.request.put('/api/v1/settings/escalation', { data: ROUND_ROBIN });
}

test.describe.configure({ mode: 'serial' });

let ownerPage: Page | null = null;
test.afterEach(async () => {
  if (ownerPage) await restore(ownerPage);
  ownerPage = null;
});

test('the Owner connects a Telegram bot, customers get AI replies, and alerts reach Telegram', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const run = tag();
  const botId = randomId(9);
  const token = tokenFor(botId);
  const username = `kaki_${botId}_bot`;
  await signIn(page, OWNER);
  ownerPage = page;
  await restore(page);

  // Connect (AC-1, AC-8): a malformed token is caught on the field, the fixture one connects.
  await page.goto('/settings/channels/telegram');
  await expect(page.getByRole('heading', { level: 1, name: 'Telegram' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect your bot' })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 5000 });
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const field = page.getByLabel('Bot token');
  await field.fill('not a token');
  await page.getByRole('button', { name: 'Connect bot' }).click();
  await expect(page.locator('.field__error')).toContainText("doesn't look like a bot token");
  await expect(field).toBeFocused();
  await field.fill(token);
  await page.getByRole('button', { name: 'Connect bot' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `@${username} is connected` }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kaki Bot' })).toBeFocused();
  await expect(page.getByTestId('telegram-username')).toHaveText(`@${username}`);
  await expect(page.getByTestId('telegram-status')).toContainText('Offline');
  await page.setViewportSize({ width: 375, height: 5000 });
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Go live on Channels: the Telegram card names the bot and links back.
  await page.getByRole('link', { name: 'Channels', exact: true }).last().click();
  const card = page.getByRole('region', { name: 'Telegram', exact: true });
  await expect(card.getByText(`@${username}`)).toBeVisible();
  await expect(card.getByRole('link', { name: 'Telegram settings' })).toBeVisible();
  await card.getByRole('button', { name: 'Go live' }).click();
  await page
    .getByRole('alertdialog', { name: 'Go live on Telegram?' })
    .getByRole('button', { name: 'Go live' })
    .click();
  await expect(card.getByText('Live', { exact: true })).toBeVisible();

  // A private message gets an AI reply through the Bot API (AC-2) and lands in the inbox.
  const customer = randomId(9);
  const question = `Hello ${run}, what time do you open?`;
  expect(
    await deliver(botId, { ...privateChat(customer, 'Siti', `siti${run}`), text: question }),
  ).toBe(200);
  const [aiReply] = await waitSent(botId, customer, 1);
  expect(aiReply!.method).toBe('sendMessage');
  expect(aiReply!.text?.length).toBeGreaterThan(0);

  // The row's preview is the AI reply, so find the conversation by the customer's words.
  let conversationId = '';
  await expect(async () => {
    const res = await page.request.post('/api/v1/conversations/search', { data: { q: run } });
    const { results } = (await res.json()) as { results: { conversation: { id: string } }[] };
    expect(results).toHaveLength(1);
    conversationId = results[0]!.conversation.id;
  }).toPass({ timeout: 15_000 });
  await page.goto('/inbox?channel=telegram');
  const row = page.locator(`[data-testid="conversation-row"][data-id="${conversationId}"]`);
  await expect(row).toHaveCount(1);
  await row.getByRole('link').click();
  await expect(page.locator('.thread-header__caption')).toContainText(`On Telegram · @siti${run}`);
  await expect(page.getByTestId('context-sidebar')).toContainText(`@siti${run}`);

  // A staff reply is sent to the same chat (AC-4).
  await page.getByRole('button', { name: 'Take over' }).click();
  const staffText = `We open at nine, ${run}.`;
  await page.getByLabel('Reply to visitor').fill(staffText);
  await page.getByRole('button', { name: 'Send' }).click();
  const afterStaff = await waitSent(botId, customer, 2);
  expect(afterStaff.some((s) => s.text === staffText)).toBe(true);
  await expectNoSeriousA11yViolations(page);

  // A group message gets the one reply and the bot leaves (AC-3).
  const group = -randomId(10);
  expect(
    await deliver(botId, {
      from: { id: customer, is_bot: false, first_name: 'Siti' },
      chat: { id: group, title: `Group ${run}`, type: 'group' },
      text: 'hello bot',
    }),
  ).toBe(200);
  const inGroup = await waitSent(botId, group, 2);
  expect(inGroup.map((s) => s.method).sort()).toEqual(['leaveChat', 'sendMessage']);

  // Alerts on Telegram (AC-6): the Owner links with the `start` code, then an escalation
  // reaches their chat. Quiet hours off so an evening run isn't held for the digest.
  const me = (await (await page.request.get('/api/v1/me')).json()) as { user: { id: string } };
  await page.request.put('/api/v1/settings/escalation', {
    data: { mode: 'person', personUserId: me.user.id, reminderMinutes: 10 },
  });
  await page.goto('/settings/channels/telegram');
  const alerts = page.getByTestId('telegram-alerts');
  await alerts.getByRole('button', { name: 'Link my Telegram' }).click();
  const href = await alerts.getByTestId('telegram-link').getAttribute('href');
  const code = new URL(href!).searchParams.get('start');
  expect(code).toMatch(/^link-/);
  const ownerChat = randomId(9);
  expect(
    await deliver(botId, { ...privateChat(ownerChat, 'Ken', `ken${run}`), text: `/start ${code}` }),
  ).toBe(200);
  await expect(alerts.getByTestId('telegram-linked')).toContainText(
    'Alerts go to Ken on Telegram',
    {
      timeout: 30_000,
    },
  );
  await expect(page.getByRole('heading', { name: 'Get your alerts on Telegram' })).toBeFocused();
  // The bot confirms the link in that chat.
  const [confirm] = await waitSent(botId, ownerChat, 1);
  expect(confirm!.text).toContain("You'll get");
  await page.setViewportSize({ width: 375, height: 5000 });
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  // My notifications shows the Telegram column, switches on now it's linked.
  await page.request.put('/api/v1/me/notifications', {
    data: {
      events: [{ event: 'escalation', email: true, telegram: true }],
      quietHours: { enabled: false, start: '22:00', end: '08:00' },
    },
  });
  await page.goto('/account/notifications');
  await expect(page.getByTestId('notif-telegram-help')).toContainText('and to Telegram (Ken)');
  await expect(
    page.getByRole('switch', { name: 'Telegram alerts: A customer asks for a person' }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 375, height: 5000 });
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  const before = (await sentTo(botId, ownerChat)).length;
  const asker = randomId(9);
  await deliver(botId, {
    ...privateChat(asker, 'Ali', `ali${run}`),
    text: `Can I talk to a person please, ${run}?`,
  });
  await expect(async () => {
    const texts = (await sentTo(botId, ownerChat)).slice(before).map((s) => s.text ?? '');
    expect(texts.some((t) => /talk to a person/.test(t))).toBe(true);
  }).toPass({ timeout: 60_000 });
  // Ali's escalation notice goes out on its own path from the owner's alert. Revoking before it
  // is sent has it rejected: a `send_rejected` degrade and a Telegram alert retried on the
  // revoked bot, each of which marks the channel just checked, so "Check again" stays 429.
  await waitSent(botId, asker, 1);

  // A revoked token shows as degraded after a check (AC-5), with the Replace action.
  await fetch(`${FAKE}/_fake/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const tg = (await (await page.request.get('/api/v1/channels/telegram')).json()) as {
    connection: { id: string };
  };
  // "Check again" is 429 within 30 s of the last health check (connect, go-live or the
  // health job may have just run), so retry until the check itself runs.
  await expect(async () => {
    const res = await page.request.post(`/api/v1/channels/${tg.connection.id}/check`);
    expect(res.status()).toBe(200);
  }).toPass({ timeout: 60_000, intervals: [5_000] });
  await page.goto('/settings/channels/telegram');
  await expect(page.getByTestId('telegram-degraded')).toContainText(
    'Telegram stopped accepting the bot token',
  );
  await expect(
    page.getByTestId('telegram-degraded').getByRole('button', { name: 'Replace token' }),
  ).toBeVisible();

  // Disconnect: confirm, then the token field takes focus.
  await page.getByRole('button', { name: 'Disconnect bot' }).click();
  await page
    .getByRole('alertdialog', { name: `Disconnect @${username}?` })
    .getByRole('button', { name: 'Disconnect' })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Bot disconnected.' })).toBeVisible();
  await expect(page.getByLabel('Bot token')).toBeFocused();
});
