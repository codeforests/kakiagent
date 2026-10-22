import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, signIn } from './support.ts';

/**
 * FEAT-012 AC-12 (UC-03 4–5, J1): the owner adds the fixture site as a website source,
 * the attestation gates the start, the crawl runs to Ready on the fake extractor, the
 * page list shows what was read and why the rest wasn't, and a fact from it shows its
 * source passage. A site that can't be read fails with its reason and Retry.
 *
 * The fixture site (`pnpm fixtures:site`, port 5176) answers for `kakibakery.test`
 * through the worker's dev-only host map; `closed.kakibakery-gone.test` resolves nowhere.
 */
test.setTimeout(240_000);

/** Removes the tenant's sources from an earlier run, through the API as the owner. */
async function clearSources(page: Page) {
  await page.evaluate(async () => {
    const { sources } = (await (await fetch('/api/v1/kb/sources')).json()) as {
      sources: { id: string; version: number; status: string }[];
    };
    for (const s of sources)
      await fetch(`/api/v1/kb/sources/${s.id}?version=${s.version}`, { method: 'DELETE' });
  });
}

test('the owner adds a website, watches it crawl, and sees what was read', async ({ page }) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/knowledge/sources');
  await clearSources(page);
  await page.reload();

  // SCR-APP-023, empty.
  await expect(page.getByRole('heading', { name: 'No sources yet' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Knowledge' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // SCR-APP-007: the attestation blocks the start until ticked.
  await page.getByRole('link', { name: 'Add website' }).click();
  await expect(page.getByRole('heading', { name: 'Add website' })).toBeVisible();
  await expect(page.getByText(/Your plan reads up to \d+ pages\./)).toBeVisible();
  await page.getByLabel('Website address (required)').fill('https://kakibakery.test');
  await page.getByRole('button', { name: 'Start reading pages' }).click();
  const summary = page.getByRole('alert').filter({ hasText: 'Check these fields' });
  await expect(summary).toContainText('Confirm you own or are authorised to use this website');
  await expect(page).toHaveURL(/\/knowledge\/sources\/new$/);
  await expectNoSeriousA11yViolations(page);
  await page
    .getByLabel(
      "I own this website or am authorised to use its content for my business's assistant.",
    )
    .check();
  await page.getByRole('button', { name: 'Start reading pages' }).click();

  // SCR-APP-024: Queued or Processing, then Ready.
  await expect(page).toHaveURL(/\/knowledge\/sources\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'kakibakery.test' })).toBeVisible();
  await expect(page.getByText(/^(Queued|Processing|Ready)$/).first()).toBeVisible();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Facts found')).toBeVisible();

  // The page list: read, excluded with reasons, failed with the status.
  const rows = page.getByTestId('page-row');
  await expect(rows.filter({ hasText: 'Kaya toast' }).filter({ hasText: 'Read' })).toHaveCount(1);
  await expect(rows.filter({ hasText: /Excluded\s*blocked by robots\.txt/ })).toHaveCount(2);
  await expect(rows.filter({ hasText: /Excluded\s*redirects to another site/ })).toHaveCount(1);
  await expect(rows.filter({ hasText: /Excluded\s*not a web page/ })).toHaveCount(1);
  await expect(rows.filter({ hasText: /Excluded\s*same content as another page/ })).toHaveCount(2);
  await expect(rows.filter({ hasText: /Failed\s*the site returned 404/ })).toHaveCount(1);
  await page.getByLabel('Show').selectOption('excluded');
  await expect(rows).toHaveCount(6);
  await expectNoSeriousA11yViolations(page);

  // The list row: "N facts · N need review".
  await page.getByRole('link', { name: 'Sources', exact: true }).first().click();
  await expect(page.getByTestId('source-row').first()).toContainText(
    /\d+ facts · \d+ need review · \d+ pages read/,
  );
  await expectNoSeriousA11yViolations(page);

  // A fact from the source shows its passage (SCR-APP-028).
  await page.getByRole('link', { name: 'kakibakery.test' }).click();
  await page.getByText('Facts found').locator('..').getByRole('link').click();
  await expect(page).toHaveURL(/\/knowledge\?sourceId=/);
  await page
    .getByRole('link', { name: /Chocolate fudge cake/ })
    .first()
    .click();
  await expect(page.getByTestId('source-passage')).toHaveText(
    'Chocolate fudge cake (1 kg) — S$55.00 (GST incl.)',
  );
  await expect(page.getByRole('link', { name: 'Open source' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('a site that cannot be read fails with its reason and Retry', async ({ page }) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/knowledge/sources/new');
  await page.getByLabel('Website address (required)').fill('closed.kakibakery-gone.test');
  await page
    .getByLabel(
      "I own this website or am authorised to use its content for my business's assistant.",
    )
    .check();
  await page.getByRole('button', { name: 'Start reading pages' }).click();
  await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByRole('alert')).toContainText('No page could be read.');

  await page.goto('/knowledge/sources');
  const row = page.getByTestId('source-row').filter({ hasText: 'closed.kakibakery-gone.test' });
  await expect(row).toContainText('No page could be read.');
  // The Knowledge nav entry and the Sources tab show the failed count (KB-12).
  await expect(page.getByRole('navigation', { name: 'Knowledge' })).toContainText('1 failed');
  await row.getByRole('button', { name: 'Retry closed.kakibakery-gone.test' }).click();
  await expect(row).toContainText(/Queued|Processing|Reading pages|Failed/);
  await expect(row.getByText('Failed', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expectNoSeriousA11yViolations(page);
  await clearSources(page);
});
