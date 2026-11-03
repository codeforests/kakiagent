import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-045 (INB-03, KB-18, UC-23 3–4a; SCR-APP-015, SCR-APP-021, SCR-APP-022): a visitor asks
 * a price; the owner presses Suggest a reply on the takeover bar, which takes the chat over
 * and fills the composer with a checked draft; they edit it and send, the visitor gets it,
 * and the edit lands in Review · Corrections as a "Staff edit" that becomes an FAQ.
 * The seeded bakery, the fake model.
 */
const WIDGET_HOST = 'http://localhost:5175/';

test('suggest a reply, edit and send it, and turn the edit into an FAQ (AC-1, AC-3, AC-4, AC-8)', async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(120_000);
  // A product unique to this run, so facts left by an earlier run can't answer for it.
  const token = Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
  const name = `Kaya roll ${token}`;
  const question = `How much is the ${name}?`;
  await owner.setViewportSize({ width: 1280, height: 900 });
  await signIn(owner, 'owner@kaki-bakery.test');
  await owner.evaluate(async (n) => {
    await fetch('/api/v1/kb/facts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'product',
        value: { name: n, price: '12' },
        gstTreatment: 'inclusive',
      }),
    });
  }, name);

  // The visitor asks; the assistant answers.
  const context = await browser.newContext();
  const visitor = await context.newPage();
  try {
    await openShadowRoots(visitor);
    await visitor.goto(WIDGET_HOST);
    await visitor.getByRole('button', { name: /^Chat with / }).click();
    const panel = visitor.getByRole('dialog');
    const created = visitor.waitForResponse(
      (r) => r.url().endsWith('/widget/v1/conversations') && r.request().method() === 'POST',
    );
    await panel.getByLabel('Message').fill(question);
    await panel.getByRole('button', { name: 'Send' }).click();
    const id = ((await (await created).json()) as { conversationId: string }).conversationId;
    await expect(panel.locator('[data-author="agent"]:not([data-pending])')).toHaveCount(1);

    // SCR-APP-015: Suggest a reply from the takeover bar takes over, then drafts (AC-1, AC-5).
    await owner.goto(`/inbox/${id}`);
    const dock = owner.getByTestId('thread-dock');
    await expect(dock).toHaveAttribute('data-mode', 'ai');
    await dock.getByRole('button', { name: 'Suggest a reply' }).click();
    await expect(dock).toHaveAttribute('data-mode', 'mine');
    const box = owner.getByLabel('Reply to visitor');
    await expect(owner.getByTestId('suggestion-label')).toHaveText(
      'AI suggestion · checked against your facts · edit before sending',
    );
    await expect(box).toHaveValue(/12\.00/);
    await expect(box).toBeFocused();
    await expect(box).toHaveAttribute('aria-describedby', /suggestion-label/);
    await expect(
      owner.getByRole('list', { name: 'Facts the suggestion used' }).getByRole('link'),
    ).toContainText([name]);
    await expect(dock.getByRole('button', { name: 'Suggest again' })).toBeVisible();
    // Nothing reached the visitor yet: still only the assistant's first answer.
    await expect(panel.locator('[data-author="staff"]')).toHaveCount(0);
    await expectNoSeriousA11yViolations(owner);
    await owner.setViewportSize({ width: 375, height: 5000 });
    await expect(owner.getByTestId('suggestion-label')).toBeVisible();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
    await expectNoSeriousA11yViolations(owner);
    await owner.setViewportSize({ width: 1280, height: 900 });

    // Edit and send: the visitor gets the team's words (AC-3).
    const draft = await box.inputValue();
    const sent = `${draft} Shall I keep one for you?`;
    await box.fill(sent);
    await owner.getByRole('button', { name: 'Send' }).click();
    await expect(panel.locator('[data-author="staff"]').last()).toContainText(
      'Shall I keep one for you?',
    );
    await expect(box).toHaveValue('');
    await expect(owner.getByTestId('suggestion-label')).toHaveCount(0);

    // SCR-APP-021: the edit is an open Staff edit (AC-4).
    await owner.goto('/review/corrections?source=staff_edit');
    const row = owner.getByTestId('correction-row').filter({ hasText: token });
    await expect(row).toContainText(`Staff improved a suggested reply: “${question}”`);
    await expect(row).toContainText('Staff edit');
    await expectNoSeriousA11yViolations(owner);

    // SCR-APP-022: question, suggestion and sent reply; Add as FAQ prefilled.
    await row.getByRole('link').first().click();
    await expect(
      owner.getByRole('heading', { level: 1, name: 'Staff improved a suggested reply' }),
    ).toBeVisible();
    await expect(owner.getByTestId('reply-edit-suggested')).toContainText(draft);
    await expect(owner.getByTestId('reply-edit-sent')).toContainText(sent);
    await expect(owner.getByRole('link', { name: 'Open conversation' })).toHaveAttribute(
      'href',
      `/inbox/${id}`,
    );
    await expectNoSeriousA11yViolations(owner);
    await owner.getByRole('button', { name: 'Add as FAQ' }).click();
    const dialog = owner.getByRole('dialog', { name: 'Add an FAQ' });
    await expect(dialog.getByLabel('Question (required)')).toHaveValue(question);
    await expect(dialog.getByLabel('Answer (required)')).toHaveValue(sent);
    await dialog.getByRole('button', { name: 'Save FAQ' }).click();
    await expect(owner.getByText('FAQ added. Your assistant now uses it.')).toBeVisible();

    // It left the open queue, closed as "FAQ added".
    await owner.goto('/review/corrections?status=closed&source=staff_edit');
    await expect(
      owner.getByTestId('correction-row').filter({ hasText: token }).first(),
    ).toContainText('FAQ added');
  } finally {
    await context.close();
  }
});
