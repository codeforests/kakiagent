import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-034 AC-3, AC-4, AC-7, AC-9, AC-10 (ONB-10, CHN-12; SCR-APP-036, SCR-WGT-005): the
 * owner takes the widget offline and back live on the Channels page, each time through the
 * confirm dialog; the widget host page hides the widget, then shows the offline message
 * with no composer, then the composer again. A stubbed degraded channel shows the alert and
 * the banner. `afterEach` puts the dev tenant's widget back to live and hidden so later
 * specs (and browsers) find it live.
 */
const BAKERY = '11111111-1111-4111-8111-111111111111';
const WIDGET_HOST = 'http://localhost:5175/';
const OFFLINE_TEXT = 'We are closed for the holidays. Email us and we will reply soon.';

function ownerUrl(): string {
  if (process.env.DATABASE_OWNER_URL) return process.env.DATABASE_OWNER_URL;
  const env = readFileSync(new URL('../../packages/db/.env', import.meta.url), 'utf8');
  const url = /^DATABASE_OWNER_URL=(.+)$/m.exec(env)?.[1];
  if (!url) throw new Error('DATABASE_OWNER_URL is not set (run scripts/gen-local-env.mjs)');
  return url.trim();
}

let owner: pg.Client;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  owner = new pg.Client({ connectionString: ownerUrl() });
  await owner.connect();
});
test.afterAll(async () => {
  await owner?.end();
});
test.afterEach(async () => {
  await owner.query(
    `update channel_connections
        set state = 'live', offline_mode = 'hidden', offline_message_en = null,
            offline_message_zh = null, version = version + 1
      where tenant_id = $1 and kind = 'widget'`,
    [BAKERY],
  );
});

async function openChannels(page: Page) {
  await page.goto('/settings');
  await page.getByRole('link', { name: /Channels/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Channels' })).toBeVisible();
}

/**
 * A fresh visitor page, in its own browser context (axe needs one made by
 * `browser.newContext()`), on the widget host; resolves once the config has been answered.
 * Close it with `visitor.context().close()`.
 */
async function visit(page: Page) {
  const context = await page.context().browser()!.newContext();
  const visitor = await context.newPage();
  await openShadowRoots(visitor);
  const config = visitor.waitForResponse(/\/widget\/v1\/config/);
  await visitor.goto(WIDGET_HOST);
  expect((await config).status()).toBe(200);
  await visitor.waitForTimeout(500);
  return visitor;
}

test('the owner takes the widget offline and back live; the widget follows', async ({ page }) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await openChannels(page);
  const card = page.getByRole('region', { name: 'Website chat widget' });
  await expect(card.getByText('Live', { exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'light' });

  // Go offline: the dialog first, and Cancel changes nothing.
  await card.getByRole('button', { name: 'Go offline' }).click();
  let dialog = page.getByRole('alertdialog', { name: 'Take Website chat widget offline?' });
  await expect(dialog).toContainText("don't see the chat button");
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.getByText('Live', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Go offline' }).click();
  await dialog.getByRole('button', { name: 'Go offline' }).click();
  await expect(page.getByRole('status')).toHaveText('Website chat widget is offline.');
  await expect(card.getByText('Offline', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Go live' })).toBeFocused();

  // Hidden: the host page gets no widget at all.
  let visitor = await visit(page);
  expect(await visitor.locator('kaki-agent').count()).toBe(0);
  await visitor.context().close();

  // "Show a message" with the owner's text: the launcher shows, the panel has no composer.
  await card.getByLabel('Show a message').check();
  await card.getByLabel('Message (English)').fill(OFFLINE_TEXT);
  await expect(card.getByRole('region', { name: 'What visitors see' })).toContainText(OFFLINE_TEXT);
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Saved. Visitors see this while Website chat widget is offline.',
  );
  visitor = await visit(page);
  await visitor.locator('kaki-agent button.launcher').click();
  const notLive = visitor.locator('kaki-agent [role="region"]');
  await expect(notLive).toContainText(OFFLINE_TEXT);
  await expect(visitor.locator('kaki-agent textarea')).toHaveCount(0);
  await expect(visitor.locator('kaki-agent a[href^="mailto:"]')).toBeVisible();
  await expectNoSeriousA11yViolations(visitor);
  await visitor.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(visitor);
  await visitor.context().close();

  // Go live again: the composer is back.
  await card.getByRole('button', { name: 'Go live' }).click();
  dialog = page.getByRole('alertdialog', { name: 'Go live on Website chat widget?' });
  await dialog.getByRole('button', { name: 'Go live' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Your assistant is live on Website chat widget.',
  );
  await expect(card.getByText('Live', { exact: true })).toBeVisible();
  visitor = await visit(page);
  await visitor.locator('kaki-agent button.launcher').click();
  await expect(visitor.locator('kaki-agent textarea')).toBeVisible();
  await visitor.context().close();
});

test('a degraded channel shows its alert on Channels and the banner elsewhere', async ({
  page,
}) => {
  // No real channel can degrade in dev (only the widget, which isn't health-checked).
  await page.route('**/api/v1/channels', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { channels: Record<string, unknown>[] };
    const widget = body.channels[0]!;
    body.channels.push({
      ...widget,
      id: '00000000-0000-4000-8000-0000000003a4',
      kind: 'telegram',
      name: 'Telegram',
      state: 'live',
      health: 'degraded',
      healthReason: 'credential_revoked',
      healthCheckedAt: new Date().toISOString(),
      degradedSince: new Date().toISOString(),
      checksHealth: true,
      offlineModes: ['message'],
      offline: { ...(widget.offline as object), mode: 'message' },
    });
    await route.fulfill({ response: res, json: body });
  });
  await signIn(page, 'owner@kaki-bakery.test');
  const banner = page.getByRole('region', { name: 'Channel problem' });
  await expect(banner).toHaveText(/Telegram isn't working\. Visitors there may not get replies\./);
  await expectNoSeriousA11yViolations(page);

  await banner.getByRole('link', { name: 'Fix in Channels' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Channels' })).toBeVisible();
  await expect(banner).toHaveCount(0);
  const card = page.getByRole('region', { name: 'Telegram' });
  await expect(card.getByText('Not working')).toBeVisible();
  await expect(card).toContainText('The connection was removed or its access was revoked.');
  await expect(card.getByRole('button', { name: 'Check again' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // Dismissed, it stays away for the session.
  await page.goto('/inbox');
  await page
    .getByRole('region', { name: 'Channel problem' })
    .getByRole('button', { name: 'Dismiss' })
    .click();
  await page.getByRole('link', { name: 'Knowledge' }).first().click();
  await expect(page.getByRole('region', { name: 'Channel problem' })).toHaveCount(0);
});
