import { expect, test } from '@playwright/test';
import { openShadowRoots } from './support.ts';

/**
 * FEAT-003 AC-9 (UC-20 step 4, SCR-WGT-002): an NRIC typed in the widget is masked
 * before it is stored, so the visitor's own bubble shows the token, and the turn still
 * gets the agent's reply.
 */
test('an NRIC typed in the widget shows masked and still gets a reply', async ({ browser }) => {
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await openShadowRoots(visitor);
  await visitor.goto('http://localhost:5175/');
  await visitor.getByRole('button', { name: /^Chat with / }).click();
  const panel = visitor.getByRole('dialog');
  await panel
    .getByLabel('Message')
    .fill(`My IC is S1234567D, do you have pandan cake? ${Date.now()}`);
  await panel.getByRole('button', { name: 'Send' }).click();

  const mine = panel.locator('[data-author="visitor"]').last();
  await expect(mine).toContainText('My IC is [NRIC ••••567D], do you have pandan cake?');
  await expect(panel.locator('[data-author="agent"]:not([data-pending])')).toBeVisible();
  await expect(panel).not.toContainText('S1234567D');
  await context.close();
});
