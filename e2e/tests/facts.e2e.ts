import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-022 AC-16 (UC-13 1–3, UC-20 main flow, J2): the owner adds a product fact and
 * an FAQ in the dashboard, and a visitor's question on the widget host page is
 * answered from them, with the AI disclosure. The dev seed adds a bakery fact still in
 * review at S$70 and a second-tenant fact at S$99; neither may reach this visitor.
 */
const WIDGET_HOST = 'http://localhost:5175/';

test('a fact added in the dashboard is used in the next widget answer', async ({
  page: owner,
  browser,
}) => {
  await signIn(owner, 'owner@kaki-bakery.test');

  // SCR-APP-028: the product and price.
  await owner.goto('/knowledge/facts/new');
  await expect(owner.getByRole('heading', { name: 'Add a fact' })).toBeVisible();
  await owner.getByLabel('Name (required)').fill('Eggless chocolate cake');
  await owner.getByLabel('Size or unit').fill('1 kg');
  await owner.getByLabel('Price in S$ (required)').fill('55');
  await owner.getByLabel('Price includes GST').check();
  await expectNoSeriousA11yViolations(owner);
  await owner.getByRole('button', { name: 'Save fact' }).click();
  await expect(owner).toHaveURL(/\/knowledge$/);
  await expect(owner.getByRole('status').filter({ hasText: 'Fact saved' })).toBeVisible();

  // The FAQ.
  await owner.getByRole('link', { name: 'Add a fact' }).click();
  await owner.getByLabel('Question and answer (FAQ)').check();
  await owner.getByLabel('Question (required)').fill('Do you have eggless cakes?');
  await owner.getByLabel('Answer (required)').fill('Yes, on request, 3 days ahead.');
  await owner.getByRole('button', { name: 'Save fact' }).click();
  await expect(owner).toHaveURL(/\/knowledge$/);

  // SCR-APP-027 lists both.
  const rows = owner.getByTestId('fact-row');
  await expect(
    rows.filter({ hasText: 'Eggless chocolate cake, 1 kg' }).filter({ hasText: 'S$55.00' }).first(),
  ).toBeVisible();
  await expect(rows.filter({ hasText: 'Do you have eggless cakes?' }).first()).toBeVisible();
  await expectNoSeriousA11yViolations(owner);

  // A visitor asks in the widget, in a separate browser context.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await openShadowRoots(visitor);
  await visitor.goto(WIDGET_HOST);
  await visitor.getByRole('button', { name: /^Chat with / }).click();
  const panel = visitor.getByRole('dialog');
  await panel.getByLabel('Message').fill('got eggless cake or not? how much ah');
  await panel.getByRole('button', { name: 'Send' }).click();

  const reply = panel.locator('[data-author="agent"]:not([data-pending])');
  await expect(reply).toContainText('S$55.00');
  await expect(panel.locator('.disc')).toHaveText(
    /You're chatting with an AI assistant for Kaki Bakery\./,
  );
  const shown = await panel.innerText();
  expect(shown).not.toContain('S$70');
  expect(shown).not.toContain('S$99');
  await expectNoSeriousA11yViolations(visitor, 'kaki-agent');
  await visitorContext.close();

  // The owner's facts go, so later specs start from the dev seed: the fixture site's
  // FAQ answers the same question differently, which is a conflict since FEAT-014.
  await owner.evaluate(async () => {
    const { facts } = (await (await fetch('/api/v1/kb/facts?q=eggless&limit=200')).json()) as {
      facts: { id: string; version: number; source: string }[];
    };
    for (const f of facts.filter((f) => f.source === 'manual'))
      await fetch(`/api/v1/kb/facts/${f.id}?version=${f.version}`, { method: 'DELETE' });
  });
});

/**
 * FEAT-011 AC-9 (UC-13 1–3, UC-20): the owner adds a refund policy, finds it by type,
 * a visitor's question is answered with its details; the owner deletes it from its
 * row menu, and the next identical question no longer gets them.
 */
test('a policy is answered, then deleted from the list and no longer used', async ({
  page: owner,
  browser,
}) => {
  // A word unique to this run, so facts left by an earlier run can't answer for it.
  const token = Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
  const details = `Cancel at least 2 days before collection for a full refund, ref ${token}.`;
  await signIn(owner, 'owner@kaki-bakery.test');

  // SCR-APP-028: the policy.
  await owner.goto('/knowledge/facts/new');
  await owner.getByLabel('Policy', { exact: true }).check();
  await owner.getByLabel('Kind (required)').selectOption('refund');
  await owner.getByLabel('Title (required)').fill('Cake order refund policy');
  await owner.getByLabel('Details (required)').fill(details);
  await expectNoSeriousA11yViolations(owner);
  await owner.getByRole('button', { name: 'Save fact' }).click();
  await expect(owner).toHaveURL(/\/knowledge$/);
  await expect(owner.getByRole('status').filter({ hasText: 'Fact saved' })).toBeVisible();

  // SCR-APP-027: filter by type.
  await owner.getByLabel('Type').selectOption('policy');
  const row = owner.getByTestId('fact-row').filter({ hasText: token });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Policy');
  await expect(owner.getByTestId('fact-row').filter({ hasText: 'Chocolate' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(owner);

  // A visitor asks.
  const ask = async () => {
    const context = await browser.newContext();
    const visitor = await context.newPage();
    await openShadowRoots(visitor);
    await visitor.goto(WIDGET_HOST);
    await visitor.getByRole('button', { name: /^Chat with / }).click();
    const panel = visitor.getByRole('dialog');
    await panel.getByLabel('Message').fill('what is your cake order refund policy?');
    await panel.getByRole('button', { name: 'Send' }).click();
    const reply = panel.locator('[data-author="agent"]:not([data-pending])');
    await expect(reply).toBeVisible();
    const text = await reply.innerText();
    await context.close();
    return text;
  };
  expect(await ask()).toContain(details);

  // Delete from the row menu, through the confirm dialog.
  await row.getByRole('button', { name: /^Actions for / }).click();
  await owner.getByRole('menuitem', { name: 'Delete…' }).click();
  const dialog = owner.getByRole('alertdialog', { name: 'Delete this fact?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectNoSeriousA11yViolations(owner);
  await dialog.getByRole('button', { name: 'Delete fact' }).click();
  await expect(dialog).toBeHidden();
  await expect(owner.getByRole('status').filter({ hasText: 'Fact deleted.' })).toBeVisible();
  await expect(owner.getByTestId('fact-row').filter({ hasText: token })).toHaveCount(0);

  expect(await ask()).not.toContain(token);
});
