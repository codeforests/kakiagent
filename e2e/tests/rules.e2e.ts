import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, magicLinkFor, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-054 §5.6 (AC-3, AC-5, AC-6, AC-11; SCR-APP-042): the dev Owner opens Rules and
 * approvals (the F&B suggestions shown), blocks a topic and raises the discount, saves
 * through the confirm dialog and the re-auth dialog, and sees the toast; a reload shows the
 * saved rules. A widget visitor asking about the blocked topic then gets the refusal (fake
 * model). `beforeEach`/`afterEach` delete the dev tenant's `boundary_rules` rows (the owner
 * connection; the app roles can't), so every browser starts from the template and later
 * specs never meet the blocked topic.
 */

const BAKERY = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner@kaki-bakery.test';
const WIDGET_HOST = 'http://localhost:5175/';
const TOPIC = 'Franchise opportunities';

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

const clearRules = () => owner.query(`delete from boundary_rules where tenant_id = $1`, [BAKERY]);
test.beforeEach(clearRules);
test.afterEach(clearRules);

/** Stands in for ten minutes passing: saving the rules needs a fresh re-auth (AUTH-03). */
async function ageReauth(email: string) {
  await owner.query(
    `update sessions set reauth_at = now() - interval '11 minutes'
      where user_id = (select id from users where email = $1)`,
    [email],
  );
}

async function askWidget(page: Page, text: string) {
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  await panel.getByLabel('Message').fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
  const reply = panel.locator('[data-author="agent"]:not([data-pending])').first();
  await expect(reply).toBeVisible();
  return reply;
}

test('the owner blocks a topic behind re-auth and a visitor asking about it is refused', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await signIn(page, OWNER);
  await ageReauth(OWNER);

  // Settings → Rules and approvals, prefilled with the F&B suggestions (AC-1 in the UI).
  await page.goto('/settings');
  await page.getByRole('link', { name: /Rules and approvals/ }).click();
  await expect(page).toHaveURL(/\/settings\/rules$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Rules and approvals' })).toBeVisible();
  await expect(page.getByText('Suggested rules for food and beverage businesses')).toBeVisible();
  await expect(page.getByText('Not saved yet')).toBeVisible();
  const blocked = page.getByRole('list', { name: "Topics your assistant won't discuss" });
  await expect(blocked.getByText("Competitors' prices")).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Legal advice/ })).toBeChecked();
  await expectNoSeriousA11yViolations(page);

  // Block a topic (a duplicate is refused first) and raise the discount.
  const blockedInput = page.getByRole('textbox', { name: "Topics your assistant won't discuss" });
  await blockedInput.fill("competitors'   PRICES");
  await blockedInput.press('Enter');
  await expect(page.getByText('Already in the list')).toBeVisible();
  await blockedInput.fill(TOPIC);
  await blockedInput.press('Enter');
  await expect(blocked.getByText(TOPIC)).toBeVisible();
  await page.getByLabel('Maximum discount (percent)').fill('10');

  // Save: the confirm dialog lists the changes (AC-11) …
  await page.getByRole('button', { name: 'Save rules' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Save these rules?' });
  await expect(confirm.getByText(`Won't discuss: added ${TOPIC}`)).toBeVisible();
  await expect(confirm.getByText('Maximum discount: 0% → 10%')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await confirm.getByRole('button', { name: 'Save rules' }).click();

  // … then "Confirm it's you" by an emailed link, and the save completes by itself (AC-3).
  const reauth = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(reauth).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  const since = new Date(Date.now() - 1000);
  await reauth.getByRole('button', { name: 'Email me a link' }).click();
  await expect(reauth.getByRole('status')).toContainText('Check your email.');
  const tab = await context.newPage();
  await tab.goto(await magicLinkFor(OWNER, since));
  await expect(tab.getByRole('heading', { name: "You're confirmed" })).toBeVisible();
  await tab.close();
  await expect(reauth).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole('status').filter({ hasText: 'Rules saved' })).toHaveText(
    'Rules saved. They apply from the next reply.',
  );
  await expect(confirm).toBeHidden();

  // A reload shows the saved rules, not the suggestions (never optimistic: the server's copy).
  await page.reload();
  await expect(blocked.getByText(TOPIC)).toBeVisible();
  await expect(page.getByLabel('Maximum discount (percent)')).toHaveValue('10');
  await expect(page.getByText(/^Saved \d+ \w+ \d{4}/)).toBeVisible();
  await expect(page.getByText('Suggested rules for food and beverage businesses')).toHaveCount(0);

  // Dark, at 375 px: no sideways scroll, no serious violations.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page);

  // The next visitor reply uses the new rules: the blocked topic is refused (AC-5, AC-6).
  const visitor = await context.browser()!.newPage();
  const reply = await askWidget(visitor, `Do you offer ${TOPIC.toLowerCase()}?`);
  await expect(reply).toHaveText(
    "Sorry, I can't help with that here. I'm happy to help with other questions about Kaki Bakery.",
  );
  await visitor.close();
});
