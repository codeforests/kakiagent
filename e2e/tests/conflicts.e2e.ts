import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-014 AC-10 (UC-12, KB-06, KB-17): the owner's own prices disagree with the fixture
 * site's, so its crawl leaves conflicts. On SCR-APP-020 the owner sees each pair side by
 * side with the newer one suggested, uses the website's value, enters a different one,
 * gives a GST-unknown price its treatment, disables one, meets a conflict that changed
 * meanwhile, and ends on the empty state; the setup step (SCR-APP-008) shows the alert,
 * and the widget answers with the chosen price. The owner's facts are deleted at the end,
 * so review.e2e starts from the same knowledge base.
 */
test.setTimeout(240_000);
const WIDGET_HOST = 'http://localhost:5175/';

/** The owner's prices, each different from the fixture site's (apps/ingest-worker/fixtures). */
const OWNER_PRICES = [
  { name: 'Pandan chiffon cake', unit: '20 cm', price: '27.00' }, // site 28.50
  { name: 'Egg tarts', unit: '6 pieces', price: '11.60' }, // site 12.60
  { name: 'Sourdough loaf', unit: '800 g', price: '9.50' }, // site 9.80
  { name: 'Butter cake', unit: '1 kg', price: '24.00' }, // site 26.00, GST not stated
  { name: 'Pineapple tarts', unit: '30 pieces', price: '30.00' }, // site 32.00
];

async function clearSources(page: Page) {
  await page.evaluate(async () => {
    const { sources } = (await (await fetch('/api/v1/kb/sources')).json()) as {
      sources: { id: string; version: number }[];
    };
    for (const s of sources)
      await fetch(`/api/v1/kb/sources/${s.id}?version=${s.version}`, { method: 'DELETE' });
  });
}

/** Deletes every product fact named like the owner's prices, whatever its status. */
async function clearOwnerFacts(page: Page) {
  await page.evaluate(
    async (names) => {
      for (const name of names) {
        const q = new URLSearchParams({ type: 'product', q: name, limit: '200' });
        const { facts } = (await (await fetch(`/api/v1/kb/facts?${q}`)).json()) as {
          facts: { id: string; version: number; value: { name: string } }[];
        };
        for (const f of facts.filter((f) => f.value.name === name))
          await fetch(`/api/v1/kb/facts/${f.id}?version=${f.version}`, { method: 'DELETE' });
      }
    },
    OWNER_PRICES.map((p) => p.name),
  );
}

async function addOwnerFacts(page: Page) {
  await page.evaluate(async (prices) => {
    for (const value of prices) {
      const res = await fetch('/api/v1/kb/facts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'product', value, gstTreatment: 'inclusive' }),
      });
      if (res.status !== 201) throw new Error(`create fact: ${res.status}`);
    }
  }, OWNER_PRICES);
}

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

const conflictCard = (page: Page, name: string) =>
  page.getByTestId('conflict-card').filter({ has: page.getByRole('heading', { name }) });
// Even after a failure, so the next spec's crawl meets no conflicts of this one's making.
test.afterEach(async ({ page }) => {
  await clearSources(page);
  await clearOwnerFacts(page);
});

const toast = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

test('the owner resolves conflicts between their prices and the website', async ({
  page,
  browser,
}) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/knowledge/sources');
  await clearSources(page);
  await clearOwnerFacts(page);
  await addOwnerFacts(page);
  await crawlFixtureSite(page);

  // SCR-APP-019: conflicted facts link to the Conflicts tab, which counts the conflicts.
  await page.goto('/review');
  const tabs = page.getByRole('navigation', { name: 'Review' });
  await expect(tabs.getByRole('link', { name: /Conflicts/ })).toContainText('5 conflicts');
  await expect(page.getByRole('link', { name: 'Resolve conflict' }).first()).toBeVisible();

  // SCR-APP-008: the setup step tells the owner and links to them.
  await page.goto('/setup/review');
  const alert = page.getByText('5 conflicts need your choice.');
  await expect(alert).toBeVisible();
  await page.getByRole('link', { name: 'Resolve conflicts' }).click();
  await expect(page).toHaveURL(/\/review\/conflicts$/);

  // SCR-APP-020: each conflict side by side, the website (read later) newer and suggested.
  await expect(page.getByTestId('conflict-card')).toHaveCount(5);
  const pandan = conflictCard(page, 'Pandan chiffon cake, 20 cm');
  const columns = pandan.getByTestId('conflict-column');
  await expect(columns).toHaveCount(2);
  await expect(columns.nth(0)).toContainText('Newer');
  await expect(columns.nth(0)).toContainText('S$28.50');
  await expect(columns.nth(0).locator('mark')).toHaveText(
    'Pandan chiffon cake (20 cm) — S$28.50 (GST incl.)',
  );
  await expect(columns.nth(1)).toContainText('S$27.00');
  await expect(columns.nth(1)).toContainText('Entered by you');
  await expect(columns.nth(1)).not.toContainText('Newer');
  await expectNoSeriousA11yViolations(page);
  // Phone width, tall enough that the fixed tab bar covers no target (axe target-size).
  await page.setViewportSize({ width: 390, height: 5000 });
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Use the website's value.
  await pandan
    .getByRole('button', { name: 'Use this value (S$28.50 from kakibakery.test)' })
    .click();
  await expect(toast(page, 'Conflict resolved. Your assistant uses S$28.50')).toBeVisible();
  await expect(page.getByRole('article', { name: /Pandan chiffon cake.*resolved/ })).toBeVisible();

  // Enter a different value.
  await conflictCard(page, 'Egg tarts, 6 pieces')
    .getByRole('button', { name: 'Enter a different value…' })
    .click();
  const enter = page.getByRole('dialog', { name: 'Enter the right value' });
  await expect(enter.getByLabel('Price in S$ (required)')).toHaveValue('12.60');
  await enter.getByLabel('Price in S$ (required)').fill('12.00');
  await enter.getByRole('button', { name: 'Use this value' }).click();
  await expect(enter).toBeHidden();
  await expect(toast(page, 'Conflict resolved. Your assistant uses S$12.00')).toBeVisible();

  // A website price without GST needs the owner's choice first.
  const butter = conflictCard(page, 'Butter cake, 1 kg');
  await expect(butter).toContainText('GST treatment unknown');
  await butter
    .getByRole('button', { name: 'Use this value (S$26.00 from kakibakery.test)' })
    .click();
  await expect(butter.getByText('Choose whether the price includes GST')).toBeVisible();
  await butter.getByLabel('Price includes GST').check();
  await butter
    .getByRole('button', { name: 'Use this value (S$26.00 from kakibakery.test)' })
    .click();
  await expect(toast(page, 'Conflict resolved. Your assistant uses S$26.00')).toBeVisible();

  // Disable one, after a cancel.
  const sourdough = conflictCard(page, 'Sourdough loaf, 800 g');
  await sourdough.getByRole('button', { name: 'Disable this fact…' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(sourdough).toBeVisible();
  await sourdough.getByRole('button', { name: 'Disable this fact…' }).click();
  await confirm.getByRole('button', { name: 'Disable fact' }).click();
  await expect(toast(page, "Disabled. Your assistant won't use")).toBeVisible();
  await expect(page.getByRole('article', { name: /Sourdough loaf.*disabled/ })).toBeVisible();

  // A conflict resolved elsewhere meanwhile: nothing is written, and the owner is told.
  await page.evaluate(async () => {
    const { conflicts } = (await (await fetch('/api/v1/kb/conflicts')).json()) as {
      conflicts: { facts: { id: string; version: number }[] }[];
    };
    const [c] = conflicts;
    const res = await fetch('/api/v1/kb/conflicts/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'disable',
        keepId: c!.facts[0]!.id,
        facts: c!.facts.map(({ id, version }) => ({ id, version })),
      }),
    });
    if (res.status !== 200) throw new Error(`resolve: ${res.status}`);
  });
  const pineapple = conflictCard(page, 'Pineapple tarts, 30 pieces');
  await pineapple
    .getByRole('button', { name: 'Use this value (S$32.00 from kakibakery.test)' })
    .click();
  await expect(toast(page, 'This conflict changed since you loaded it.')).toBeVisible();
  await expect(pineapple).toBeHidden();

  // Empty: nothing left to resolve.
  await page.reload();
  await expect(page.getByText('No conflicts')).toBeVisible();
  await expect(tabs.getByRole('link', { name: /Conflicts/ })).not.toContainText('conflicts');
  await expectNoSeriousA11yViolations(page);

  // Error: the list can't load, then Try again loads it.
  await page.route('**/api/v1/kb/conflicts', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }),
  );
  await page.reload();
  await expect(page.getByText("We couldn't load your conflicts")).toBeVisible();
  await page.unroute('**/api/v1/kb/conflicts');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('No conflicts')).toBeVisible();

  // The widget answers with the price the owner chose.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await openShadowRoots(visitor);
  await visitor.goto(WIDGET_HOST);
  await visitor.getByRole('button', { name: /^Chat with / }).click();
  const panel = visitor.getByRole('dialog');
  await panel.getByLabel('Message').fill('how much is the pandan chiffon cake?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('[data-author="agent"]:not([data-pending])')).toContainText('S$28.50');
  expect(await panel.innerText()).not.toContain('S$27.00');
  await visitorContext.close();
});
