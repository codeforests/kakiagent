import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  expectNoSeriousA11yViolations,
  magicLinkFor,
  requestSignInLink,
  signIn,
  totp,
} from './support.ts';

/**
 * FEAT-006 §5.6 (AC-2–AC-5, AC-9–AC-12): a fresh Owner enrols from My account after an
 * emailed re-auth link, signs in through the code challenge, requires two-step for the
 * workspace (re-auth by code), can't turn it off while required, then locks the code
 * challenge with five wrong codes and gets in with a recovery code. A new user per run,
 * so the seeded owners never get a factor.
 */

function ownerUrl(): string {
  if (process.env.DATABASE_OWNER_URL) return process.env.DATABASE_OWNER_URL;
  const env = readFileSync(new URL('../../packages/db/.env', import.meta.url), 'utf8');
  const url = /^DATABASE_OWNER_URL=(.+)$/m.exec(env)?.[1];
  if (!url) throw new Error('DATABASE_OWNER_URL is not set (run scripts/gen-local-env.mjs)');
  return url.trim();
}

let owner: pg.Client;
test.beforeAll(async () => {
  owner = new pg.Client({ connectionString: ownerUrl() });
  await owner.connect();
});
test.afterAll(async () => {
  await owner?.end();
});

/** Stands in for ten minutes passing: the user's sessions need a fresh re-auth. */
async function ageReauth(email: string) {
  await owner.query(
    `update sessions set reauth_at = now() - interval '11 minutes'
      where user_id = (select id from users where email = $1)`,
    [email],
  );
}

/** A code the server hasn't seen: each accepted code must be a later 30 s step (replay). */
let lastStep = 0;
async function freshCode(secret: string) {
  for (;;) {
    const now = Math.floor(Date.now() / 30_000);
    const step = Math.max(now, lastStep + 1);
    if (step <= now + 1) {
      lastStep = step;
      return totp(secret, step);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

test('an Owner enrols, signs in with a code, requires two-step and recovers from a lock', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const run = Date.now();
  const email = `two-step-${run}@example.test`;
  const workspace = `Two-step Bakery ${run}`;

  // A new Owner and workspace.
  await page.goto(await requestSignInLink(page, email));
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByLabel('Business name (required)').fill(workspace);
  await page.getByRole('checkbox', { name: /I agree to the Terms of Service/ }).check();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/setup$/);

  // My account, off (SCR-APP-055 p).
  await ageReauth(email);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'My account' }).click();
  await expect(page).toHaveURL(/\/account$/);
  const card = page.locator('#two-step');
  await expect(card.getByText(/so a stolen email can't open your account/)).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // Set up needs a fresh re-auth: without two-step, by an emailed link (AC-5, AC-10).
  await card.getByRole('link', { name: 'Set up' }).click();
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`We'll email a confirmation link to ${email}.`)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  const since = new Date(Date.now() - 1000);
  await dialog.getByRole('button', { name: 'Email me a link' }).click();
  await expect(dialog.getByRole('status')).toContainText('Check your email.');
  const tab = await context.newPage();
  await tab.goto(await magicLinkFor(email, since));
  await expect(tab.getByRole('heading', { name: "You're confirmed" })).toBeVisible();
  await expectNoSeriousA11yViolations(tab);
  await tab.close();

  // The dialog closes by itself and setup carries on (SCR-APP-005 Enrol).
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  await expect(page.getByText('Step 1 of 3')).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize({ width: 1280, height: 800 });
  const secret = (await page.getByTestId('setup-key').innerText()).replace(/\s/g, '');

  await page.getByRole('button', { name: 'Next' }).click();
  const setupCode = page.getByLabel('6-digit code');
  await expect(setupCode).toHaveAttribute('inputmode', 'numeric');
  await expect(setupCode).toHaveAttribute('autocomplete', 'one-time-code');
  const good = await freshCode(secret);
  await setupCode.fill(String((Number(good) + 1) % 1_000_000).padStart(6, '0'));
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await expect(page.getByText(/Make sure you scanned the code on this screen/)).toBeVisible();
  await setupCode.fill(good);
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();

  // Recovery codes: shown once, copy and download, Continue needs the checkbox (AC-9).
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  const items = page.getByRole('list', { name: /Recovery codes/ }).getByRole('listitem');
  await expect(items).toHaveCount(10);
  const codes = await items.allInnerTexts();
  await expectNoSeriousA11yViolations(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('kakiagent-recovery-codes.txt');
  const cont = page.getByRole('button', { name: 'Continue' });
  await expect(cont).toBeDisabled();
  await page.getByLabel("I've saved these codes").check();
  await cont.click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole('status').filter({ hasText: 'Two-step verification is on.' }),
  ).toBeVisible();
  await expect(card.getByText(/^On since/)).toBeVisible();
  await expect(card.getByText('10 recovery codes left')).toBeVisible();

  // Sign in again: the code challenge before the inbox (AC-2).
  await signOut(page);
  await page.goto(await requestSignInLink(page, email));
  await expect(page).toHaveURL(/\/two-step$/);
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await expect(page.getByText(`Signing in as ${email}.`)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByLabel('6-digit code').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/inbox$/);

  // Require two-step for the workspace; the re-auth is by code this time (AC-4, AC-11).
  await ageReauth(email);
  await page.goto('/settings/team');
  await expect(page.getByText('1 of 1 members use it.')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  const toggle = page.getByRole('switch', {
    name: `Require two-step verification for everyone in ${workspace}`,
  });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(page.getByRole('alertdialog')).toContainText('Everyone already uses it.');
  await page.getByRole('button', { name: 'Require it' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('6-digit code')).toBeFocused();
  await expectNoSeriousA11yViolations(page);
  await dialog.getByLabel('6-digit code').fill(await freshCode(secret));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Two-step verification is now required.' }),
  ).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // Turning two-step off is refused while the workspace requires it (AC-6).
  await page.goto('/account');
  await expect(page.getByRole('button', { name: 'Turn off' })).toBeDisabled();
  await expect(page.getByText(`${workspace} requires two-step verification.`)).toBeVisible();

  // Five wrong codes lock the challenge; a recovery code still works (AC-3).
  await signOut(page);
  await page.goto(await requestSignInLink(page, email));
  await expect(page).toHaveURL(/\/two-step$/);
  const wrong = String((Number(totp(secret)) + 500_000) % 1_000_000).padStart(6, '0');
  for (let i = 1; i <= 5; i++) {
    await page.getByLabel('6-digit code').fill(wrong);
    await page.getByRole('button', { name: 'Continue' }).click();
    if (i === 3) await expect(page.getByText(/2 tries left\./)).toBeVisible();
    if (i < 5) await expect(page.getByRole('button', { name: 'Continue' })).toHaveText('Continue');
  }
  await expect(page.getByRole('heading', { name: 'Too many wrong codes' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await expect(page.getByRole('heading', { name: 'Use a recovery code' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByLabel('Recovery code').fill(codes[0]!);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});

/** Joins Kaki Bakery from an emailed invitation, signing in by the page's own link. */
async function joinFromInvite(page: Page, email: string, link: string) {
  await page.goto(link);
  await expect(page.getByText(`Sign in as ${email} to join.`)).toBeVisible();
  const since = new Date(Date.now() - 1000);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByText(/Check your inbox\./)).toBeVisible();
  await page.goto(await magicLinkFor(email, since));
}

const setKakiRequired = (required: boolean) =>
  owner.query(`update tenants set mfa_required = $1 where slug = 'kaki-bakery'`, [required]);

test.describe('two-step for invited members (FEAT-006 leftovers, FEAT-007 §5.5)', () => {
  // Kaki Bakery is shared dev state: never leave it requiring two-step.
  test.afterEach(async () => {
    await setKakiRequired(false);
  });

  test('an Agent sees the requirement read-only; a member joining while it is on enrols first', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const run = Date.now();
    const agent = `agent+${run}@kaki-bakery.test`;
    const later = `later+${run}@kaki-bakery.test`;

    // The Owner invites both addresses (FEAT-007 SCR-APP-045).
    await signIn(page, 'owner@kaki-bakery.test');
    await page.goto('/settings/team');
    const links: string[] = [];
    for (const email of [agent, later]) {
      const since = new Date(Date.now() - 1000);
      await page.getByRole('button', { name: 'Invite someone' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Invite someone' });
      await dialog.getByLabel('Email address').fill(email);
      await dialog.getByRole('button', { name: 'Send invitation' }).click();
      await expect(dialog).toBeHidden();
      links.push(await magicLinkFor(email, since, 'invite'));
    }

    // An Agent: the switch is there but read-only (FEAT-006 AC-9 leftover).
    const agentPage = await browser.newPage();
    await joinFromInvite(agentPage, agent, links[0]!);
    await expect(agentPage).toHaveURL(/\/inbox$/);
    await agentPage.goto('/settings/team');
    const toggle = agentPage.getByRole('switch', { name: /Require two-step verification/ });
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await expect(agentPage.getByText(/^Only the Owner can change this\./)).toBeVisible();
    await expectNoSeriousA11yViolations(agentPage);
    await agentPage.close();

    // With the requirement on, a new member is sent to set up two-step (FEAT-006 AC-4 leftover).
    await setKakiRequired(true);
    const laterPage = await browser.newPage();
    await joinFromInvite(laterPage, later, links[1]!);
    await expect(laterPage).toHaveURL(/\/two-step\/setup/);
    await laterPage.close();
  });
});
