import { expect, test, type Page } from '@playwright/test';
import { Redis } from 'iovalkey';
import { expectNoSeriousA11yViolations, requestSignInLink } from './support.ts';

/**
 * FEAT-005 AC-16, added at acceptance: the SCR-APP-001, -002 and -003 states that
 * `auth.e2e.ts` does not reach (rate-limited, delayed, expired, error, terms-updated),
 * each rendered and checked with axe. Rate-limited and terms-updated run against the
 * real api; the others can't be produced on demand locally (an expired link, a failing
 * provider, a 5xx), so the api's answer is substituted with the shape design §3 gives it
 * and only the screen is under test (the api side is AC-2/AC-4's integration tests).
 */

async function clearSignInLimits() {
  const valkey = new Redis(process.env.VALKEY_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
  });
  await valkey.connect();
  const keys = await valkey.keys('rl:ml:*');
  if (keys.length) await valkey.del(...keys);
  valkey.disconnect();
}

async function submitEmail(page: Page, email: string) {
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
}

test('SCR-APP-001 rate-limited: the 6th link for one address in 15 minutes (AUTH-01)', async ({
  page,
}) => {
  const email = `limited-${Date.now()}@example.test`;
  await clearSignInLimits();
  try {
    for (let i = 0; i < 5; i++) {
      const res = await page.request.post('/api/v1/auth/magic-link', { data: { email } });
      expect(res.status()).toBe(202);
    }
    await page.goto('/sign-in');
    await submitEmail(page, email);
    const alert = page.getByRole('alert').filter({ hasText: 'Too many sign-in links for now' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('The links we already sent still work for 15 minutes.');
    await expect(page.getByLabel('Work email')).toHaveValue(email);
    await expectNoSeriousA11yViolations(page);
  } finally {
    await clearSignInLimits();
  }
});

test('SCR-APP-001 error and SCR-APP-002 sent-but-delayed (UC-01 2c)', async ({ page }) => {
  await page.route('**/api/v1/auth/magic-link', (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'unavailable', message: 'Try again shortly' },
    }),
  );
  await page.goto('/sign-in');
  await submitEmail(page, 'someone@example.test');
  await expect(
    page.getByRole('alert').filter({ hasText: "We couldn't send your link" }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.unroute('**/api/v1/auth/magic-link');
  await page.route('**/api/v1/auth/magic-link', (route) =>
    route.fulfill({ status: 202, json: { delayed: true } }),
  );
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByText('Your email may take a few minutes')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'Use a different email' }).click();
  await expect(page.getByLabel('Work email')).toBeVisible();
});

test('SCR-APP-002 expired link and verify error states', async ({ page }) => {
  const token = 'b'.repeat(43);
  await page.route('**/api/v1/auth/magic-link/verify', (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'link_expired', message: 'This link has expired.' },
    }),
  );
  await page.goto(`/auth/verify#token=${token}`);
  await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
  expect(page.url()).not.toContain('token');
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('link', { name: 'Send a new link' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.unroute('**/api/v1/auth/magic-link/verify');
  await page.route('**/api/v1/auth/magic-link/verify', (route) => route.abort('failed'));
  await page.goto(`/auth/verify#token=${token}`);
  await expect(page.getByRole('alert')).toContainText("We couldn't sign you in");
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('SCR-APP-003 terms-updated: a stale version gets 409 and nothing is created (AUTH-08)', async ({
  page,
}) => {
  const email = `terms-${Date.now()}@example.test`;
  const link = await requestSignInLink(page, email);

  // The page is shown an older version once; the real api then refuses it.
  await page.route(
    '**/api/v1/auth/options',
    async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { terms: { version: string }[] };
      for (const t of body.terms) t.version = '2020-01-01';
      await route.fulfill({ response: res, json: body });
    },
    { times: 1 },
  );
  await page.goto(link);
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByText('Versions 2020-01-01')).toBeVisible();

  await page.getByLabel('Business name (required)').fill('Stale Terms Cafe');
  const box = page.getByRole('checkbox', { name: /I agree to the Terms of Service/ });
  await box.check();
  const refused = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/workspaces') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create workspace' }).click();
  expect((await refused).status()).toBe(409);
  await expect(
    page.getByRole('alert').filter({ hasText: 'The terms were just updated' }),
  ).toBeVisible();
  await expect(box).not.toBeChecked();
  // The versions are refetched: the current ones are shown now.
  await expect(page.getByText('Versions 2020-01-01')).toHaveCount(0);
  await expect(page).toHaveURL(/\/welcome$/);
  await expectNoSeriousA11yViolations(page);

  // Agreeing to the current versions succeeds.
  await box.check();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByTestId('tenant-name')).toHaveText('Stale Terms Cafe');
});

test('SCR-APP-003 error: a failed request keeps the input', async ({ page }) => {
  const link = await requestSignInLink(page, `ws-error-${Date.now()}@example.test`);
  await page.route('**/api/v1/workspaces', (route) =>
    route.fulfill({ status: 500, json: { error: 'internal', message: 'Something went wrong' } }),
  );
  await page.goto(link);
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByLabel('Business name (required)').fill('Error Path Bakery');
  await page.getByRole('checkbox', { name: /I agree to the Terms of Service/ }).check();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('alert')).toContainText("We couldn't create your workspace");
  await expect(page.getByLabel('Business name (required)')).toHaveValue('Error Path Bakery');
  await expectNoSeriousA11yViolations(page);
});
