import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, signIn } from './support.ts';

/**
 * FEAT-039 (AC-1, AC-4, AC-5, AC-8; SCR-APP-016, -015, -033): the seeded pair (D10) shares
 * Rachel Tan's typed email, so it is a suggestion, never joined. A chat linked to "R. Tan"
 * shows the sidebar's duplicate hint; from there the Owner opens Rachel Tan, previews and
 * merges R. Tan in (focus on the preview's heading), sees R. Tan's chat on Rachel's page and
 * the merge row, then undoes it from the Merges card. `afterEach` undoes any merge left
 * open and `afterAll` removes the chat, so other specs and browsers start from the seed.
 */

const BAKERY = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner@kaki-bakery.test';

function ownerUrl(): string {
  if (process.env.DATABASE_OWNER_URL) return process.env.DATABASE_OWNER_URL;
  const env = readFileSync(new URL('../../packages/db/.env', import.meta.url), 'utf8');
  const url = /^DATABASE_OWNER_URL=(.+)$/m.exec(env)?.[1];
  if (!url) throw new Error('DATABASE_OWNER_URL is not set (run scripts/gen-local-env.mjs)');
  return url.trim();
}

let owner: pg.Client;
let rachel = '';
let rTan = '';
let leadId = '';
let conversationId = '';

const contactId = async (name: string) =>
  (
    await owner.query<{ id: string }>(
      `select id from contacts where tenant_id = $1 and name = $2 and merged_into is null
        order by created_at limit 1`,
      [BAKERY, name],
    )
  ).rows[0]!.id;

test.beforeAll(async () => {
  owner = new pg.Client({ connectionString: ownerUrl() });
  await owner.connect();
  rachel = await contactId('Rachel Tan');
  rTan = await contactId('R. Tan');
  leadId = (
    await owner.query<{ id: string }>(
      `select id from leads where tenant_id = $1 and contact_id = $2 limit 1`,
      [BAKERY, rachel],
    )
  ).rows[0]!.id;
  conversationId = (
    await owner.query<{ id: string }>(
      `insert into conversations (tenant_id, channel, visitor_id, contact_id)
       values ($1, 'widget', gen_random_uuid(), $2) returning id`,
      [BAKERY, rTan],
    )
  ).rows[0]!.id;
});

test.afterEach(async ({ page }) => {
  // A failed run can leave R. Tan merged into Rachel: undo it through the API (D7).
  const open = await owner.query<{ id: string }>(
    `select id from contact_merges
      where tenant_id = $1 and survivor_id = $2 and merged_id = $3 and undone_at is null`,
    [BAKERY, rachel, rTan],
  );
  for (const m of open.rows) await page.request.post(`/api/v1/contacts/merges/${m.id}/undo`);
});

test.afterAll(async () => {
  if (conversationId)
    await owner.query(`delete from conversations where id = $1`, [conversationId]);
  await owner?.end();
});

test('possible duplicate → preview → merge → undo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, OWNER);

  // The thread sidebar's duplicate hint and View contact (SCR-APP-015, AC-8).
  await page.goto(`/inbox/${conversationId}`);
  const sidebar = page.getByTestId('context-sidebar').first();
  await expect(sidebar.getByRole('link', { name: 'View contact' })).toHaveAttribute(
    'href',
    `/contacts/${rTan}`,
  );
  const hint = sidebar.getByTestId('sidebar-duplicates');
  await expect(hint).toHaveText(/Possibly the same person as 1 other contact\./);
  await hint.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${rTan}#duplicates$`));
  await expect(page.getByRole('heading', { name: 'R. Tan', level: 1 })).toBeVisible();

  // To Rachel Tan: the pair is only a suggestion (AC-1), both keep their typed identifier.
  await page.getByTestId('contact-duplicate').getByRole('link', { name: 'Rachel Tan' }).click();
  await expect(page.getByRole('heading', { name: 'Rachel Tan', level: 1 })).toBeVisible();
  await expect(page.getByTestId('contact-identifiers')).toContainText('Not verified');
  await expect(page.getByTestId('contact-conversations')).toContainText('No conversations');
  await expect(page.getByTestId('contact-leads').getByTestId('contact-lead')).toHaveCount(1);
  await expectNoSeriousA11yViolations(page);

  // Preview (AC-4): focus on its heading, the after-merge lines.
  await page.getByRole('button', { name: 'Review merge with R. Tan' }).click();
  const preview = page.getByRole('alertdialog', { name: 'Merge R. Tan into Rachel Tan?' });
  await expect(
    preview.getByRole('heading', { name: 'Merge R. Tan into Rachel Tan?' }),
  ).toBeFocused();
  await expect(preview.getByTestId('merge-preview')).toContainText('1 conversation');
  await expect(preview).toContainText('You can undo this from this page.');
  await expectNoSeriousA11yViolations(page);
  await preview.getByRole('button', { name: 'Merge', exact: true }).click();

  // Merged: R. Tan's chat is on Rachel's page, the toast offers Undo, the merge is listed.
  await expect(preview).toBeHidden();
  await expect(page.getByTestId('contact-toast')).toContainText('Merged R. Tan into Rachel Tan.');
  await expect(page.getByRole('heading', { name: 'Rachel Tan', level: 1 })).toBeFocused();
  const conversations = page.getByTestId('contact-conversations');
  await expect(conversations.getByRole('link', { name: /^Website chat · / })).toHaveAttribute(
    'href',
    `/inbox/${conversationId}`,
  );
  await expect(page.getByTestId('contact-duplicates')).toHaveCount(0);
  await expect(page.getByTestId('contact-merge')).toContainText(/^R\. Tan · .+ · by /);
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 375, height: 5000 });
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The lead page links to the contact (SCR-APP-033).
  await page.goto(`/leads/${leadId}`);
  await page.getByRole('link', { name: 'View contact' }).click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${rachel}\\?from=lead$`));
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Leads');

  // Undo from the Merges card (AC-5): R. Tan is a suggested duplicate again.
  await page.getByRole('button', { name: 'Undo merge with R. Tan' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Undo the merge with R. Tan?' });
  await confirm.getByRole('button', { name: 'Undo merge' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByTestId('contact-toast')).toContainText('Merge undone.');
  await expect(page.getByTestId('contact-merge')).toContainText('Undone');
  await expect(page.getByTestId('contact-duplicate')).toContainText('R. Tan');
  await expect(page.getByTestId('contact-conversations')).toContainText('No conversations');
});
