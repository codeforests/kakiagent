import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, magicLinkFor, signIn } from './support.ts';

/**
 * FEAT-007 §5.5 (AC-1–AC-9): the Owner invites a new address as an Agent; opened signed in
 * as the Owner the link shows wrong email; signed out, "Email me a sign-in link" joins.
 * The second tenant's Owner invites the same person, who joins from the link signed in and
 * switches between the two. The Owner grants approval rights, promotes the member to
 * Admin, which ends their session, and deactivates them. A revoked link is invalid and a
 * used one says so. A new address per run, so the seeded members never change.
 */

const OWNER = 'owner@kaki-bakery.test';
const SECOND_OWNER = 'owner@second-tenant.test';
const SECOND = 'Second Tenant Pte Ltd';

/** Axe at desktop, at phone width (tall, so the tab bar covers nothing), and in dark. */
async function axeEverywhere(page: Page) {
  await expectNoSeriousA11yViolations(page);
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 375, height: 5000 });
  await expectNoSeriousA11yViolations(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Invites `email` from Team and returns the emailed link. */
async function invite(page: Page, email: string, role: 'Admin' | 'Agent') {
  const since = new Date(Date.now() - 1000);
  await page.getByRole('button', { name: 'Invite someone' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Invite someone' });
  await dialog.getByLabel('Email address').fill(email);
  await dialog.getByRole('radio', { name: new RegExp(`^${role}`) }).check();
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `Invitation sent to ${email}.` }),
  ).toBeVisible();
  return magicLinkFor(email, since, 'invite');
}

const memberRow = (page: Page, email: string) =>
  page.getByTestId('team-member').filter({ hasText: email });

async function memberAction(page: Page, email: string, item: string) {
  await page.getByRole('button', { name: `Actions for ${email}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('an Owner invites, the invitee joins two businesses, and loses access on a change', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const run = Date.now();
  const staff = `staff+${run}@kaki-bakery.test`;

  // SCR-APP-045 as the Owner (AC-9).
  await signIn(page, OWNER);
  await page.goto('/settings/team');
  await expect(memberRow(page, OWNER)).toContainText('You');
  await axeEverywhere(page);

  // Invite as an Agent: pending, one email (AC-1).
  const link = await invite(page, staff, 'Agent');
  const invitation = page.getByTestId('team-invitation').filter({ hasText: staff });
  await expect(invitation).toContainText(`Agent · Invited by ${OWNER}`);
  await axeEverywhere(page);

  // Opened as the Owner: wrong email, the invite stays usable (AC-2).
  await page.goto(link);
  await expect(page.getByText(`This invitation is for ${staff}`)).toBeVisible();
  expect(page.url()).not.toContain('token=');
  await axeEverywhere(page);
  await page.getByRole('button', { name: 'Sign out and continue' }).click();

  // Signed out: the emailed sign-in link joins and opens the business (AC-3).
  await expect(page.getByText(`Sign in as ${staff} to join.`)).toBeVisible();
  await axeEverywhere(page);
  const since = new Date(Date.now() - 1000);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByText(/Check your inbox\. The link signs you in and joins/)).toBeVisible();
  await axeEverywhere(page);
  await page.goto(await magicLinkFor(staff, since));
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByTestId('tenant-name')).toHaveText('Kaki Bakery');

  // Used now (AC-2).
  await page.goto(link);
  await expect(
    page.getByRole('heading', { name: 'This invitation has already been used' }),
  ).toBeVisible();
  await axeEverywhere(page);

  // An Agent sees Team read-only (AC-8, AC-9).
  await page.goto('/settings/team');
  await expect(page.getByText('Only the Owner and Admins can manage the team.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Members/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Invite someone' })).toHaveCount(0);

  // The second tenant's Owner invites the same person, who joins signed in (AC-2, AC-7).
  const second = await (await browser.newContext()).newPage();
  await signIn(second, SECOND_OWNER);
  await second.goto('/settings/team');
  const secondLink = await invite(second, staff, 'Agent');
  await second.context().close();
  await page.goto(secondLink);
  await expect(page.getByRole('heading', { name: `Join ${SECOND}` })).toBeVisible();
  await axeEverywhere(page);
  await page.getByRole('button', { name: `Join ${SECOND}` }).click();
  await expect(page.getByRole('status').filter({ hasText: `Welcome to ${SECOND}.` })).toBeVisible();
  await expect(page.getByTestId('tenant-name')).toHaveText(SECOND);

  // The switcher lists both; switching moves the top bar and the data (AC-7).
  const switcher = page.getByRole('button', { name: `Switch business, current: ${SECOND}` });
  await switcher.click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(2);
  await expect(page.getByRole('menuitemradio', { name: new RegExp(SECOND) })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('menuitemradio', { name: /Kaki Bakery/ }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Switched to Kaki Bakery.' }),
  ).toBeVisible();
  await expect(page.getByTestId('tenant-name')).toHaveText('Kaki Bakery');
  await page.goto('/inbox');
  await expect(page.getByTestId('tenant-name')).toHaveText('Kaki Bakery');

  // The Owner grants approval rights, then promotes to Admin (AC-4, AC-6).
  const owner = await (await browser.newContext()).newPage();
  await signIn(owner, OWNER);
  await owner.goto('/settings/team');
  await memberAction(owner, staff, 'Give approval rights');
  await expect(memberRow(owner, staff)).toContainText('Can approve');
  await memberAction(owner, staff, 'Change role');
  const roleDialog = owner.getByRole('dialog', { name: `Change ${staff}'s role` });
  await roleDialog.getByRole('radio', { name: /^Admin/ }).check();
  await expect(roleDialog.getByText(/Approval rights come with the Admin role\./)).toBeVisible();
  await expectNoSeriousA11yViolations(owner);
  await roleDialog.getByRole('button', { name: 'Change role' }).click();
  await expect(
    owner.getByRole('status').filter({ hasText: `${staff} is now an Admin.` }),
  ).toBeVisible();
  await expect(owner.getByRole('button', { name: `Actions for ${staff}` })).toBeFocused();

  // The role change ended the member's session on Kaki Bakery (AC-5).
  await page.reload();
  await expect(page).toHaveURL(/\/(sign-in|session-expired)$/);

  // Deactivate: listed last, Reactivate only (AC-4).
  await memberAction(owner, staff, 'Deactivate');
  await owner.getByRole('alertdialog').getByRole('button', { name: 'Deactivate' }).click();
  await expect(
    owner.getByRole('status').filter({ hasText: `${staff} is deactivated.` }),
  ).toBeVisible();
  await expect(memberRow(owner, staff)).toContainText('Deactivated');

  // A revoked invitation's link is invalid (AC-2).
  const gone = `revoked+${run}@kaki-bakery.test`;
  const goneLink = await invite(owner, gone, 'Admin');
  await owner.getByRole('button', { name: `Revoke the invitation to ${gone}` }).click();
  await owner.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(owner.getByRole('status').filter({ hasText: 'Invitation revoked.' })).toBeVisible();
  // Focus moves to the Invitations heading, or to "Invite someone" when that was the
  // last invitation and the section has gone with it.
  const invitations = owner.getByRole('heading', { name: 'Invitations' });
  await expect(
    (await invitations.count()) > 0
      ? invitations
      : owner.getByRole('button', { name: 'Invite someone' }).first(),
  ).toBeFocused();
  await page.goto(goneLink);
  await expect(page.getByRole('heading', { name: "This invitation isn't valid" })).toBeVisible();
  await axeEverywhere(page);
  await owner.context().close();
});
