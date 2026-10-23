import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-013 AC-9 (UC-15, J1 "crawl → review"): after the fixture site's crawl, the owner
 * reviews its facts on SCR-APP-019: approves one and undoes it, approves by keyboard,
 * edits and approves one, rejects one, gives a GST-unknown price its treatment, cancels
 * and then confirms Approve all for the source, and the widget answers with an approved
 * price. Approve all is scoped to the source, so the dev seed's fact in review (S$70,
 * FEAT-022's E2E) stays out of answers.
 */
test.setTimeout(240_000);
const WIDGET_HOST = 'http://localhost:5175/';

async function clearSources(page: Page) {
  await page.evaluate(async () => {
    const { sources } = (await (await fetch('/api/v1/kb/sources')).json()) as {
      sources: { id: string; version: number }[];
    };
    for (const s of sources)
      await fetch(`/api/v1/kb/sources/${s.id}?version=${s.version}`, { method: 'DELETE' });
  });
}

/** Adds the fixture site through the API and waits until its facts are in review. */
async function crawlFixtureSite(page: Page) {
  await page.evaluate(async () => {
    const res = await fetch('/api/v1/kb/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'website', url: 'https://kakibakery.test', attested: true }),
    });
    if (res.status !== 201) throw new Error(`create source: ${res.status}`);
  });
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { sources } = (await (await fetch('/api/v1/kb/sources')).json()) as {
            sources: { status: string }[];
          };
          return sources[0]?.status;
        }),
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe('ready');
}

const card = (page: Page, name: string | RegExp) =>
  page.getByTestId('review-card').filter({ has: page.getByRole('heading', { name }) });

test('the owner reviews crawled facts one by one and with Approve all', async ({
  page,
  browser,
}) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/knowledge/sources');
  await clearSources(page);
  await crawlFixtureSite(page);
  await page.goto('/');

  // The Review nav entry shows how many facts wait.
  const nav = page.getByRole('navigation', { name: 'Main' }).first();
  await expect(nav.getByRole('link', { name: /Review/ })).toContainText(/\d+ facts to review/);

  // SCR-APP-019: groups in the KB-16 order, cards with passages.
  await nav.getByRole('link', { name: /Review/ }).click();
  await expect(page.getByRole('heading', { name: 'Review', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Review' })).toBeVisible();
  const groups = page.locator('.review-group h2');
  await expect(groups.first()).toHaveText('Prices');
  expect(await groups.allInnerTexts()).toEqual(['Prices', 'Policies', 'Promotions', 'FAQs']);
  const fudge = card(page, /Chocolate fudge cake/);
  await expect(fudge.locator('mark')).toHaveText(
    'Chocolate fudge cake (1 kg) — S$55.00 (GST incl.)',
  );
  await expect(fudge).toContainText('% confidence');
  await expectNoSeriousA11yViolations(page);

  // Only this source's facts from here on.
  const source = page.getByLabel('Source');
  const option = source.locator('option', { hasText: 'kakibakery.test' });
  await source.selectOption((await option.getAttribute('value'))!);
  await expect(
    page.getByRole('button', { name: 'Approve all from kakibakery.test…' }),
  ).toBeVisible();

  // Approve, then Undo.
  await fudge.getByRole('button', { name: 'Approve', exact: true }).click();
  const fudgeDone = page.getByTestId('review-done').filter({ hasText: 'Chocolate fudge cake' });
  await expect(fudgeDone).toContainText('Approved');
  await expect(
    page.getByRole('status').filter({ hasText: 'Approved. Your assistant' }),
  ).toBeVisible();
  await fudgeDone.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Back in review.' })).toBeVisible();
  await expect(card(page, /Chocolate fudge cake/)).toBeVisible();

  // The keyboard: focus the card, A approves it.
  await card(page, /Chocolate fudge cake/).focus();
  await page.keyboard.press('a');
  await expect(fudgeDone).toContainText('Approved');
  // J moves to the next card.
  await page.getByTestId('review-card').first().focus();
  await page.keyboard.press('j');
  await expect(page.getByTestId('review-card').nth(1)).toBeFocused();

  // Edit and approve.
  await card(page, /Pandan chiffon cake/)
    .getByRole('button', { name: 'Edit and approve' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Edit and approve' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Price in S$ (required)').fill('29.50');
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole('button', { name: 'Approve fact' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByTestId('review-done').filter({ hasText: 'Pandan chiffon cake' }),
  ).toContainText('Approved');

  // Reject.
  await card(page, /Egg tarts/)
    .getByRole('button', { name: 'Reject' })
    .click();
  await expect(page.getByTestId('review-done').filter({ hasText: 'Egg tarts' })).toContainText(
    'Rejected',
  );

  // A GST-unknown price needs the treatment (KB-15).
  const butter = card(page, /Butter cake/);
  await expect(butter).toContainText('GST treatment unknown');
  await butter.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(butter).toContainText('Choose whether the price includes GST');
  await butter.getByLabel('Price includes GST').check();
  await butter.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByTestId('review-done').filter({ hasText: 'Butter cake' })).toContainText(
    'Approved',
  );

  // Approve all for the source: the counts, the excluded GST-unknown prices; Cancel first.
  await page.getByRole('button', { name: 'Approve all from kakibakery.test…' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText(/Approve \d+ facts from kakibakery\.test\?/);
  const counts = confirm.getByTestId('approve-all-counts');
  await expect(counts).toContainText('Prices');
  await expect(counts).toContainText('Policies');
  await expect(counts).toContainText('FAQs');
  const excludedText = confirm.getByText(
    /^\d+ prices? with an unknown GST treatment (isn't|aren't) included\. Review them one by one\.$/,
  );
  await expect(excludedText).toBeVisible();
  const unknown = Number(/^\d+/.exec(await excludedText.innerText())![0]);
  await expectNoSeriousA11yViolations(page);
  const before = await page.getByTestId('review-card').count();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByTestId('review-card')).toHaveCount(before);

  await page.getByRole('button', { name: 'Approve all from kakibakery.test…' }).click();
  const label = await confirm.getByRole('heading').innerText();
  const n = Number(/Approve (\d+) facts/.exec(label)![1]);
  await confirm.getByRole('button', { name: `Approve ${n} facts` }).click();
  await expect(page.getByRole('status').filter({ hasText: `${n} facts approved.` })).toBeVisible();
  // Left: the GST-unknown prices.
  await expect(page.getByTestId('review-card')).toHaveCount(unknown);
  await expect(page.getByTestId('review-card').first()).toContainText('GST treatment unknown');

  // The widget answers with an approved price.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await openShadowRoots(visitor);
  await visitor.goto(WIDGET_HOST);
  await visitor.getByRole('button', { name: /^Chat with / }).click();
  const panel = visitor.getByRole('dialog');
  await panel.getByLabel('Message').fill('how much is the ondeh-ondeh cake?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('[data-author="agent"]:not([data-pending])')).toContainText('S$62.00');
  expect(await panel.innerText()).not.toContain('S$70');
  await visitorContext.close();

  // SCR-APP-008: the setup step shows the same queue.
  await page.goto('/setup/review');
  await expect(page.getByRole('heading', { name: 'Review your facts' })).toBeVisible();
  await expect(page.getByText('Step 3 of the setup')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue' })).toBeVisible();
  await expect(card(page, /Red velvet cake/)).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await clearSources(page);
});
