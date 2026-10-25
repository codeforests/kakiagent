import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-019 AC-3, AC-4–AC-7, AC-10 (KB-09, KB-18, UC-16 3b; SCR-APP-029, SCR-APP-021,
 * SCR-APP-022, SCR-APP-008): before go-live the second tenant (made F&B for this spec) sees
 * the template topics, answers one with an FAQ and marks another "Doesn't apply". Then a
 * bakery visitor asks something the KB can't answer, the grouping job runs, the gap shows
 * in Review › Corrections and on Coverage, and the owner answers it from Coverage, which
 * takes it out of both. Against the seeded tenants and the fake model.
 */
const WIDGET_HOST = 'http://localhost:5175/';

function ownerUrl(): string {
  if (process.env.DATABASE_OWNER_URL) return process.env.DATABASE_OWNER_URL;
  const env = readFileSync(new URL('../../packages/db/.env', import.meta.url), 'utf8');
  const url = /^DATABASE_OWNER_URL=(.+)$/m.exec(env)?.[1];
  if (!url) throw new Error('DATABASE_OWNER_URL is not set (run scripts/gen-local-env.mjs)');
  return url.trim();
}

async function withOwnerDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: ownerUrl() });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Deletes the tenant's FAQs whose question contains `text`, through the API. */
async function deleteFaqs(page: Page, text: string) {
  await page.evaluate(async (q) => {
    const { facts } = (await (
      await fetch(`/api/v1/kb/facts?type=faq&q=${encodeURIComponent(q)}`)
    ).json()) as { facts: { id: string; version: number }[] };
    for (const f of facts)
      await fetch(`/api/v1/kb/facts/${f.id}?version=${f.version}`, { method: 'DELETE' });
  }, text);
}

const HALAL = 'Are you halal-certified?';
const DINE_IN = 'Do you have seating for dine-in?';

test('template topics are answered or skipped, and a customer gap is answered from Coverage', async ({
  page: owner,
  browser,
}) => {
  // A word unique to this run, so gaps and FAQs from earlier runs don't match.
  const token = Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');

  // ---- Pre-live: the second tenant, given the F&B template for this spec.
  const second = await withOwnerDb(async (db) => {
    const { rows } = await db.query<{ id: string; industry: string | null; chats: number }>(
      `select t.id, p.industry,
              (select count(*)::int from conversations c where c.tenant_id = t.id) as chats
         from tenants t join business_profiles p on p.tenant_id = t.id
        where t.slug = 'second-tenant'`,
    );
    const row = rows[0]!;
    await db.query(
      `update business_profiles set industry = 'fnb', coverage_skipped_topics = '{}'
        where tenant_id = $1`,
      [row.id],
    );
    return row;
  });
  const context = await browser.newContext();
  const other = await context.newPage();
  try {
    await signIn(other, 'owner@second-tenant.test');
    await deleteFaqs(other, HALAL);
    await other.goto('/knowledge');
    await other.getByRole('link', { name: /^Coverage/ }).click();
    await expect(other).toHaveURL(/\/knowledge\/coverage$/);
    await expect(other.getByRole('heading', { name: 'Coverage', level: 2 })).toBeVisible();
    const topicsHeading = other.getByRole('heading', {
      name: 'Common questions for food and beverage',
    });
    await expect(topicsHeading).toBeVisible();
    await expect(other.getByTestId('topic-row')).toHaveCount(12);
    if (second.chats === 0) {
      // Pre-live leads with the topics (D4).
      await expect(
        other.getByRole('heading', { level: 2 }).filter({ hasText: /^(Common|Questions)/ }),
      ).toHaveText(['Common questions for food and beverage', 'Questions from customers']);
      await expect(
        other.getByText('Once customers start chatting, questions your assistant'),
      ).toBeVisible();
    }
    await expect(other.getByText(/^\d+ of \d+ common questions answered$/)).toBeVisible();
    await expectNoSeriousA11yViolations(other);

    // Add an answer to a missing topic (AC-3).
    const halal = other.getByTestId('topic-row').filter({ hasText: HALAL });
    await expect(halal.getByTestId('topic-state')).toHaveText('Not answered yet');
    await halal.getByRole('button', { name: `Add an answer: ${HALAL}` }).click();
    const dialog = other.getByRole('dialog', { name: 'Add an FAQ' });
    await expect(dialog.getByLabel('Question (required)')).toHaveValue(HALAL);
    await dialog.getByRole('button', { name: 'Save FAQ' }).click();
    await expect(dialog.getByText('Enter the answer')).toBeVisible();
    await expectNoSeriousA11yViolations(other);
    await dialog.getByLabel('Answer (required)').fill('Not certified, but we use no pork or lard.');
    await dialog.getByRole('button', { name: 'Save FAQ' }).click();
    await expect(other.getByRole('status').filter({ hasText: 'Saved.' })).toContainText(
      'Your assistant uses this answer now.',
    );
    await expect(halal.getByTestId('topic-state')).toHaveText('✓ Answered');
    await expect(halal.getByRole('link')).toBeVisible();

    // "Doesn't apply", then Undo (AC-3, D8).
    const dineIn = other.getByTestId('topic-row').filter({ hasText: DINE_IN });
    await dineIn.getByRole('button', { name: `Doesn't apply: ${DINE_IN}` }).click();
    await expect(dineIn.getByTestId('topic-state')).toHaveText("Doesn't apply");
    await expect(
      other.getByRole('status').filter({ hasText: 'Marked as not applying' }),
    ).toBeVisible();
    await expect(dineIn.getByRole('button', { name: `Undo: ${DINE_IN}` })).toBeFocused();
    await other.reload();
    await expect(dineIn.getByTestId('topic-state')).toHaveText("Doesn't apply");
    await dineIn.getByRole('button', { name: `Undo: ${DINE_IN}` }).click();
    await expect(dineIn.getByTestId('topic-state')).toHaveText('Not answered yet');

    // SCR-APP-008: the setup review's coverage card.
    await other.goto('/setup/review');
    const card = other.getByRole('region', { name: 'Coverage' });
    await expect(card).toContainText(/\d+ of \d+ common questions answered/);
    await card.getByRole('link', { name: 'Check coverage' }).click();
    await expect(other).toHaveURL(/\/knowledge\/coverage$/);
  } finally {
    await deleteFaqs(other, HALAL).catch(() => undefined);
    await context.close();
    await withOwnerDb((db) =>
      db.query(
        `update business_profiles set industry = $2, coverage_skipped_topics = '{}'
          where tenant_id = $1`,
        [second.id, second.industry],
      ),
    );
  }

  // ---- Live: a bakery visitor asks something the KB can't answer (AC-4).
  const asked = `do you have lorry parking for ${token}?`;
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await openShadowRoots(visitor);
  await visitor.goto(WIDGET_HOST);
  await visitor.getByRole('button', { name: /^Chat with / }).click();
  const panel = visitor.getByRole('dialog');
  await panel.getByLabel('Message').fill(asked);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('[data-author="agent"]:not([data-pending])').last()).toBeVisible();
  await visitorContext.close();

  // Which outcome the fake model gives this question isn't the point here (the turn tests
  // cover AC-4), so the spec marks the message as a gap if the turn didn't, with a random
  // vector so it groups on its own, then runs the 10-minute job directly (AC-5).
  await withOwnerDb(async (db) => {
    const vector = `[${Array.from({ length: 1024 }, () => (Math.random() - 0.5).toFixed(6)).join(',')}]`;
    const { rowCount } = await db.query(
      `update messages set gap_reason = coalesce(gap_reason, 'unsure'), gap_embedding = $2::vector
        where author = 'visitor' and body like $1 and gap_correction_id is null`,
      [`%${token}%`, vector],
    );
    expect(rowCount).toBe(1);
    await db.query('select * from kb_gap_cluster()');
  });

  await signIn(owner, 'owner@kaki-bakery.test');

  // SCR-APP-021 and SCR-APP-022: the gap is an open item in the queue (D1).
  await owner.goto('/review/corrections?source=coverage_gap');
  const item = owner.getByTestId('correction-row').filter({ hasText: token });
  await expect(item).toContainText(`Customers asked: “${asked}”`);
  await expect(item).toContainText('Coverage gap');
  await expect(item).toContainText('once');
  await expectNoSeriousA11yViolations(owner);
  await item.getByRole('link').click();
  await expect(owner.getByRole('heading', { name: 'Where it came from' })).toBeVisible();
  await expect(owner.getByTestId('gap-questions')).toContainText(asked);
  await expect(owner.getByText('Asked once in the last 30 days, 1 in all.')).toBeVisible();
  await expect(owner.getByRole('heading', { name: 'Facts involved' })).toHaveCount(0);
  await expect(owner.getByRole('button', { name: 'Add an FAQ' })).toBeVisible();
  await expectNoSeriousA11yViolations(owner);

  // SCR-APP-029, live: the gap leads, and the owner answers it from there (AC-6, AC-7).
  await owner.goto('/knowledge/coverage');
  await expect(
    owner.getByRole('heading', { level: 2 }).filter({ hasText: /^(Common|Questions)/ }),
  ).toHaveText(['Questions from customers', 'Common questions for food and beverage']);
  const gap = owner.getByTestId('gap-row').filter({ hasText: token });
  await expect(gap).toContainText(`“${asked}”`);
  await expect(gap).toContainText('Asked once in the last 30 days');
  await expectNoSeriousA11yViolations(owner);
  await gap.getByRole('button', { name: `Add an answer: ${asked}` }).click();
  const dialog = owner.getByRole('dialog', { name: 'Add an FAQ' });
  await expect(dialog.getByLabel('Question (required)')).toHaveValue(asked);
  await expect(dialog).toContainText('Customers asked this once.');
  await dialog.getByLabel('Question (required)').fill(`Is there lorry parking (${token})?`);
  await dialog.getByLabel('Answer (required)').fill('No, lorries can unload at the loading bay.');
  await dialog.getByRole('button', { name: 'Save FAQ' }).click();
  await expect(owner.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expect(owner.getByTestId('gap-row').filter({ hasText: token })).toHaveCount(0);

  // It left the queue too, closed as "FAQ added".
  await owner.goto('/review/corrections?source=coverage_gap');
  await expect(owner.getByTestId('correction-row').filter({ hasText: token })).toHaveCount(0);
  await owner.goto('/review/corrections?status=closed&source=coverage_gap');
  const closed = owner.getByTestId('correction-row').filter({ hasText: token }).first();
  await expect(closed).toContainText('FAQ added');
  await expect(closed).toContainText(`New FAQ: Is there lorry parking (${token})?`);

  await deleteFaqs(owner, token);
});
