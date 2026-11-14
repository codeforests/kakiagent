import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, magicLinkFor, signIn } from './support.ts';

/**
 * FEAT-060 (AC-6, AC-7, AC-8; SCR-APP-050, SCR-APP-014): the dev Owner opens Audit log from
 * Settings, filters by type (in the URL, kept on reload), opens an entry, verifies the chain
 * (intact) and exports a CSV through the re-auth dialog, after which the `audit.exported`
 * entry is listed. A conversation's sidebar link opens the log filtered to it. An Agent sees
 * neither the Settings row nor the sidebar link, and the URL gives the no-access state.
 * The verify cooldown (30 s, D4) is shared by every browser's run, so a cooldown answer is
 * waited out before the check that must show the intact result.
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
let conversationId: string;

test.beforeAll(async () => {
  owner = new pg.Client({ connectionString: ownerUrl() });
  await owner.connect();
  conversationId = (
    await owner.query<{ id: string }>(
      `insert into conversations (tenant_id, channel, visitor_id)
       values ($1, 'widget', gen_random_uuid()) returning id`,
      [BAKERY],
    )
  ).rows[0]!.id;
});

test.afterAll(async () => {
  if (conversationId)
    await owner.query(`delete from conversations where id = $1`, [conversationId]);
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

test('the owner filters, opens an entry, verifies the chain and exports', async ({
  page,
  context,
  browserName,
}) => {
  // A cooldown wait (up to 35 s) and two verifies can pass the 60 s default.
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, OWNER);

  // The seeded tenant has no team entries of its own; an invite and its revoke give the
  // Team filter below entries to show, whatever ran before this spec.
  const invited = await page.request.post('/api/v1/team/invitations', {
    data: { email: `audit-team-${browserName}@example.test`, role: 'agent' },
  });
  expect(invited.status()).toBe(201);
  const invitation = (await invited.json()) as { id: string };
  expect((await page.request.delete(`/api/v1/team/invitations/${invitation.id}`)).status()).toBe(
    204,
  );

  // Settings → Privacy and data → Audit log (AC-8).
  await page.goto('/settings');
  await page.getByRole('link', { name: /^Audit log/ }).click();
  await expect(page).toHaveURL(/\/settings\/audit$/);
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  const rows = page.getByTestId('audit-row');
  await expect(rows.first()).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // Type filter in the URL, kept on reload; every row is in the group (AC-6).
  await page.getByLabel('Type', { exact: true }).selectOption('team');
  await expect(page).toHaveURL(/group=team/);
  await page.reload();
  await expect(page.getByLabel('Type', { exact: true })).toHaveValue('team');
  await expect(rows.first()).toBeVisible();
  for (const ev of await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-event'))))
    expect(ev).toMatch(/^(member|tenant|terms)\./);

  // An entry opens in the slide-over with its chain fields; Esc returns focus to the row.
  const first = rows.first().getByRole('button');
  await first.click();
  const detail = page.getByRole('dialog', { name: /^Entry #[\d,]+$/ });
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('audit-detail')).toContainText('Previous hash');
  await expect(detail.getByTestId('audit-detail')).toContainText(/[0-9a-f]{64}/);
  await expectNoSeriousA11yViolations(page);
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(first).toBeFocused();
  await page.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(page).toHaveURL(/\/settings\/audit$/);

  // Verify: a cooldown from another run is a state, waited out; then intact (AC-7).
  const card = page.getByRole('region', { name: 'Chain verification' });
  const verify = card.getByRole('button', { name: /^Verify (audit chain|again)$/ });
  await verify.click();
  const result = card.getByTestId('audit-verify-result');
  const waiting = card.getByText(/^(Verified moments ago|A check is already running)/);
  await expect(result.or(waiting)).toBeVisible({ timeout: 70_000 });
  if (await waiting.isVisible()) {
    await expect(verify).toBeEnabled({ timeout: 35_000 });
    await verify.click();
    await expect(result).toBeVisible({ timeout: 70_000 });
  }
  await expect(card.getByTestId('audit-verify-chip')).toHaveText('Intact');
  await expect(result).toContainText(
    /^(Chain intact\. [\d,]+ entr(y|ies) checked|Entries checked)/,
  );
  await expect(card).toContainText(/Last verified .+ · [\d,]+ entr/);
  await expect(rows.first()).toHaveAttribute('data-event', 'audit.verified');

  // Export CSV with re-auth; the new audit.exported entry is listed (AC-8).
  await ageReauth(OWNER);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Export audit log' });
  await expect(confirm).toContainText('All entries');
  await expect(confirm.getByLabel('CSV (spreadsheets)')).toBeChecked();
  await confirm.getByRole('button', { name: 'Export', exact: true }).click();
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
  expect(file.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await file.path())!, 'utf8').replace(/^\uFEFF/, '');
  expect(csv.split('\r\n')[0]).toBe(
    'seq,time_sgt,time_utc,actor_type,actor_id,actor_name,event_type,subjects,payload,personal_data,prev_hash,hash',
  );
  expect(csv).toContain('audit.verified');
  await expect(page.getByRole('status').filter({ hasText: 'Audit log exported' })).toHaveText(
    'Audit log exported. This export is recorded in the log.',
  );
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeFocused();
  await expect(rows.first()).toHaveAttribute('data-event', 'audit.exported');

  // From a conversation's sidebar: the log filtered to it (AC-8, SCR-APP-014).
  await page.goto(`/inbox/${conversationId}`);
  await page.getByRole('link', { name: 'View audit log' }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/audit\\?conversation=${conversationId}$`));
  await expect(page.getByTestId('audit-conversation-chip')).toContainText(
    conversationId.slice(0, 8),
  );
  await expect(page.getByText('No entries match these filters')).toBeVisible();

  // Phone width, tall viewport (fixed tab bar): no sideways scroll, no serious violations.
  await page.goto('/settings/audit');
  await page.setViewportSize({ width: 375, height: 5000 });
  await expect(rows.first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Filters/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page);
});

test('an agent has no audit log row, no sidebar link and no access', async ({ page }) => {
  await signIn(page, AGENT);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByText('Leads and consent').first()).toBeVisible();
  await expect(page.getByText('Audit log')).toHaveCount(0);
  await page.goto(`/inbox/${conversationId}`);
  await expect(page.getByTestId('context-sidebar').first()).toBeAttached();
  await expect(page.getByRole('link', { name: 'View audit log' })).toHaveCount(0);
  await page.goto('/settings/audit');
  await expect(page.getByText("You don't have access to this page")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toHaveCount(0);
});
