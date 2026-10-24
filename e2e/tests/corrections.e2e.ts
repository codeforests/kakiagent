import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-018 AC-3, AC-6, AC-7, AC-11 (J11; KB-17, KB-18, UC-16; SCR-APP-021, SCR-APP-022): a
 * visitor asks a price on the widget, the owner teaches a new price in Coach without
 * confirming it, finds it in Review › Corrections, edits the fix and accepts it, and the
 * comparison shows the old price the customer got next to the new one. Then the fact is
 * made overdue through the owner connection, the daily scan flags it, and the owner
 * re-confirms it in one tap. Against the seeded bakery and the fake model.
 */
const WIDGET_HOST = 'http://localhost:5175/';

function ownerUrl(): string {
  if (process.env.DATABASE_OWNER_URL) return process.env.DATABASE_OWNER_URL;
  const env = readFileSync(new URL('../../packages/db/.env', import.meta.url), 'utf8');
  const url = /^DATABASE_OWNER_URL=(.+)$/m.exec(env)?.[1];
  if (!url) throw new Error('DATABASE_OWNER_URL is not set (run scripts/gen-local-env.mjs)');
  return url.trim();
}

async function createFact(page: Page, name: string, price: string): Promise<string> {
  return page.evaluate(
    async ({ n, p }) => {
      const res = await fetch('/api/v1/kb/facts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'product',
          value: { name: n, price: p },
          gstTreatment: 'inclusive',
        }),
      });
      return ((await res.json()) as { fact: { id: string } }).fact.id;
    },
    { n: name, p: price },
  );
}

async function deleteFact(page: Page, id: string) {
  await page.evaluate(async (factId) => {
    const { fact } = (await (await fetch(`/api/v1/kb/facts/${factId}`)).json()) as {
      fact: { version: number };
    };
    await fetch(`/api/v1/kb/facts/${factId}?version=${fact.version}`, { method: 'DELETE' });
  }, id);
}

test('a coaching correction is edited in the queue and compared, a stale fact re-confirmed', async ({
  page: owner,
  browser,
}) => {
  // A name unique to this run, so facts and conversations from earlier runs don't match.
  const token = Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
  const name = `Pandan chiffon ${token}`;
  const question = `how much is the ${name.toLowerCase()}?`;
  await signIn(owner, 'owner@kaki-bakery.test');
  const factId = await createFact(owner, name, '12');

  // The visitor asks and is quoted the old price.
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await openShadowRoots(visitor);
  await visitor.goto(WIDGET_HOST);
  await visitor.getByRole('button', { name: /^Chat with / }).click();
  const panel = visitor.getByRole('dialog');
  await panel.getByLabel('Message').fill(question);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('[data-author="agent"]:not([data-pending])')).toContainText('S$12.00');
  await context.close();

  // The owner teaches a new price in Coach and leaves the proposal open.
  await owner.goto('/coach');
  const composer = owner.getByLabel('Message');
  await composer.fill(`How much is the ${name}?`);
  await owner.getByRole('button', { name: 'Send' }).click();
  await expect(owner.getByRole('log', { name: 'Practice chat' })).toContainText('12.00');
  await composer.fill(`${name} went up to $14`);
  await composer.press('Enter');
  const card = owner.getByRole('region', { name: 'Proposed change' });
  await expect(card).toContainText('S$14.00');

  // SCR-APP-021: the open item, nothing changed yet (AC-3).
  await owner.goto('/review/corrections');
  await expect(owner.getByRole('heading', { name: 'Review', level: 1 })).toBeVisible();
  await expect(owner.getByRole('link', { name: /^Corrections/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const row = owner.getByTestId('correction-row').filter({ hasText: name }).first();
  await expect(row).toContainText('Coaching');
  const link = row.getByRole('link', { name: new RegExp(`^Price of ${name}: S\\$12\\.00`) });
  await expect(link).toContainText('S$14.00');
  await expectNoSeriousA11yViolations(owner);
  const unchanged = await owner.evaluate(
    async (id) =>
      (
        (await (await fetch(`/api/v1/kb/facts/${id}`)).json()) as {
          fact: { value: { price: string } };
        }
      ).fact.value.price,
    factId,
  );
  expect(unchanged).toBe('12.00');

  // SCR-APP-022: open, then edit the fix and accept it (UC-16 3).
  await link.click();
  await expect(owner).toHaveURL(/\/review\/corrections\/[0-9a-f-]{36}$/);
  await expect(owner.getByRole('heading', { name: 'Where it came from' })).toBeVisible();
  await expect(owner.getByRole('heading', { name: 'Facts involved' })).toBeVisible();
  await expect(owner.getByRole('heading', { name: 'Proposed fix' })).toBeVisible();
  await expect(owner.getByRole('link', { name: 'Open in Coach' })).toBeVisible();
  await expectNoSeriousA11yViolations(owner);
  await owner.getByRole('button', { name: 'Edit fix' }).click();
  const dialog = owner.getByRole('dialog', { name: 'Edit fix' });
  await expect(dialog.getByLabel('Price in S$ (required)')).toHaveValue('14.00');
  await dialog.getByLabel('Price in S$ (required)').fill('15');
  await expectNoSeriousA11yViolations(owner);
  await dialog.getByRole('button', { name: 'Accept edited fix' }).click();

  // Applied: the banner, then the comparison of the past answer (AC-7).
  await expect(owner.getByText('Fix accepted. Your assistant now uses it.')).toBeFocused();
  await expect(owner.getByRole('heading', { name: 'Past answers' })).toBeVisible();
  await expect(owner.getByText(/^Replay complete\. 1 answer changed\.$/)).toBeVisible();
  const turn = owner.getByRole('listitem', { name: 'Question 1 of 1' });
  await expect(turn).toContainText(question);
  await expect(turn.getByTestId('replay-original')).toContainText('S$12.00');
  await expect(turn.getByTestId('replay-now')).toContainText('S$15.00');
  await expect(turn.getByText('Answer changed')).toBeVisible();
  await expect(owner.getByText('Edited before accepting')).toBeVisible();
  await expectNoSeriousA11yViolations(owner);

  // The closed list shows the decision.
  await owner.goto('/review/corrections?status=closed');
  await expect(owner.getByTestId('correction-row').filter({ hasText: name }).first()).toContainText(
    'Edited and accepted',
  );

  // KB-17: the fact goes overdue and the daily scan flags it (D1, run here directly).
  const db = new pg.Client({ connectionString: ownerUrl() });
  await db.connect();
  try {
    await db.query(
      `update facts set last_confirmed_at = now() - interval '8 months' where id = $1`,
      [factId],
    );
    await db.query('select * from kb_stale_scan()');
  } finally {
    await db.end();
  }

  // One tap re-confirms it from the list (AC-6).
  await owner.goto('/review/corrections?source=stale');
  const stale = owner.getByTestId('correction-row').filter({ hasText: name }).first();
  await expect(stale).toContainText('Overdue for review');
  await expect(stale).toContainText(`Re-confirm: ${name}, last confirmed 8 months ago`);
  await expectNoSeriousA11yViolations(owner);
  await stale.getByRole('button', { name: `Re-confirm ${name}` }).click();
  await expect(owner.getByRole('status').filter({ hasText: 'Re-confirmed.' })).toContainText(
    `${name} stays as it is.`,
  );
  await expect(owner.getByTestId('correction-row').filter({ hasText: name })).toHaveCount(0);

  await deleteFact(owner, factId);
});
