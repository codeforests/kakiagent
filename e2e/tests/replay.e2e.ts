import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-028 AC-3, AC-10 (AGT-17, UC-04 4b; SCR-APP-031): a visitor asks a price on the
 * widget, the owner replaces the fact with a new price, then replays the conversation from
 * Coach. The "now" column quotes the new price and is marked "Uses different facts"; the
 * original column keeps what the visitor got. Against the seeded bakery and the fake model.
 */
const WIDGET_HOST = 'http://localhost:5175/';

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

test('a replay answers with the current facts next to what the visitor got', async ({
  page: owner,
  browser,
}) => {
  // A name unique to this run, so facts and conversations from earlier runs don't match.
  const token = Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
  const name = `Ondeh cake ${token}`;
  const question = `how much is the ${name.toLowerCase()}?`;
  await signIn(owner, 'owner@kaki-bakery.test');
  const oldFact = await createFact(owner, name, '12');

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

  // The owner replaces the fact: the old one goes, a new one has the new price.
  await deleteFact(owner, oldFact);
  const newFact = await createFact(owner, name, '14');

  // SCR-APP-030's entry point, then SCR-APP-031 picking.
  await owner.goto('/coach');
  await owner.getByRole('link', { name: 'Replay a conversation' }).click();
  await expect(owner).toHaveURL(/\/coach\/replay$/);
  await expect(
    owner.getByRole('heading', { name: 'Replay a conversation', level: 1 }),
  ).toBeVisible();
  const row = owner.getByTestId('replay-candidate').filter({ hasText: question }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('1 question');
  await expectNoSeriousA11yViolations(owner);

  await row.getByRole('button').first().click();
  const dialog = owner.getByRole('dialog', { name: 'Replay this conversation?' });
  await expect(dialog).toContainText('Nothing is sent to the customer');
  await expect(dialog.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expectNoSeriousA11yViolations(owner);
  await dialog.getByRole('button', { name: 'Replay' }).click();

  // Replaying, then the comparison.
  await expect(owner).toHaveURL(/\/coach\/replay\/[0-9a-f-]{36}$/);
  // The strip shows the summary; a polite live region announces the same line.
  const done = /^Replay complete\. 1 answer uses different facts\.$/;
  await expect(owner.getByRole('paragraph').filter({ hasText: done })).toBeVisible();
  await expect(owner.locator('[aria-live="polite"]').filter({ hasText: done })).toHaveCount(1);
  const turn = owner.getByRole('listitem', { name: 'Question 1 of 1' });
  await expect(turn).toContainText(question);
  await expect(turn.getByTestId('replay-original')).toContainText('S$12.00');
  await expect(turn.getByTestId('replay-now')).toContainText('S$14.00');
  await expect(turn.getByTestId('replay-now')).not.toContainText('S$12.00');
  await expect(turn.getByText('Uses different facts')).toBeVisible();
  await expect(turn.getByRole('heading', { name: 'What the customer got' })).toBeVisible();
  await expect(turn.getByRole('heading', { name: 'What your assistant says now' })).toBeVisible();
  await expect(turn.getByRole('button', { name: 'Teach a fix' })).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Continue replay' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(owner);

  // The replay is not a practice chat, and the conversation now links to it.
  await owner.goto('/coach/replay');
  await expect(
    owner.getByTestId('replay-candidate').filter({ hasText: question }).first(),
  ).toContainText('Replayed before');

  await deleteFact(owner, newFact);
});
