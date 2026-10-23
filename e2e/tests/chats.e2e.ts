import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { expectNoSeriousA11yViolations, signIn } from './support.ts';

/**
 * FEAT-017 AC-9 (UC-11, KB-04): the owner uploads `whatsapp-android.txt` in the chat
 * history part of "Add sources", sees the redaction notice, follows the export to
 * SCR-APP-026, sees what was removed and that the export was deleted, then reviews the
 * suggested FAQs: approves one, edits and approves one, rejects one, approves the last,
 * and sees everything reviewed. No customer's name, phone, e-mail, NRIC or address is
 * shown anywhere on the page.
 *
 * `whatsapp-android.txt` is the ingest worker's fixture: the fake miner suggests the four
 * questions the business answered with a general reply.
 */
test.setTimeout(300_000);

const FIXTURES = new URL('../../apps/ingest-worker/fixtures/files/', import.meta.url);
const QUESTIONS = [
  'Is the pandan chiffon halal?',
  'What time do you open on Sunday?',
  'How long can the cake keep?',
  'Do you do customised birthday cakes?',
];
const PII = ['Tan Mei Ling', 'Mei Ling', '9123 4567', 'tanml@example.com', 'S1234567D', '560123'];

const card = (page: Page, name: string) =>
  page.getByTestId('review-card').filter({ has: page.getByRole('heading', { name }) });

/** Removes the tenant's sources, and any FAQ the chat suggested, from earlier runs. */
async function clearChats(page: Page) {
  await page.evaluate(async (questions) => {
    const { sources } = (await (await fetch('/api/v1/kb/sources')).json()) as {
      sources: { id: string; version: number }[];
    };
    for (const s of sources)
      await fetch(`/api/v1/kb/sources/${s.id}?version=${s.version}`, { method: 'DELETE' });
    for (const question of questions) {
      const q = new URLSearchParams({ type: 'faq', q: question, limit: '200' });
      const { facts } = (await (await fetch(`/api/v1/kb/facts?${q}`)).json()) as {
        facts: { id: string; version: number; value: { question: string } }[];
      };
      for (const f of facts.filter((f) => f.value.question === question))
        await fetch(`/api/v1/kb/facts/${f.id}?version=${f.version}`, { method: 'DELETE' });
    }
  }, QUESTIONS);
}

test('the owner imports a WhatsApp chat, sees what was removed and reviews the suggested FAQs', async ({
  page,
}) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.goto('/knowledge/sources');
  await clearChats(page);

  // SCR-APP-007: the chat history part, with the redaction notice and the business's name.
  await page.goto('/knowledge/sources/new#chats');
  await expect(page.getByRole('heading', { name: 'Chat history' })).toBeVisible();
  await expect(
    page.getByText(/Before anything is saved, we remove customers' names/),
  ).toBeVisible();
  await page.getByLabel('Your name in the chat (required)').fill('Kaki Bakery');
  await page.getByTestId('chat-input').setInputFiles({
    name: 'WhatsApp Chat with Mdm Tan Mei Ling.txt',
    mimeType: 'text/plain',
    buffer: readFileSync(new URL('whatsapp-android.txt', FIXTURES)),
  });
  const row = page.getByTestId('chat-row');
  await expect(row).not.toContainText('Tan Mei Ling');
  await expect(row).toContainText('4 suggested FAQs', { timeout: 120_000 });
  await expect(row).toContainText('WhatsApp chat, 13–18 Oct 2026');
  await row.getByRole('link', { name: /^View / }).click();

  // SCR-APP-026: the privacy card and the suggestions.
  await expect(page.getByRole('heading', { name: 'WhatsApp chat, 13–18 Oct 2026' })).toBeVisible();
  await expect(page.getByText('Checked for malware: none found')).toBeVisible();
  const privacy = page.getByRole('region', { name: 'Personal data removed' });
  await expect(privacy).toContainText('Names');
  await expect(privacy).toContainText('Phone numbers');
  await expect(privacy).toContainText('E-mail addresses');
  await expect(privacy).toContainText('NRIC and card numbers');
  await expect(privacy).toContainText('Addresses');
  await expect(privacy).toContainText('The export file was deleted on');
  await expect(
    page.getByRole('heading', { name: `Suggested FAQs (${QUESTIONS.length})` }),
  ).toBeVisible();
  for (const question of QUESTIONS) await expect(card(page, question)).toBeVisible();
  const body = await page.locator('main').innerText();
  for (const value of PII) expect(body).not.toContain(value);
  await expectNoSeriousA11yViolations(page);

  // Approve one.
  await card(page, QUESTIONS[0]!).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByTestId('review-done').filter({ hasText: QUESTIONS[0]! })).toContainText(
    'Approved',
  );

  // Edit and approve one.
  await card(page, QUESTIONS[1]!).getByRole('button', { name: 'Edit and approve' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit and approve' });
  await dialog
    .getByLabel('Answer (required)')
    .fill('Sundays 9am to 5pm, closed on public holidays.');
  await dialog.getByRole('button', { name: 'Approve fact' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('review-done').filter({ hasText: QUESTIONS[1]! })).toContainText(
    'Approved',
  );

  // Reject one, approve the last: everything is reviewed.
  await card(page, QUESTIONS[2]!).getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByTestId('review-done').filter({ hasText: QUESTIONS[2]! })).toContainText(
    'Rejected',
  );
  await card(page, QUESTIONS[3]!).getByRole('button', { name: 'Approve', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'All suggestions reviewed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'See your FAQs' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
