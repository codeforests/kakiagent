import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-024 AC-11 and AC-12 (UC-29; AGT-08, AGT-11): the owner sets the assistant's
 * name, emoji, greeting and disclosure note on SCR-APP-041, and the widget shows them
 * on the next conversation. Also the screen's validation, blank-as-default, preview,
 * conflict and no-permission states, which the dashboard has no component tests for.
 * Settings are written through the screen and cleared through the owner connection.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const BAKERY = '11111111-1111-4111-8111-111111111111';
const STAFF = 'staff-e2e@kaki-bakery.test';

function ownerUrl(): string {
  if (process.env.DATABASE_OWNER_URL) return process.env.DATABASE_OWNER_URL;
  const env = readFileSync(new URL('../../packages/db/.env', import.meta.url), 'utf8');
  const url = /^DATABASE_OWNER_URL=(.+)$/m.exec(env)?.[1];
  if (!url) throw new Error('DATABASE_OWNER_URL is not set (run scripts/gen-local-env.mjs)');
  return url.trim();
}

let owner: pg.Client;
test.beforeAll(async () => {
  owner = new pg.Client({ connectionString: ownerUrl() });
  await owner.connect();
});
test.afterAll(async () => {
  await owner?.end();
});
const reset = () => owner.query(`delete from assistant_settings where tenant_id = $1`, [BAKERY]);
test.beforeEach(reset);
test.afterEach(reset);

async function openSettings(page: Page) {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('link', { name: /^Assistant/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Assistant' })).toBeVisible();
}

test('the owner names the assistant and the widget introduces itself that way', async ({
  page,
}) => {
  await openSettings(page);
  await expectNoSeriousA11yViolations(page);

  const preview = page.getByRole('complementary', { name: 'Preview' });
  await expect(preview).toContainText("You're chatting with an AI assistant for Kaki Bakery.");
  await page.getByLabel('Assistant name').fill('Kaki');
  await page.getByRole('switch', { name: 'Use emoji in replies' }).click();
  const english = page.getByRole('tabpanel');
  await english.getByLabel('Greeting').fill('Hi! Ask me about our cakes and pastries.');
  await english.getByLabel('Add to the disclosure').fill('Our team reads every chat.');
  // The preview follows the draft, before anything is saved.
  await expect(preview).toContainText(
    "You're chatting with Kaki, an AI assistant for Kaki Bakery. Our team reads every chat.",
  );
  await expect(preview).toContainText('Hi! Ask me about our cakes and pastries.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Assistant settings saved. Your assistant uses them from the next reply.',
  );
  await expect(english.getByLabel('Greeting')).toHaveValue(
    'Hi! Ask me about our cakes and pastries.',
  );

  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('heading', { name: 'Kaki' })).toBeVisible();
  await expect(panel.locator('li.empty')).toHaveText('Hi! Ask me about our cakes and pastries.');
  await panel.getByLabel('Message').fill("what's your name?");
  await panel.getByRole('button', { name: 'Send' }).click();
  const reply = panel.locator('[data-author="agent"]:not([data-pending])').first();
  await expect(reply).toHaveText("I'm Kaki, the AI assistant here. How can I help? 🙂");
  await expect(panel.locator('.disc')).toHaveText(
    "You're chatting with Kaki, an AI assistant for Kaki Bakery. Our team reads every chat.",
  );
});

test('validation names each problem, and a blank message goes back to the default', async ({
  page,
}) => {
  await openSettings(page);
  await page.getByLabel('Assistant name').fill('Kaki 2');
  await page.getByRole('tab', { name: /中文/ }).click();
  await page.getByRole('tabpanel').getByLabel('Greeting').fill('你'.repeat(201));
  await page.getByRole('tab', { name: /English/ }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();

  const summary = page.getByRole('alert').filter({ hasText: 'Assistant name' });
  await expect(summary).toBeFocused();
  await expect(summary).toContainText("Assistant name can't contain numbers");
  await expect(summary).toContainText('Greeting must be 200 characters or fewer (中文)');
  await expect(page.getByRole('tab', { name: /中文 \(1 error\)/ })).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
  // Following the summary's link opens the tab the field is on.
  await summary.getByRole('link', { name: /Greeting/ }).click();
  await expect(page.getByRole('tab', { name: /中文/ })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('tabpanel').getByLabel('Greeting').fill('   ');
  await page.getByLabel('Assistant name').fill('Kaki');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toBeVisible();
  const { rows } = await owner.query(
    `select bot_name, greeting_zh from assistant_settings where tenant_id = $1`,
    [BAKERY],
  );
  expect(rows).toEqual([{ bot_name: 'Kaki', greeting_zh: null }]);
  await page.getByRole('tab', { name: /中文/ }).click();
  await expect(page.getByRole('complementary', { name: 'Preview' })).toContainText(
    '有什么问题都可以问我们，我们通常会马上回复。',
  );
});

test('a save over someone else’s change shows the conflict and reloads', async ({ page }) => {
  await openSettings(page);
  await owner.query(`insert into assistant_settings (tenant_id, bot_name) values ($1, 'Mei')`, [
    BAKERY,
  ]);
  await page.getByLabel('Assistant name').fill('Kaki');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Someone else saved these settings while you were editing.',
  );
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByLabel('Assistant name')).toHaveValue('Mei');
});

test('a staff member sees that only Owners and Admins can change the assistant', async ({
  page,
}) => {
  const { rows } = await owner.query<{ id: string }>(
    `insert into users (email) values ($1)
     on conflict (email) do update set email = excluded.email returning id`,
    [STAFF],
  );
  await owner.query(
    `insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')
     on conflict do nothing`,
    [BAKERY, rows[0]!.id],
  );
  try {
    await signIn(page, STAFF);
    await page.goto('/settings/assistant');
    await expect(
      page.getByRole('heading', { name: "You can't change these settings" }),
    ).toBeVisible();
    await expect(page.getByLabel('Assistant name')).toHaveCount(0);
  } finally {
    await owner.query(`delete from memberships where user_id = $1`, [rows[0]!.id]);
  }
});
