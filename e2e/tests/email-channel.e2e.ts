import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, signIn } from './support.ts';

/**
 * FEAT-036 AC-2, AC-4, AC-6, AC-11 (CHN-04, CHN-10, NFR-18; SCR-APP-038, SCR-APP-036,
 * SCR-APP-014): the Owner sets up email and goes live; a forwarded customer email gets an AI
 * reply in Mailpit that threads to it; the customer's reply to that lands in the same inbox
 * conversation; an out-of-office reply gets nothing and shows as ignored; a `.test` domain
 * verifies on its first check and the next reply comes from it. Inbound mail goes through
 * `pnpm email:receive` (the local SES stand-in). Each run uses its own sender and
 * Message-IDs, so the three browsers don't see each other's mail; `afterEach` removes the
 * domain and takes email offline again, so later specs find the dev tenant as before.
 */
const OWNER = 'owner@kaki-bakery.test';
const MAILPIT = 'http://localhost:8025/api/v1';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOMAIN_ADDRESS = 'hello@kakibakery.test';

// Letters only: the fake triage reads the first number in a message as a quantity.
const tag = () =>
  Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
    '',
  );

interface Mail {
  ID: string;
  MessageID: string;
  Subject: string;
  From: { Address: string };
  Created: string;
}

async function mailTo(address: string): Promise<Mail[]> {
  const query = encodeURIComponent(`to:"${address}"`);
  const list = (await (await fetch(`${MAILPIT}/search?query=${query}`)).json()) as {
    messages: Mail[];
  };
  return list.messages;
}

/** Waits until `address` has `count` emails; returns the newest. */
async function nthMailTo(address: string, count: number): Promise<Mail> {
  for (let i = 0; i < 90; i++) {
    const list = await mailTo(address);
    if (list.length >= count) return list[0]!;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`fewer than ${count} emails reached ${address}`);
}

async function headersOf(mail: Mail): Promise<Record<string, string[]>> {
  return (await (await fetch(`${MAILPIT}/message/${mail.ID}/headers`)).json()) as Record<
    string,
    string[]
  >;
}

/** Writes an .eml and feeds it through the local inbound bucket and queue. */
function receive(eml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kaki-email-'));
  const file = join(dir, 'mail.eml');
  writeFileSync(file, eml.replace(/\n/g, '\r\n'));
  execFileSync('pnpm', ['email:receive', file], { cwd: ROOT, stdio: 'pipe' });
}

function eml(opts: {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  extra?: string;
}): string {
  return [
    `Return-Path: <${opts.from}>`,
    `From: Customer <${opts.from}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${opts.messageId}>`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references ? [`References: ${opts.references}`] : []),
    ...(opts.extra ? [opts.extra] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    opts.body,
    '',
  ].join('\n');
}

async function openEmailPage(page: Page) {
  await page.goto('/settings/channels/email');
  await expect(page.getByRole('heading', { level: 1, name: 'Email' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /Answer customer emails|Forward your email/ }),
  ).toBeVisible();
}

/** Puts the dev tenant's email channel back: no custom domain, offline. */
async function restore(page: Page) {
  const res = await page.request.get('/api/v1/channels/email');
  if (!res.ok()) return;
  let email = (await res.json()) as {
    connection: { id: string; state: string; version: number } | null;
    domain: unknown;
    settingsVersion: number;
  };
  if (email.domain) {
    const removed = await page.request.delete('/api/v1/channels/email/domain', {
      data: { settingsVersion: email.settingsVersion },
    });
    if (removed.ok()) email = await removed.json();
  }
  if (email.connection?.state === 'live')
    await page.request.post(`/api/v1/channels/${email.connection.id}/offline`, {
      data: { version: email.connection.version },
    });
}

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }) => {
  await restore(page);
});

test('the Owner sets up email, gets threaded AI replies, and sends from their own domain', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const run = tag();
  const customer = `customer.${run}@example.test`;
  const subject = `Cake question ${run}`;

  await signIn(page, OWNER);
  await restore(page);
  await openEmailPage(page);

  // Set up (only the first browser's run finds email not set up yet).
  const setUp = page.getByRole('button', { name: 'Set up email' });
  if (await setUp.isVisible()) {
    await setUp.click();
    await expect(page.getByRole('status').filter({ hasText: 'Email is set up' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '1. Forward your email to us' })).toBeFocused();
  }
  const forwarding = (await page.locator('.copy-value__text').first().innerText()).trim();
  expect(forwarding).toMatch(/^kaki-bakery@in\./);
  await expect(page.getByTestId('reply-from')).toHaveText(forwarding);

  await page.setViewportSize({ width: 375, height: 5000 });
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectNoSeriousA11yViolations(page);

  // Go live on Channels: the Email card links back to its settings.
  await page.getByRole('link', { name: 'Channels', exact: true }).last().click();
  const card = page.getByRole('region', { name: 'Email', exact: true });
  await expect(card.getByRole('link', { name: 'Email settings' })).toBeVisible();
  await card.getByRole('button', { name: 'Go live' }).click();
  await page
    .getByRole('alertdialog', { name: 'Go live on Email?' })
    .getByRole('button', { name: 'Go live' })
    .click();
  await expect(card.getByText('Live', { exact: true })).toBeVisible();

  // A forwarded customer email gets an AI reply that threads to it.
  const firstId = `first.${run}@mail.example.test`;
  receive(
    eml({
      from: customer,
      to: forwarding,
      subject,
      messageId: firstId,
      body: 'Hello, what time do you open?\n\nThanks',
    }),
  );
  const reply = await nthMailTo(customer, 1);
  expect(reply.Subject).toBe(`Re: ${subject}`);
  expect(reply.From.Address).toBe(forwarding);
  const headers = await headersOf(reply);
  expect(headers['In-Reply-To']?.[0]).toBe(`<${firstId}>`);
  expect(headers.References?.[0]).toContain(`<${firstId}>`);

  // The customer's reply to it lands in the same conversation.
  receive(
    eml({
      from: customer,
      to: forwarding,
      subject: `Re: ${subject}`,
      messageId: `second.${run}@mail.example.test`,
      inReplyTo: `<${reply.MessageID}>`,
      references: `<${firstId}> <${reply.MessageID}>`,
      body: 'Thanks. Do you have eggless cakes?\n\nOn Monday the bakery wrote:\n> earlier text',
    }),
  );
  await nthMailTo(customer, 2);

  await page.goto('/inbox?channel=email');
  const row = page.getByTestId('conversation-row').filter({ hasText: subject });
  await expect(row).toHaveCount(1);
  await row.getByRole('link').click();
  await expect(page.getByTestId('thread-subject')).toHaveText(subject);
  await expect(page.locator('[data-testid="thread-message"][data-author="visitor"]')).toHaveCount(
    2,
  );
  await expectNoSeriousA11yViolations(page);

  // An out-of-office reply gets no reply and counts as ignored.
  receive(
    eml({
      from: customer,
      to: forwarding,
      subject: `Re: ${subject}`,
      messageId: `ooo.${run}@mail.example.test`,
      inReplyTo: `<${reply.MessageID}>`,
      references: `<${firstId}> <${reply.MessageID}>`,
      extra: 'Auto-Submitted: auto-replied',
      body: 'I am on leave until next week.',
    }),
  );
  await openEmailPage(page);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('ignored-mail')).toContainText(/out-of-office repl/, {
      timeout: 1000,
    });
  }).toPass({ timeout: 30_000 });
  expect(await mailTo(customer)).toHaveLength(2);

  // A `.test` domain verifies on its first check (the fixture provider), and the next reply
  // comes from it.
  await page.getByLabel('Your business email').fill(DOMAIN_ADDRESS);
  await page.getByRole('button', { name: 'Use this address' }).click();
  await expect(page.getByText('Checking DNS')).toBeVisible();
  await expect(page.getByTestId('dns-record').first()).toBeVisible();
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `${DOMAIN_ADDRESS} is verified` }),
  ).toBeVisible();
  await expect(page.getByTestId('reply-from')).toHaveText(DOMAIN_ADDRESS);

  receive(
    eml({
      from: customer,
      to: forwarding,
      subject: `Re: ${subject}`,
      messageId: `third.${run}@mail.example.test`,
      inReplyTo: `<${reply.MessageID}>`,
      references: `<${firstId}> <${reply.MessageID}>`,
      body: 'And what time do you close?',
    }),
  );
  const fromDomain = await nthMailTo(customer, 3);
  expect(fromDomain.From.Address).toBe(DOMAIN_ADDRESS);
});
