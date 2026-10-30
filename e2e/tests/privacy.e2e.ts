import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Download, type Page } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, signIn } from './support.ts';

/**
 * FEAT-058 AC-1, AC-2, AC-7, AC-9, AC-10 (GOV-14, GOV-07, GOV-11): the owner saves the
 * template notice on SCR-APP-047 and opens the hosted page, the widget config follows each
 * notice mode, a Chinese purpose statement is saved, both PDFs download, a stale save shows
 * the conflict, an Agent sees the permission state, and the setup step sits between review
 * and test. `afterEach` deletes the dev tenant's `privacy_settings` row so later specs (and
 * FEAT-033's stubbed privacy link) start from "no notice"; wording rows may stay.
 */
const BAKERY = '11111111-1111-4111-8111-111111111111';
const API = 'http://localhost:3000';
const WIDGET_ORIGIN = 'http://localhost:5175';
const STAFF = 'staff-e2e@kaki-bakery.test';
const LINK = 'https://kakibakery.test/privacy';

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
test.afterEach(async () => {
  await owner.query(`delete from privacy_settings where tenant_id = $1`, [BAKERY]);
});

/** What the widget would be told (AC-1, AC-2), read the way the loader asks. */
async function widgetPrivacyUrl(request: APIRequestContext): Promise<string | null> {
  const res = await request.get(`${API}/widget/v1/config?key=wk_dev_bakery`, {
    headers: { origin: WIDGET_ORIGIN },
  });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { privacyNoticeUrl: string | null }).privacyNoticeUrl;
}

async function pdfOf(download: Download): Promise<Buffer> {
  return readFileSync((await download.path())!);
}

async function openPrivacy(page: Page) {
  await page.goto('/settings');
  await page.getByRole('link', { name: /Privacy and data/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy and data' })).toBeVisible();
}

test('the owner saves the template notice and the widget links to the hosted page', async ({
  page,
  context,
  request,
}) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await openPrivacy(page);
  expect(await widgetPrivacyUrl(request)).toBeNull();

  // Never saved: the readiness note and both "Not saved yet" markers (AC-9).
  await expect(
    page.getByText('You need a privacy notice and a saved purpose statement'),
  ).toBeVisible();
  await expect(page.getByText('Not saved yet')).toHaveCount(2);
  await expectNoSeriousA11yViolations(page);

  // The validation convention: summary alert focused, field-linked error (AC-10).
  const notice = page.getByRole('region', { name: 'Privacy notice' });
  await notice.getByLabel('Use the KakiAgent template').check();
  await notice.getByLabel('Contact email (required)').fill('');
  await notice.getByRole('button', { name: 'Save privacy notice' }).click();
  const summary = notice.getByRole('alert').filter({ hasText: 'Check these fields' });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole('link', { name: 'Add a contact person.' })).toBeVisible();

  await notice.getByLabel('Contact person (required)').fill('Tan Mei Ling');
  await notice.getByLabel('Contact email (required)').fill('dpo@kaki-bakery.test');
  await notice.getByRole('button', { name: 'Save privacy notice' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved. Visitors now see this privacy notice.');
  await expect(notice.getByText(/^Version \d+ · saved /)).toBeVisible();

  const hosted = await widgetPrivacyUrl(request);
  expect(hosted).toMatch(/\/privacy\/wk_dev_bakery$/);
  const preview = notice.getByRole('link', { name: 'Preview your notice (opens in a new tab)' });
  await expect(preview).toHaveAttribute('href', hosted!);
  const [tab] = await Promise.all([context.waitForEvent('page'), preview.click()]);
  await tab.waitForLoadState();
  await expect(tab.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeVisible();
  await expect(tab.getByText('Kaki Bakery').first()).toBeVisible();
  await expect(tab.getByText('Tan Mei Ling')).toBeVisible();
  await expect(tab.getByRole('link', { name: 'dpo@kaki-bakery.test' })).toHaveAttribute(
    'href',
    'mailto:dpo@kaki-bakery.test',
  );
  await expectNoSeriousA11yViolations(tab);
  await tab.close();

  // Link mode: the widget follows (AC-1).
  await notice.getByLabel('On my website').check();
  await notice.getByLabel('Link to your privacy notice (required)').fill(LINK);
  await notice.getByRole('button', { name: 'Save privacy notice' }).click();
  await expect(notice.getByLabel('Link to your privacy notice (required)')).toHaveValue(LINK);
  await expect.poll(() => widgetPrivacyUrl(request)).toBe(LINK);
});

test('the purpose statement saves in Chinese and a stale save shows the conflict', async ({
  page,
}) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/settings/privacy');
  const purpose = page.getByRole('region', { name: /Why you collect details/ });
  await expect(purpose.getByText('Review the text and save it.')).toBeVisible();
  await purpose.getByLabel('中文 (Chinese)').fill('我们只用您的联系方式回复您。');
  await purpose.getByRole('button', { name: 'Save purpose statement' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Saved. Visitors will see this before giving their details.',
  );
  await expect(purpose.getByText(/^Version \d+ · saved /)).toBeVisible();
  await page.reload();
  await expect(purpose.getByLabel('中文 (Chinese)')).toHaveValue('我们只用您的联系方式回复您。');

  // Someone else saves in between (AC-9 conflict).
  await owner.query(`update privacy_settings set version = version + 1 where tenant_id = $1`, [
    BAKERY,
  ]);
  await purpose.getByLabel('English (required)').fill('We reply to your enquiry only.');
  await purpose.getByRole('button', { name: 'Save purpose statement' }).click();
  const conflict = purpose.getByRole('alert').filter({ hasText: 'Someone else changed this.' });
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Reload' }).click();
  await expect(purpose.getByLabel('English (required)')).not.toHaveValue(
    'We reply to your enquiry only.',
  );
});

test('the owner sees where data goes and downloads both PDFs', async ({ page }) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/settings/privacy');
  const docs = page.getByRole('region', { name: 'Where your data goes' });
  await expect(docs.getByText('All your data is stored in Singapore.')).toBeVisible();
  await expect(docs.getByRole('table', { name: 'Services we use' })).toBeVisible();
  await expect(docs.getByRole('table', { name: 'Data processed outside Singapore' })).toBeVisible();
  for (const name of [/Download data-flow PDF/, /Download DPA/]) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      docs.getByRole('link', { name }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^kakiagent-(data-flow|dpa)-.+\.pdf$/);
    const bytes = await pdfOf(download);
    expect(bytes.length).toBeGreaterThan(500);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }
  await expect(page.getByRole('region', { name: 'Terms you accepted' })).toBeVisible();
});

test('an Agent sees that only Owners and Admins can change privacy settings', async ({ page }) => {
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
    await page.goto('/settings/privacy');
    await expect(
      page.getByRole('heading', { name: "You can't change privacy settings" }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save privacy notice' })).toHaveCount(0);
  } finally {
    await owner.query(`delete from memberships where user_id = $1`, [rows[0]!.id]);
  }
});

test('the setup goes review → rules and privacy → test', async ({ page }) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/setup/review');
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup\/rules$/);
  await expect(page.getByText('Step 4 of the setup')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Rules and privacy' })).toBeVisible();
  await expect(
    page.getByText(
      "You'll need saved rules, a privacy notice and a purpose statement before you go live.",
    ),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup\/test$/);
  await expect(page.getByText('Step 5 of the setup')).toBeVisible();
});
