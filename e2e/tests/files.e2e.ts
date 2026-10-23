import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { expectNoSeriousA11yViolations, signIn } from './support.ts';

/**
 * FEAT-015 AC-10 (UC-03 6, UC-10): the owner uploads a PDF and a photo on "Add sources"
 * with upload progress; both are checked for malware and read (the photo by OCR) to
 * Ready; the file source page lists its pages; a fact from the PDF shows its file
 * provenance. An EICAR file fails as malware with "Upload again" and no Retry, and a
 * 26 MB file is refused in the browser before anything is uploaded.
 *
 * The files are the ingest worker's fixtures; EICAR is built here from two halves, so no
 * checkout holds it.
 */
test.setTimeout(300_000);

const FIXTURES = new URL('../../apps/ingest-worker/fixtures/files/', import.meta.url);
const fixture = (name: string, mimeType: string) => ({
  name,
  mimeType,
  buffer: readFileSync(new URL(name, FIXTURES)),
});
const eicar = () => ({
  name: 'invoice.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
});

/** Removes the tenant's sources from an earlier run, through the API as the owner. */
async function clearSources(page: Page) {
  await page.evaluate(async () => {
    const { sources } = (await (await fetch('/api/v1/kb/sources')).json()) as {
      sources: { id: string; version: number }[];
    };
    for (const s of sources)
      await fetch(`/api/v1/kb/sources/${s.id}?version=${s.version}`, { method: 'DELETE' });
  });
}

const rowOf = (page: Page, name: string) =>
  page.getByTestId('upload-row').filter({ hasText: name });

test('the owner uploads files, sees them checked and read, and a fact names its page', async ({
  page,
}) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/knowledge/sources');
  await clearSources(page);
  await page.reload();

  // SCR-APP-023 → SCR-APP-007: "Add sources" has the website and files parts.
  await page.getByRole('link', { name: 'Add sources' }).click();
  await expect(page.getByRole('heading', { name: 'Add sources' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your website' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible();
  await expect(
    page.getByText(
      /Every file is checked for malware before we read it\. Your plan holds up to \d+ files; you've added 0\./,
    ),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // A file over 25 MB is refused in the browser: nothing is uploaded.
  const uploads: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/kb/uploads')) uploads.push(r.url());
  });
  await page.getByTestId('file-input').setInputFiles({
    name: 'huge-catalogue.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(26 * 1024 * 1024, 0x20),
  });
  await expect(rowOf(page, 'huge-catalogue.pdf')).toContainText('Over 25 MB');
  expect(uploads).toEqual([]);

  // A PDF and a photo: upload progress (the PUT to storage is held a moment so the bar
  // can be seen), then each row follows its source to Ready.
  await page.route('**/kaki-local-quarantine/**', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page
    .getByTestId('file-input')
    .setInputFiles([
      fixture('price-list.pdf', 'application/pdf'),
      fixture('menu-photo.png', 'image/png'),
    ]);
  await expect(page.getByRole('progressbar', { name: 'Uploading price-list.pdf' })).toBeVisible();
  await expect(rowOf(page, 'price-list.pdf')).toContainText(/Uploading \d+%/);
  for (const name of ['price-list.pdf', 'menu-photo.png']) {
    const row = rowOf(page, name);
    await expect(row.getByRole('link', { name: `View ${name}` })).toBeVisible({
      timeout: 60_000,
    });
    await expect(row.getByText('Ready', { exact: true })).toBeVisible({ timeout: 120_000 });
  }
  expect(uploads).toHaveLength(2);
  await expectNoSeriousA11yViolations(page);

  // SCR-APP-023: file rows with their type and size, and the OCR count for the photo.
  await page.goto('/knowledge/sources');
  const pdfRow = page.getByTestId('source-row').filter({ hasText: 'price-list.pdf' });
  await expect(pdfRow).toContainText(/Uploaded .+ · PDF · \d+ KB/);
  await expect(pdfRow).toContainText(/\d+ facts · \d+ need review · 3 pages read/);
  const photoRow = page.getByTestId('source-row').filter({ hasText: 'menu-photo.png' });
  await expect(photoRow).toContainText('PNG image');
  await expectNoSeriousA11yViolations(page);

  // SCR-APP-024: the PDF's pages, labelled by page, with no links out.
  await pdfRow.getByRole('link', { name: 'price-list.pdf' }).click();
  await expect(page.getByRole('heading', { name: 'price-list.pdf' })).toBeVisible();
  await expect(page.getByText('Checked for malware: none found')).toBeVisible();
  await expect(page.getByText('Pages read')).toBeVisible();
  const rows = page.getByTestId('page-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Page 1');
  await expect(rows.first().getByRole('link')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);

  // SCR-APP-028: a fact from the PDF says which page of which file it came from.
  await page.getByText('Facts found').locator('..').getByRole('link').click();
  await page
    .getByRole('link', { name: /Chocolate fudge cake/ })
    .first()
    .click();
  await expect(page.getByTestId('source-passage')).toContainText('Chocolate fudge cake (1 kg)');
  await expect(page.getByText(/From page 1 of price-list\.pdf/)).toBeVisible();

  // The photo was read by OCR.
  await page.goto('/knowledge/sources');
  await photoRow.getByRole('link', { name: 'menu-photo.png' }).click();
  await expect(page.getByText('1 read with OCR')).toBeVisible();
});

test('a file with malware is deleted unread and must be uploaded again', async ({ page }) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/knowledge/sources/new#files');
  await page.getByTestId('file-input').setInputFiles(eicar());
  const row = rowOf(page, 'invoice.pdf');
  await expect(row.getByText('Failed', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(row).toContainText(
    'This file contains malware, so we deleted it without reading it.',
  );

  await row.getByRole('link', { name: 'View invoice.pdf' }).click();
  await expect(page.getByRole('heading', { name: 'invoice.pdf' })).toBeVisible();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('This file contains malware');
  await expect(alert.getByRole('link', { name: 'Upload again: invoice.pdf' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(page.getByText('No pages were read.')).toBeVisible();
  await expect(page.getByText('Checked for malware: none found')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
});
