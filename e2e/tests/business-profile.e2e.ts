import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-009 AC-10 and AC-11 (UC-03 1–3, UC-20 5b; ONB-03, ONB-06): the owner edits the
 * business profile on SCR-APP-044, sets a closure for today, answers one of the F&B
 * template's suggested questions, and the widget's next reply carries the after-hours
 * notice. Also the screen's validation, conflict, no-permission and setup states. The
 * profile, holidays and the FAQ the test adds are restored through the owner connection.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const BAKERY = '11111111-1111-4111-8111-111111111111';
const STAFF = 'staff-e2e@kaki-bakery.test';
const ALWAYS = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [
    d,
    [{ open: '00:00', close: '24:00' }],
  ]),
);
const QUESTION = 'Do you take custom cake orders?';

function ownerUrl(): string {
  if (process.env.DATABASE_OWNER_URL) return process.env.DATABASE_OWNER_URL;
  const env = readFileSync(new URL('../../packages/db/.env', import.meta.url), 'utf8');
  const url = /^DATABASE_OWNER_URL=(.+)$/m.exec(env)?.[1];
  if (!url) throw new Error('DATABASE_OWNER_URL is not set (run scripts/gen-local-env.mjs)');
  return url.trim();
}

const sgToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

let owner: pg.Client;
let seeded: Record<string, unknown>;
let seededName: string;
test.beforeAll(async () => {
  owner = new pg.Client({ connectionString: ownerUrl() });
  await owner.connect();
  seeded = (
    await owner.query(
      `select gst_registered, hours, open_on_public_holidays, uen, industry, contact_email,
              contact_phone, languages from business_profiles where tenant_id = $1`,
      [BAKERY],
    )
  ).rows[0];
  seededName = (await owner.query(`select name from tenants where id = $1`, [BAKERY])).rows[0].name;
});
test.afterAll(async () => {
  await owner?.end();
});

async function restore() {
  await owner.query(`delete from holidays where tenant_id = $1`, [BAKERY]);
  await owner.query(
    `update business_profiles set gst_registered = $2, hours = $3, open_on_public_holidays = $4,
            uen = $5, industry = $6, contact_email = $7, contact_phone = $8, languages = $9
      where tenant_id = $1`,
    [
      BAKERY,
      seeded.gst_registered,
      JSON.stringify(seeded.hours),
      seeded.open_on_public_holidays,
      seeded.uen,
      seeded.industry,
      seeded.contact_email,
      seeded.contact_phone,
      seeded.languages,
    ],
  );
  await owner.query(`update tenants set name = $2 where id = $1`, [BAKERY, seededName]);
  const faqs = `select id from facts where tenant_id = $1 and type = 'faq' and value->>'question' = $2`;
  await owner.query(`delete from kb_chunks where fact_id in (${faqs})`, [BAKERY, QUESTION]);
  await owner.query(`delete from fact_versions where fact_id in (${faqs})`, [BAKERY, QUESTION]);
  await owner.query(`delete from facts where id in (${faqs})`, [BAKERY, QUESTION]);
}
test.beforeEach(restore);
test.afterEach(restore);

async function openProfile(page: Page) {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('link', { name: /^Business profile/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Business profile' })).toBeVisible();
  await expect(page.getByLabel('Business name (required)')).toBeVisible();
}

test('the owner sets a closure for today, answers a suggested question, and the widget says it is closed', async ({
  page,
}) => {
  // Open around the clock, so only the closure can close the bakery.
  await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
    BAKERY,
    JSON.stringify(ALWAYS),
  ]);
  await openProfile(page);
  await expectNoSeriousA11yViolations(page);
  await expect(page.getByLabel('Industry')).toHaveValue('fnb');
  await expect(page.getByLabel('Contact phone')).toHaveValue('+65 9123 4567');

  // An invalid UEN is named inline on blur and in the summary on Save.
  const uen = page.getByLabel('UEN');
  await uen.fill('2019-123');
  await uen.blur();
  await expect(page.getByText('UEN must be 9 or 10 characters, like 201912345K')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  const summary = page.getByRole('alert').filter({ hasText: 'Check these fields' });
  await expect(summary).toBeFocused();
  await summary.getByRole('link', { name: /UEN must be/ }).click();
  await expect(uen).toBeFocused();
  await uen.fill('53312345a');

  // A closure for today.
  await page.getByRole('button', { name: 'Add a closure' }).click();
  await page.getByLabel('Closure 1 date').fill(sgToday());
  await page.getByLabel('Reason (optional)').fill('Staff day off');
  await expect(page.getByText('Public holidays are listed through 2027.')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Business profile saved. Your assistant uses it from the next reply.',
  );
  await expect(uen).toHaveValue('53312345A');
  await expect(page.getByLabel('Closure 1 date')).toHaveValue(sgToday());

  // The F&B template's suggestions: answer one, and it shows as added.
  const suggestions = page.getByRole('region', { name: /Suggested questions/ });
  await expect(suggestions).toContainText(QUESTION);
  await suggestions.getByRole('link', { name: `Add answer: ${QUESTION}` }).click();
  await expect(page.getByLabel('Question (required)')).toHaveValue(QUESTION);
  await page
    .getByLabel('Answer (required)')
    .fill('Yes. We need 3 days of notice for custom cakes.');
  await page.getByRole('button', { name: 'Save fact' }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await page.goto('/settings/business-profile');
  const row = page.getByRole('listitem').filter({ hasText: QUESTION });
  await expect(row.getByText('Added')).toBeVisible();
  await expect(row.getByRole('link', { name: /Add answer/ })).toHaveCount(0);

  // The widget's next reply: closed today, back tomorrow.
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  await panel.getByLabel('Message').fill('how much is the chocolate fudge cake?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('[data-author="agent"]:not([data-pending])').first()).toBeVisible();
  await expect(panel.locator('li.notice')).toHaveText(
    /^We're closed right now\. The team will be back /,
  );
});

test('the hours editor and holidays validate, and Cancel resets', async ({ page }) => {
  await openProfile(page);
  await expect(page.getByRole('switch', { name: 'Set opening hours' })).toBeChecked();
  const monOpen = page.getByLabel('Monday opens');
  await expect(monOpen).toHaveValue('08:00');
  await page.getByLabel('Monday closes').fill('07:00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const summary = page.getByRole('alert').filter({ hasText: 'Check these fields' });
  await expect(summary).toContainText('Monday: opening time must be before closing time');
  await summary.getByRole('link', { name: /Monday/ }).click();
  await expect(monOpen).toBeFocused();
  await page.getByLabel('Monday closes').fill('19:00');

  // A second range that overlaps the first.
  await page.getByRole('button', { name: 'Add hours on Monday' }).click();
  await page.getByLabel('Monday opens (2)').fill('18:00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(summary).toContainText('Monday: hours overlap');
  await page.getByRole('button', { name: 'Remove Monday hours (2)' }).click();

  // Sunday closed; the public-holiday rule resets the per-holiday choices.
  await page.getByRole('switch', { name: 'Open on Sunday' }).click();
  await expect(page.getByLabel('Sunday opens')).toHaveCount(0);
  const holidays = page.getByRole('list', { name: 'Coming public holidays' });
  const first = holidays.getByRole('checkbox').first();
  await expect(first).not.toBeChecked();
  await first.check();
  await page.getByRole('switch', { name: 'Open on public holidays' }).click();
  await expect(holidays.getByRole('checkbox').first()).toBeChecked();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('switch', { name: 'Open on Sunday' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await expectNoSeriousA11yViolations(page);
});

test('a save over someone else’s change shows the conflict and reloads', async ({ page }) => {
  await openProfile(page);
  await owner.query(
    `update business_profiles set version = version + 1, contact_email = 'other@kaki-bakery.test' where tenant_id = $1`,
    [BAKERY],
  );
  await page.getByLabel('Business name (required)').fill('Kaki Bakery & Cafe');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const conflict = page.getByRole('alert').filter({ hasText: 'Someone else saved this profile' });
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByLabel('Contact email')).toHaveValue('other@kaki-bakery.test');
  await expect(page.getByLabel('Business name (required)')).toHaveValue('Kaki Bakery');
});

test('a staff member sees that only Owners and Admins can change the profile', async ({ page }) => {
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
    await page.goto('/settings/business-profile');
    await expect(
      page.getByRole('heading', { name: "You can't change the business profile" }),
    ).toBeVisible();
    await expect(page.getByLabel('Business name (required)')).toHaveCount(0);
  } finally {
    await owner.query(`delete from memberships where user_id = $1`, [rows[0]!.id]);
  }
});

test('the setup step saves the profile and continues to the sources step', async ({ page }) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/setup');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Tell us about your business' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: /Suggested questions/ })).toHaveCount(0);
  await page.getByLabel('Contact email').fill('orders@kaki-bakery.test');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page).toHaveURL(/\/setup\/sources$/);
  await expect(page.getByText('Step 2 of 7 · Add your sources')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Business profile saved.' })).toHaveText(
    'Business profile saved. Next, add what your assistant should know.',
  );
  const { rows } = await owner.query(
    `select contact_email from business_profiles where tenant_id = $1`,
    [BAKERY],
  );
  expect(rows[0].contact_email).toBe('orders@kaki-bakery.test');
});
