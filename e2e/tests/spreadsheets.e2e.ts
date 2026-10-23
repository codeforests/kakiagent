import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { expectNoSeriousA11yViolations, signIn } from './support.ts';

/**
 * FEAT-016 AC-11 (UC-10, UC-03 6): the owner uploads `price-list.xlsx` on "Add sources",
 * follows "Map columns" to SCR-APP-025, sees the suggested mapping with sample values,
 * previews the import with the rejected rows and their reasons, changes a column, chooses
 * the GST treatment, confirms, watches it import and sees the done state with the rows
 * that weren't imported; an imported fact's page names its row, SKU and stock. An `.xls`
 * file is refused in the browser.
 *
 * `price-list.xlsx` is the ingest worker's fixture: rows 4..15 under a header on row 3;
 * 6 import, 4 are rejected (TBC, a negative stock, RM 12, no price), one repeats row 4,
 * and the empty row 7 isn't a row.
 */
test.setTimeout(300_000);

const FIXTURES = new URL('../../apps/ingest-worker/fixtures/files/', import.meta.url);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const NAMES = [
  'Pandan chiffon cake',
  'Ondeh ondeh cake',
  'Kaya swiss roll',
  'Chocolate fudge cake',
  'Lemon tart',
  'Mango pudding',
];

/** Removes the tenant's sources, and any fact named like the sheet's, from earlier runs. */
async function clearSheet(page: Page) {
  await page.evaluate(async (names) => {
    const { sources } = (await (await fetch('/api/v1/kb/sources')).json()) as {
      sources: { id: string; version: number }[];
    };
    for (const s of sources)
      await fetch(`/api/v1/kb/sources/${s.id}?version=${s.version}`, { method: 'DELETE' });
    for (const name of names) {
      const q = new URLSearchParams({ type: 'product', q: name, limit: '200' });
      const { facts } = (await (await fetch(`/api/v1/kb/facts?${q}`)).json()) as {
        facts: { id: string; version: number; value: { name: string } }[];
      };
      for (const f of facts.filter((f) => f.value.name === name))
        await fetch(`/api/v1/kb/facts/${f.id}?version=${f.version}`, { method: 'DELETE' });
    }
  }, NAMES);
}

test('the owner maps, previews and imports a price list, and sees what was not imported', async ({
  page,
}) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/knowledge/sources');
  await clearSheet(page);

  // SCR-APP-007: spreadsheets go in the files part; an old .xls is refused in the browser.
  await page.goto('/knowledge/sources/new#files');
  await expect(page.getByText(/Price lists in Excel \(\.xlsx\) or CSV are imported/)).toBeVisible();
  await page.getByTestId('file-input').setInputFiles({
    name: 'old-prices.xls',
    mimeType: 'application/vnd.ms-excel',
    buffer: readFileSync(new URL('legacy.xls', FIXTURES)),
  });
  const xls = page.getByTestId('upload-row').filter({ hasText: 'old-prices.xls' });
  await expect(xls).toContainText('Save it as .xlsx or CSV first');

  await page.getByTestId('file-input').setInputFiles({
    name: 'price-list.xlsx',
    mimeType: XLSX,
    buffer: readFileSync(new URL('price-list.xlsx', FIXTURES)),
  });
  const row = page.getByTestId('upload-row').filter({ hasText: 'price-list.xlsx' });
  await expect(row.getByText('Map columns', { exact: true }).first()).toBeVisible({
    timeout: 120_000,
  });
  await row.getByRole('link', { name: 'Map columns: price-list.xlsx' }).click();

  // SCR-APP-025, mapping: the suggestion, with a sample value for each column.
  await expect(page.getByRole('heading', { name: 'price-list.xlsx' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Match your columns' })).toBeVisible();
  await expect(page.getByText('Checked for malware: none found')).toBeVisible();
  await expect(
    page.getByText(/We read 11 rows from the sheet "Prices", starting at row 4/),
  ).toBeVisible();
  const selected = (field: string) => page.getByTestId(`map-${field}`).locator('option:checked');
  await expect(selected('product')).toHaveText('Product — e.g. Pandan chiffon cake');
  await expect(selected('price')).toHaveText('Price (incl. GST) — e.g. 38');
  await expect(selected('unit')).toHaveText('Size — e.g. whole');
  await expect(selected('sku')).toHaveText('Item code — e.g. PC-01');
  await expect(selected('stock')).toHaveText('Stock — e.g. 12');
  await expect(selected('service')).toHaveText('Not in this sheet');
  await expect(page.getByLabel('Yes, prices include GST')).toBeChecked();
  await expectNoSeriousA11yViolations(page);

  // A mapping that can't work says why, in the browser.
  await page.getByTestId('map-stock').selectOption({ label: 'Size — e.g. whole' });
  await page.getByRole('button', { name: 'Preview import' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'This column is already used for Unit or size',
  );
  await page.getByTestId('map-stock').selectOption({ label: 'Stock — e.g. 12' });

  // Preview: the summary, the rows to import and the rows that can't be, with reasons.
  await page.getByRole('button', { name: 'Preview import' }).click();
  const preview = page.getByTestId('preview');
  await expect(preview.getByRole('heading', { name: '6 rows will be imported' })).toBeVisible();
  await expect(preview).toContainText("4 rows can't be imported (listed below)");
  await expect(preview).toContainText('1 repeated row will be skipped');
  await expect(page.getByTestId('preview-row')).toHaveCount(6);
  await expect(page.getByTestId('preview-row').first()).toContainText('Pandan chiffon cake');
  await expect(page.getByTestId('preview-row').first()).toContainText('S$38.00');
  const rejects = page.getByTestId('reject-row');
  await expect(rejects).toHaveCount(4);
  await expect(rejects.nth(0)).toContainText("Row 8The price isn't an amount in dollars");
  await expect(rejects.nth(1)).toContainText("Row 9Stock isn't a whole number");
  await expect(rejects.nth(2)).toContainText("Row 10The price isn't in Singapore dollars");
  await expect(rejects.nth(3)).toContainText('Row 11No price');
  await expectNoSeriousA11yViolations(page);

  // Changing a column hides the preview; the owner previews again, choosing the GST.
  await page.getByTestId('map-unit').selectOption({ label: 'Not in this sheet' });
  await expect(page.getByTestId('preview')).toHaveCount(0);
  await page.getByTestId('map-unit').selectOption({ label: 'Size — e.g. whole' });
  await page.getByLabel('No, GST is added on top').check();
  await page.getByLabel('Yes, prices include GST').check();
  await page.getByRole('button', { name: 'Preview import' }).click();
  await expect(preview.getByRole('heading', { name: '6 rows will be imported' })).toBeVisible();

  // Confirm: the import approves the rows.
  await page.getByRole('button', { name: 'Import 6 rows' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Import 6 rows?' });
  await expect(dialog).toContainText("They're approved as you import them");
  await dialog.getByRole('button', { name: 'Import 6 rows' }).click();

  // Importing, then done: the rows that weren't imported are shown first.
  await expect(page.getByText('6 rows imported', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(
    page.getByText("They're approved and your assistant can use them now."),
  ).toBeVisible();
  const figures = page.locator('.source-figures');
  await expect(figures.getByText('Imported', { exact: true }).locator('..')).toContainText('6');
  await expect(figures.getByText('Not imported', { exact: true }).locator('..')).toContainText('4');
  await expect(page.getByTestId('row-filter').locator('option:checked')).toHaveText(
    'Not imported (4)',
  );
  await expect(page.getByTestId('sheet-row')).toHaveCount(4);
  await expect(page.getByTestId('sheet-row').first()).toContainText('Row 8');
  await expect(page.getByTestId('sheet-row').first()).toContainText('PC-04');
  await expect(page.getByTestId('mapping-summary')).toContainText('Price (incl. GST)');
  await expectNoSeriousA11yViolations(page);

  // SCR-APP-023: the source's summary.
  await page.goto('/knowledge/sources');
  const sourceRow = page.getByTestId('source-row').filter({ hasText: 'price-list.xlsx' });
  await expect(sourceRow).toContainText(/Uploaded .+ · Excel workbook · \d+ KB/);
  await expect(sourceRow).toContainText('6 facts imported · 4 rows not imported');

  // SCR-APP-028: an imported fact names its row, and shows its SKU and stock.
  await sourceRow.getByRole('link', { name: 'price-list.xlsx' }).click();
  await page.getByRole('link', { name: 'See imported facts' }).click();
  await page
    .getByRole('link', { name: /Ondeh ondeh cake/ })
    .first()
    .click();
  await expect(page.getByText(/From row 5 of price-list\.xlsx · Imported/)).toBeVisible();
  await expect(page.getByTestId('source-passage')).toContainText(
    'PC-02 | Ondeh ondeh cake | whole | 42.5 | 8',
  );
  const imported = page.getByTestId('imported-fields');
  await expect(imported).toContainText('SKU or item codePC-02');
  await expect(imported).toContainText(/Stock8 \(as of \d{1,2} \w{3} \d{4}\)/);
  await expectNoSeriousA11yViolations(page);
});
