import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots } from './support.ts';

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
  await owner.goto('/sign-in');
  await owner.getByRole('button', { name: 'Sign in as the Kaki Bakery owner' }).click();
  await expect(owner).toHaveURL(/\/inbox$/);

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
});
