import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-055 §6 (APR-01, APR-02, APR-04, APR-06; SCR-WGT-002, SCR-APP-017, SCR-APP-018): a
 * widget visitor asks for a quote and is told the team is checking; the Owner finds it on
 * Approvals, adds a price and approves with the edit, and the visitor gets the quote card.
 * A second request is rejected with a reason and the visitor gets the follow-up notice. The
 * dev tenant has no product facts, so drafts start with no line ("Price to set"). Each
 * request names a run tag, which the row's headline carries (the request's text). SLA
 * escalation, expiry, 409 races and agent rights are covered by integration tests.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const OWNER = 'owner@kaki-bakery.test';
const WAITING = /Our team is (still )?checking/;
const REJECTED = "Our team couldn't confirm this one, but they'll follow up with you.";

test.describe.configure({ mode: 'serial' });

async function owner(browser: Browser, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await signIn(page, OWNER);
  return page;
}

async function askForQuote(browser: Browser, text: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  await panel.getByLabel('Message', { exact: true }).fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
  // AC-1: the waiting notice, with no price typed by the model.
  await expect(panel.locator('.notice', { hasText: WAITING })).toBeVisible({ timeout: 30_000 });
  return { context, page, panel };
}

/** The Owner opens the pending row whose headline carries the run tag. */
async function openRow(page: Page, tag: string) {
  await page.goto('/approvals');
  await expect(page.getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible();
  const row = page.getByTestId('approval-row').filter({ hasText: tag });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText('Price to set')).toBeVisible();
  await row.getByRole('link').click();
  await expect(page.getByRole('heading', { name: /^Quote for / })).toBeVisible();
}

test('a quote is approved with an edit and reaches the visitor (AC-1, AC-2, AC-5, AC-6, AC-13)', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const tag = `Q${Date.now().toString(36)}`;
  const visitor = await askForQuote(
    browser,
    `Can I get a quote for ${tag} 20 boxes of kueh lapis for Friday?`,
  );
  const page = await owner(browser);
  try {
    // The nav badge counts it.
    await expect(
      page
        .getByRole('navigation')
        .getByRole('link', { name: /Approvals/ })
        .first(),
    ).toContainText(/\d/);
    await page.goto('/approvals');
    await expect(page.getByTestId('approval-row').first()).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    await openRow(page, tag);
    await expect(page.getByText("Your assistant couldn't match a price.")).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    // Edit: add a line; a bad price names the field first.
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('button', { name: 'Add a line' }).click();
    await page.getByLabel('Line 1', { exact: true }).fill('Kueh lapis box');
    await page.getByLabel('Quantity').fill('20');
    await page.getByLabel('Unit price').fill('abc');
    await page.getByRole('button', { name: 'Approve and send' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Enter a price like 3.50' }),
    ).toBeFocused();
    await page.getByLabel('Unit price').fill('12.50');
    await page.getByLabel('Note to the visitor').fill('Ready for collection on Friday at 10 am.');
    await expect(page.getByText('Total S$250.00')).toBeVisible();
    await page.getByRole('button', { name: 'Approve and send' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Quote sent to the visitor' }),
    ).toBeVisible();
    await expect(page.getByTestId('approval-decided')).toContainText(
      'You approved this with edits',
    );

    // AC-6: the visitor gets the quote card built from the approved values.
    const card = visitor.panel.getByRole('group', { name: 'Your quote' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('20 × Kueh lapis box');
    await expect(card).toContainText('S$12.50 each');
    await expect(card).toContainText('S$250.00');
    await expect(card).toContainText('Ready for collection on Friday at 10 am.');
    await expectNoSeriousA11yViolations(visitor.page);

    // Decided tab lists it.
    await page.goto('/approvals?view=decided');
    await expect(
      page.getByTestId('approval-row').filter({ hasText: tag }).getByText('Approved with edits'),
    ).toBeVisible();
  } finally {
    await visitor.context.close();
    await page.context().close();
  }
});

test('a rejected request tells the visitor the team will follow up (AC-1, AC-5, AC-13)', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const tag = `R${Date.now().toString(36)}`;
  const visitor = await askForQuote(
    browser,
    `Please quote ${tag} a custom wedding cake for 300 guests`,
  );
  // Phone width: the actions sit above the tab bar; axe at a tall viewport (code-map pitfall).
  const page = await owner(browser, { width: 375, height: 5000 });
  try {
    await page.goto('/approvals');
    await expect(page.getByTestId('approval-row').first()).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await openRow(page, tag);
    await expectNoSeriousA11yViolations(page);

    await page.getByRole('button', { name: 'Reject' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reject this request?' });
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(dialog.getByText('Enter a reason')).toBeVisible();
    await dialog.getByLabel('Reason (only your team sees this)').fill('We are fully booked');
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Request rejected. The visitor was told.' }),
    ).toBeVisible();
    await expect(page.getByTestId('approval-decided')).toContainText('We are fully booked');

    await expect(visitor.panel.locator('.notice', { hasText: REJECTED })).toBeVisible({
      timeout: 15_000,
    });
    await expect(visitor.panel.getByRole('group', { name: 'Your quote' })).toHaveCount(0);
  } finally {
    await visitor.context.close();
    await page.context().close();
  }
});
