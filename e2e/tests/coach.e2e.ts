import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-027 AC-6, AC-13 (J11, UC-04 1–7): the owner asks Coach about a price, sees which
 * fact the answer used, teaches the new price, confirms it, and a visitor on the widget
 * host page is quoted the new price straight away. Then the setup's test step (SCR-APP-010).
 */
const WIDGET_HOST = 'http://localhost:5175/';

test('a price taught in Coach reaches the widget after the owner confirms it', async ({
  page: owner,
  browser,
}) => {
  // A name unique to this run, so facts left by an earlier run can't answer for it.
  const token = Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
  const name = `Kaya roll ${token}`;
  await signIn(owner, 'owner@kaki-bakery.test');
  const factId = await owner.evaluate(async (n) => {
    const res = await fetch('/api/v1/kb/facts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'product',
        value: { name: n, price: '12' },
        gstTreatment: 'inclusive',
      }),
    });
    return ((await res.json()) as { fact: { id: string } }).fact.id;
  }, name);

  // SCR-APP-030, empty: suggestions.
  await owner.goto('/coach');
  await expect(owner.getByRole('heading', { name: 'Coach', level: 1 })).toBeVisible();
  await expect(owner.getByRole('heading', { name: 'Ask your assistant something' })).toBeVisible();
  await expect(owner.getByText('This is a practice chat.')).toBeVisible();
  await expectNoSeriousA11yViolations(owner);

  // Ask; the answer and its explainer.
  const composer = owner.getByLabel('Message');
  await composer.fill(`How much is the ${name}?`);
  await owner.getByRole('button', { name: 'Send' }).click();
  const thread = owner.getByRole('log', { name: 'Practice chat' });
  await expect(thread).toContainText('12.00');
  await expect(owner).toHaveURL(/\/coach\?session=/);
  const why = thread.getByRole('button', { name: /^Used \d+ facts? · Why\?$/ }).first();
  await why.click();
  await expect(why).toHaveAttribute('aria-expanded', 'true');
  await expect(thread.getByRole('link', { name: new RegExp(name) })).toBeVisible();
  await expectNoSeriousA11yViolations(owner);

  // Teach the new price: a proposal, nothing changed until the owner confirms.
  await composer.fill(`${name} went up to $14`);
  await composer.press('Enter');
  const card = thread.getByRole('region', { name: 'Proposed change' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('S$12.00');
  await expect(card).toContainText('S$14.00');
  const confirm = card.getByRole('button', { name: 'Confirm change' });
  await expect(confirm).toBeFocused();
  await expectNoSeriousA11yViolations(owner);
  await confirm.click();
  await expect(thread.getByText('Changed. Customers get the new price now.')).toBeVisible();
  await expect(thread.getByRole('heading', { name: 'Before' })).toBeVisible();
  await expect(thread.getByRole('heading', { name: 'Now' })).toBeVisible();
  await expectNoSeriousA11yViolations(owner);

  // A visitor is quoted the new price.
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await openShadowRoots(visitor);
  await visitor.goto(WIDGET_HOST);
  await visitor.getByRole('button', { name: /^Chat with / }).click();
  const panel = visitor.getByRole('dialog');
  await panel.getByLabel('Message').fill(`how much is the ${name.toLowerCase()}?`);
  await panel.getByRole('button', { name: 'Send' }).click();
  const reply = panel.locator('[data-author="agent"]:not([data-pending])');
  await expect(reply).toContainText('S$14.00');
  await context.close();

  // SCR-APP-010: the setup's test step, suggestions always shown.
  await owner.goto('/setup/test');
  await expect(owner.getByRole('heading', { name: 'Test your assistant' })).toBeVisible();
  await expect(owner.getByRole('list', { name: 'Suggested questions' })).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expectNoSeriousA11yViolations(owner);

  // The fact goes, so later specs start from the dev seed.
  await owner.evaluate(async (id) => {
    const { fact } = (await (await fetch(`/api/v1/kb/facts/${id}`)).json()) as {
      fact: { version: number };
    };
    await fetch(`/api/v1/kb/facts/${id}?version=${fact.version}`, { method: 'DELETE' });
  }, factId);
});
