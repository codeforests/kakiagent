import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, magicLinkFor, signIn } from './support.ts';

/**
 * FEAT-050 (AC-1–AC-6, AC-8; SCR-APP-032, -033, -043, -014): the dev Owner sees the seeded
 * contact-form leads (FEAT-049 D9) in the Open tab with their counts and the Hot chip, opens
 * Rachel Tan's lead (reasons, consent wording), moves it to Contacted, and exports the CSV
 * through the re-auth dialog; an Agent sees no status menu and no Export. Adding the keyword
 * "bread" on Lead settings rescores Siti Rahman Cold → Warm. `afterEach` puts the seeded
 * leads and the qualification back (owner connection), so later specs and browsers start
 * from the seed.
 */

const BAKERY = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner@kaki-bakery.test';
const AGENT = 'agent@kaki-bakery.test';

function ownerUrl(): string {
  if (process.env.DATABASE_OWNER_URL) return process.env.DATABASE_OWNER_URL;
  const env = readFileSync(new URL('../../packages/db/.env', import.meta.url), 'utf8');
  const url = /^DATABASE_OWNER_URL=(.+)$/m.exec(env)?.[1];
  if (!url) throw new Error('DATABASE_OWNER_URL is not set (run scripts/gen-local-env.mjs)');
  return url.trim();
}

let owner: pg.Client;
let leadRows: Record<string, unknown>[] = [];
let qualification: unknown;
test.beforeAll(async () => {
  owner = new pg.Client({ connectionString: ownerUrl() });
  await owner.connect();
  leadRows = (
    await owner.query(
      `select id, status, version, status_changed_at, updated_at, score, score_points,
              score_reasons, scored_at
         from leads where tenant_id = $1`,
      [BAKERY],
    )
  ).rows;
  qualification = (
    await owner.query(`select qualification from lead_settings where tenant_id = $1`, [BAKERY])
  ).rows[0]?.qualification;
});
test.afterEach(async () => {
  for (const r of leadRows)
    await owner.query(
      `update leads set status = $2, version = $3, status_changed_at = $4, updated_at = $5,
              score = $6, score_points = $7, score_reasons = $8, scored_at = $9
        where id = $1`,
      [
        r.id,
        r.status,
        r.version,
        r.status_changed_at,
        r.updated_at,
        r.score,
        r.score_points,
        JSON.stringify(r.score_reasons),
        r.scored_at,
      ],
    );
  await owner.query(`update lead_settings set qualification = $2 where tenant_id = $1`, [
    BAKERY,
    JSON.stringify(qualification),
  ]);
});
test.afterAll(async () => {
  await owner?.end();
});

/** Stands in for ten minutes passing: the export needs a fresh re-auth (AUTH-03). */
async function ageReauth(email: string) {
  await owner.query(
    `update sessions set reauth_at = now() - interval '11 minutes'
      where user_id = (select id from users where email = $1)`,
    [email],
  );
}

const leadRow = (page: Page, name: string) =>
  page.getByTestId('lead-row').filter({ has: page.getByRole('link', { name }) });

test('the owner works the pipeline, reads a lead and exports the CSV', async ({
  page,
  context,
}) => {
  await signIn(page, OWNER);
  await page.goto('/leads');
  await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();

  // Open tab: the seeded contact-form leads with counts and score chips (AC-4, AC-2).
  const tabs = page.getByRole('navigation', { name: 'Lead status' });
  await expect(tabs.getByRole('link', { name: /^Open/ })).toHaveAttribute('aria-current', 'page');
  await expect(tabs.getByRole('link', { name: /^Won\s*\d+ leads$/ })).toBeVisible();
  await expect(leadRow(page, 'Rachel Tan').getByTestId('score-chip')).toHaveText('Hot');
  await expect(leadRow(page, 'Siti Rahman').getByTestId('score-chip')).toHaveText('Cold');
  await expect(leadRow(page, 'Grace Wong')).toHaveCount(0);
  await expect(leadRow(page, 'Rachel Tan')).toContainText('Contact form');
  await expectNoSeriousA11yViolations(page);

  // The score filter is in the URL.
  await page.getByLabel('Score').selectOption('hot');
  await expect(page).toHaveURL(/score=hot/);
  await expect(leadRow(page, 'Rachel Tan')).toBeVisible();
  await expect(leadRow(page, 'Siti Rahman')).toHaveCount(0);
  await page.getByLabel('Score').selectOption('');

  // The lead page: reasons in words, consent with its wording (AC-2, AC-6, AC-8).
  await leadRow(page, 'Rachel Tan').getByRole('link', { name: 'Rachel Tan' }).click();
  await expect(page.getByRole('heading', { name: 'Rachel Tan', level: 1 })).toBeVisible();
  const score = page.getByTestId('lead-score');
  await expect(score.getByRole('heading')).toHaveText('Score: Hot · 7 points');
  await expect(score).toContainText('Mentions "wedding"');
  await expect(score).toContainText('Budget meets your S$300 minimum');
  const consent = page.getByTestId('lead-consent').first();
  await expect(consent).toBeVisible();
  await consent.locator('summary').click();
  await expect(consent.locator('details p')).not.toBeEmpty();
  await expect(page.getByText(/^Yes · \d+ \w+ \d{4}/)).toBeVisible();

  // Move to Contacted: saved, toasted, the chip follows (AC-4).
  await page.getByRole('button', { name: 'Status: New' }).click();
  await page.getByRole('menuitemradio', { name: 'Contacted' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Marked as' })).toHaveText(
    'Marked as Contacted',
  );
  await expect(page.getByTestId('status-chip')).toHaveText('Contacted');
  await expectNoSeriousA11yViolations(page);

  // Export with re-auth; the file's first two lines and Rachel's marketing column (AC-5, AC-6).
  await page.getByRole('link', { name: 'Leads', exact: true }).first().click();
  await ageReauth(OWNER);
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const confirm = page.getByRole('alertdialog', { name: /^Export \d+ leads?\?$/ });
  await expect(confirm).toContainText('Do Not Call Registry');
  await confirm.getByRole('button', { name: 'Export' }).click();
  const reauth = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(reauth).toBeVisible();
  const since = new Date(Date.now() - 1000);
  const download = page.waitForEvent('download');
  await reauth.getByRole('button', { name: 'Email me a link' }).click();
  await expect(reauth.getByRole('status')).toContainText('Check your email.');
  const tab = await context.newPage();
  await tab.goto(await magicLinkFor(OWNER, since));
  await expect(tab.getByRole('heading', { name: "You're confirmed" })).toBeVisible();
  await tab.close();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^leads-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await file.path())!, 'utf8').replace(/^﻿/, '');
  const [reminder, header] = csv.split('\r\n');
  expect(reminder).toContain('Do Not Call Registry applies');
  expect(header).toBe(
    'Created (SGT),Updated (SGT),Status,Score,Score reasons,Name,Email,Phone,What they need,Budget,Preferred date or time,Enquiry consent at (SGT),Marketing consent,Marketing consent at (SGT),Source',
  );
  const rachel = csv.split('\r\n').find((l) => l.includes('Rachel Tan'));
  expect(rachel).toContain(',Yes,');
  expect(rachel).toContain(',Contacted,Hot,');
  await expect(page.getByRole('status').filter({ hasText: 'Exported' })).toHaveText(
    /^Exported \d+ leads?\. This export is recorded in the audit log\.$/,
  );
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeFocused();

  // Phone width, tall viewport (fixed tab bar): no sideways scroll, no serious violations.
  await page.setViewportSize({ width: 375, height: 5000 });
  await expect(leadRow(page, 'Rachel Tan')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page);
});

test('an agent reads leads but has no status menu and no export', async ({ page }) => {
  await signIn(page, AGENT);
  await page.goto('/leads');
  await expect(leadRow(page, 'Rachel Tan')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CSV' })).toHaveCount(0);
  await leadRow(page, 'Rachel Tan').getByRole('link', { name: 'Rachel Tan' }).click();
  await expect(page.getByRole('heading', { name: 'Rachel Tan', level: 1 })).toBeVisible();
  await expect(page.getByTestId('status-chip')).toHaveText('New');
  await expect(page.getByRole('button', { name: /^Status:/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Lead settings' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
});

test('saving a new keyword rescores an open lead', async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto('/settings/leads#qualification');
  const card = page.locator('#qualification');
  await expect(card.getByRole('heading', { name: 'Qualification' })).toBeVisible();
  await expect(card.getByRole('list', { name: 'Keywords that make a lead hot' })).toContainText(
    'wedding',
  );
  await expect(card.getByLabel('Minimum budget')).toHaveValue('300');
  await card.getByRole('textbox', { name: 'Keywords that make a lead hot' }).fill('Wedding');
  await card.getByRole('button', { name: 'Add' }).click();
  await expect(card.getByText('You already added wedding')).toBeVisible();
  await card.getByRole('textbox', { name: 'Keywords that make a lead hot' }).fill('bread');
  await card.getByRole('button', { name: 'Add' }).click();
  await expect(card.getByRole('button', { name: 'Remove bread' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Lead settings saved' })).toHaveText(
    /^Lead settings saved\. \d+ open leads? rescored\.$/,
  );

  // Siti asked about bread loaves: Cold (1) → Warm (3) (AC-1).
  await page.goto('/leads');
  await expect(leadRow(page, 'Siti Rahman').getByTestId('score-chip')).toHaveText('Warm');
  await leadRow(page, 'Siti Rahman').getByRole('link', { name: 'Siti Rahman' }).click();
  await expect(page.getByTestId('lead-score').getByRole('heading')).toHaveText(
    'Score: Warm · 3 points',
  );
  await expect(page.getByTestId('lead-score')).toContainText('Mentions "bread"');
});
