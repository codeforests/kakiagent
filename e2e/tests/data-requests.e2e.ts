import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, magicLinkFor, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-061 §6 (AC-1–AC-7, AC-11; GOV-05, UC-30; SCR-APP-047 p, -048, -049): a widget visitor
 * leaves their name and a fresh phone number (a new contact with a conversation, lead and
 * consents). The dev Owner logs an Access request for that phone from Privacy and data,
 * verifies identity, sees the person and the conversation, exports the JSON through the
 * re-auth dialog and marks it completed; then logs a Deletion request, verifies, deletes with
 * type-to-confirm and re-auth, and sees the done state with the audit chain verified. An Agent
 * gets the no-access state. axe at 1440 and 375 × 5000 (tall: the fixed tab bar). The spec
 * creates its own contact, so no seeded data changes.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const OWNER = 'owner@kaki-bakery.test';
const AGENT = 'agent@kaki-bakery.test';
const CONSENT = 'Is it OK for us to use your details for this?';

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

/** Stands in for ten minutes passing: export and delete need a fresh re-auth (AUTH-03). */
async function ageReauth(email: string) {
  await owner.query(
    `update sessions set reauth_at = now() - interval '11 minutes'
      where user_id = (select id from users where email = $1)`,
    [email],
  );
}

/** Eight digits starting 9: a fresh SG mobile per run, so the contact is new. */
const mobile = () => `9${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
/** A run tag without digits (the fake triage reads the first number in chat as a quantity). */
const tag = () =>
  Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
    '',
  );

/** A visitor agrees and leaves name and phone: a contact, a conversation, a lead, consents. */
async function leaveDetails(browser: Browser, name: string, digits: string) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  await panel.getByLabel('Message', { exact: true }).fill('Can someone call me about a cake?');
  await panel.getByRole('button', { name: 'Send' }).click();
  const consent = panel.getByRole('group', { name: CONSENT });
  await expect(consent).toBeVisible({ timeout: 30_000 });
  await consent.getByRole('button', { name: 'Agree' }).click();
  const form = panel.getByRole('group', { name: 'Your details' });
  await form.getByLabel('Name (required)').fill(name);
  await form.getByLabel('Phone').fill(`${digits.slice(0, 4)} ${digits.slice(4)}`);
  await form.getByRole('button', { name: 'Send details' }).click();
  await expect(panel.getByText(/has your details and will get back to you/)).toBeVisible({
    timeout: 10_000,
  });
  await context.close();
}

/** Answers "Confirm it's you" with an emailed link in a second tab. */
async function confirmByEmail(page: Page, context: BrowserContext) {
  const reauth = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(reauth).toBeVisible();
  const since = new Date(Date.now() - 1000);
  await reauth.getByRole('button', { name: 'Email me a link' }).click();
  await expect(reauth.getByRole('status')).toContainText('Check your email.');
  const tab = await context.newPage();
  await tab.goto(await magicLinkFor(OWNER, since));
  await expect(tab.getByRole('heading', { name: "You're confirmed" })).toBeVisible();
  await tab.close();
}

/** New request → the request page (AC-1): type, today's date, the phone. */
async function logRequest(page: Page, type: 'Access' | 'Deletion', name: string, digits: string) {
  await page.goto('/settings/privacy/requests');
  await page.getByRole('button', { name: 'New request' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New data request' });
  await dialog.getByRole('radio', { name: new RegExp(`^${type}`) }).check();
  await dialog.getByLabel('Name (optional)').fill(name);
  await dialog.getByLabel('Phone (+65)').fill(digits);
  await dialog.getByRole('button', { name: 'Log request' }).click();
  await expect(page.getByRole('heading', { name: `${type} request`, level: 1 })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Request logged' })).toHaveText(
    /^Request logged\. Due \d{1,2} \w{3} \d{4}\.$/,
  );
}

/** Step 1 (AC-2): method and note; the card collapses to the summary. */
async function verifyIdentity(page: Page) {
  const step = page.getByRole('region', { name: 'Step 1 · Verify identity' });
  await step.getByRole('radio', { name: 'We called them on the number we hold' }).check();
  await step.getByLabel('Note').fill('Called the number we hold; they confirmed the cake order.');
  await step.getByRole('button', { name: 'Mark identity verified' }).click();
  await expect(page.getByTestId('dsr-verified')).toContainText(
    /Identity verified by .+ on \d{1,2} \w{3} \d{4}: We called them on the number we hold\./,
  );
}

test('the owner exports, then deletes, a customer’s data', async ({ browser, page, context }) => {
  test.setTimeout(180_000);
  const name = `Dsr ${tag()}`;
  const digits = mobile();
  await leaveDetails(browser, name, digits);

  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, OWNER);

  // Privacy and data's row leads to the list (SCR-APP-047 p).
  await page.goto('/settings/privacy');
  const row = page.getByTestId('privacy-dsr');
  await expect(row).toContainText('Requests from customers to see, correct or delete');
  await row.getByRole('link', { name: 'Manage requests' }).click();
  await expect(page.getByRole('heading', { name: 'Data requests', level: 1 })).toBeVisible();

  // Access: log, verify, find, export with re-auth, complete (AC-1–AC-4).
  await logRequest(page, 'Access', name, digits);
  await expect(page.getByTestId('dsr-due')).toHaveText(/^Due \d{1,2} \w{3}$/);
  await expectNoSeriousA11yViolations(page);
  await verifyIdentity(page);
  const person = page.getByTestId('dsr-person').filter({ hasText: name });
  await expect(person).toContainText('1 lead');
  await expect(person.getByRole('checkbox')).toBeChecked();
  await expect(page.getByTestId('dsr-conversation')).toHaveCount(1);
  await expect(page.getByTestId('dsr-selected')).toHaveText('Selected: 1 person, 1 conversation');
  await ageReauth(OWNER);
  await page.getByRole('button', { name: 'Export data' }).click();
  const exportDialog = page.getByRole('alertdialog', { name: "Export this person's data" });
  await expect(exportDialog).toContainText('send it only to the requester');
  const download = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await confirmByEmail(page, context);
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    /^data-request-DSR-[0-9A-F]{8}-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const json = JSON.parse(readFileSync((await file.path())!, 'utf8')) as {
    contacts: { name: string; phone: string }[];
    conversations: { messages: { body: string }[] }[];
  };
  expect(json.contacts[0]).toMatchObject({ name, phone: `+65${digits}` });
  expect(json.conversations[0]!.messages.map((m) => m.body)).toContain(
    'Can someone call me about a cake?',
  );
  await expect(page.getByRole('status').filter({ hasText: 'Export downloaded' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark completed' }).click();
  await page
    .getByRole('alertdialog', { name: 'Mark this request completed?' })
    .getByRole('button', { name: 'Mark completed' })
    .click();
  await expect(page.getByTestId('dsr-completed')).toContainText('Completed on');
  await expect(page.getByTestId('dsr-history')).toContainText('Exported');

  // Deletion: log, verify, delete with type-to-confirm and re-auth (AC-6, AC-7).
  await logRequest(page, 'Deletion', name, digits);
  await verifyIdentity(page);
  await expect(page.getByTestId('dsr-person').filter({ hasText: name })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await ageReauth(OWNER);
  await page.getByRole('button', { name: 'Delete selected data' }).click();
  const confirm = page.getByRole('alertdialog', { name: "Delete this person's data?" });
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(confirm.getByTestId('dsr-delete-counts')).toHaveText(
    /^1 person, 1 conversation \(\d+ messages?\)\.$/,
  );
  const del = confirm.getByRole('button', { name: 'Delete', exact: true });
  await expect(del).toBeDisabled();
  await confirm.getByLabel('Type delete to confirm').fill('delete');
  await expect(del).toBeEnabled();
  await del.click();
  await confirmByEmail(page, context);
  const done = page.getByTestId('dsr-done');
  await expect(done).toContainText('Data deleted on', { timeout: 15_000 });
  await expect(page.getByTestId('dsr-removed')).toContainText(
    /^1 person, 1 conversation, \d+ messages?/,
  );
  await expect(page.getByTestId('dsr-chain')).toHaveText('Chain verified');
  await expect(done).toContainText(/Cleared by \d{1,2} \w{3} \d{4}/);
  await expect(done.getByRole('link', { name: /^Entry #\d+$/ })).toBeVisible();
  await expect(page.getByTestId('dsr-requester')).toContainText('Details masked after deletion');
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 375, height: 5000 });
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page);

  // The list: both closed, in the Closed tab, at both widths (AC-1, AC-11).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/privacy/requests?view=closed');
  await expect(page.getByTestId('dsr-row').first()).toBeVisible();
  await expect(page.getByTestId('dsr-row').filter({ hasText: 'Deletion' }).first()).toContainText(
    'Completed',
  );
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 375, height: 5000 });
  await expect(page.getByTestId('dsr-cards')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page);

  // The person is gone: a new search on the same phone finds nothing.
  const left = await owner.query(`select count(*)::int as n from contacts where phone = $1`, [
    `+65${digits}`,
  ]);
  expect(left.rows[0].n).toBe(0);
});

test('an agent has no access to data requests', async ({ page }) => {
  await signIn(page, AGENT);
  await page.goto('/settings/privacy/requests');
  await expect(
    page.getByRole('heading', { name: "You don't have access to this page" }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'New request' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
});
