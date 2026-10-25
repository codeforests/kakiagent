import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, openShadowRoots, signIn } from './support.ts';

/**
 * FEAT-032 AC-3, AC-4, AC-6–AC-9, AC-13 (ONB-07, CHN-11, CHN-14; UC-05): the widget matches
 * the four fixture sites, follows a page that turns dark, stays isolated from the host both
 * ways, stays silent on an unlisted origin, and the owner adjusts the look, copies the
 * snippet and sees the install check turn green.
 *
 * The fixture sites are served by the widget dev server with the dev tenant's key; the dev
 * tenants allow http://localhost:5175. Every test that changes the look puts it back.
 */
const SITES = 'http://localhost:5175/sites';
const ORIGIN = 'http://localhost:5175';
const OWNER = 'owner@kaki-bakery.test';

test.describe.configure({ mode: 'serial' });

/** Calls the dashboard api from a signed-in page. */
async function apiCall(owner: Page, method: string, path: string, body?: unknown) {
  return owner.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(p as string, {
        method: m as string,
        headers: b === undefined ? {} : { 'content-type': 'application/json' },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
    },
    [method, path, body] as const,
  );
}

/** No overrides, bottom right, and the fixture origin allowed. */
async function resetLook(owner: Page) {
  expect(
    (await apiCall(owner, 'PUT', '/api/v1/widget/appearance', { position: 'right', overrides: {} }))
      .status,
  ).toBe(200);
  const added = await apiCall(owner, 'POST', '/api/v1/widget/origins', { origin: ORIGIN });
  expect([201, 409]).toContain(added.status);
}

/** The resolved `--kaki-*` tokens and the launcher's look, once the page's live look applied. */
async function widgetLook(page: Page) {
  const launcher = page.locator('kaki-agent button.launcher');
  await expect(launcher).toBeVisible();
  return launcher.evaluate((el) => {
    const s = getComputedStyle(el);
    const v = (n: string) => s.getPropertyValue(`--kaki-${n}`).trim();
    const host = (el.getRootNode() as ShadowRoot).host as HTMLElement;
    const rect = host.getBoundingClientRect();
    return {
      accent: v('accent').toLowerCase(),
      onAccent: v('on-accent').toLowerCase(),
      surface: v('surface').toLowerCase(),
      font: v('font'),
      radius: v('radius'),
      background: s.backgroundColor,
      width: s.width,
      left: rect.left < window.innerWidth / 2,
    };
  });
}

/** WCAG contrast of two `#rrggbb` colours. */
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

// The owner flow removes the fixture origin part-way. If it fails before adding it back,
// put it back, or every later spec's widget (and the next browser's run) stays silent.
test.afterEach(async ({ page }, info) => {
  if (info.title.startsWith('the owner adjusts') && info.status !== info.expectedStatus)
    await resetLook(page);
});

test('the widget matches each fixture site and keeps text readable', async ({ page, browser }) => {
  await signIn(page, OWNER);
  await resetLook(page);

  const expected = [
    {
      site: 'wordpress',
      accent: '#bb8b00',
      font: 'Lora',
      radius: '4px',
      dark: false,
      clamped: '#f6c453',
    },
    { site: 'wix', accent: '#7c3aed', font: 'Montserrat', radius: '20px', dark: true },
    { site: 'shopify', accent: '#008060', font: 'Assistant', radius: '8px', dark: false },
    { site: 'plain', accent: '#1d4ed8', font: 'Georgia', dark: false },
  ];
  for (const e of expected) {
    const visitor = await browser.newPage();
    await openShadowRoots(visitor);
    await visitor.goto(`${SITES}/${e.site}.html`);
    await expect
      .poll(async () => (await widgetLook(visitor)).font, { message: e.site })
      .toContain(e.font);
    const look = await widgetLook(visitor);
    if (e.accent) expect(look.accent, e.site).toBe(e.accent);
    // The pale WordPress gold is adjusted, not used as is (D5).
    if (e.clamped) expect(look.accent, e.site).not.toBe(e.clamped);
    if (e.radius) expect(look.radius, e.site).toBe(e.radius);
    expect(contrast(look.accent, look.onAccent), e.site).toBeGreaterThanOrEqual(4.5);
    expect(contrast(look.accent, look.surface), e.site).toBeGreaterThanOrEqual(3);
    // Dark sites get the dark panel surface: dark surfaces are darker than light ones.
    expect(contrast(look.surface, '#000000') < contrast(look.surface, '#ffffff'), e.site).toBe(
      e.dark,
    );
    await visitor.close();
  }
});

test('the widget follows a page that turns dark, and the host and widget stay apart', async ({
  browser,
}) => {
  const visitor = await browser.newPage();
  await openShadowRoots(visitor);
  await visitor.goto(`${SITES}/plain.html`);
  const before = await widgetLook(visitor);

  // Host → widget: the hostile resets don't reach the launcher (56 px circle).
  expect(before.width).toBe('56px');
  // Widget → host: no style elements or globals beyond `window.__kaki` and <kaki-agent>.
  const page = await visitor.evaluate(() => ({
    styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
    globals: Object.keys(window),
  }));
  const bare = await browser.newPage();
  await bare.route(`${SITES}/plain.html`, async (route) => {
    const res = await route.fetch();
    await route.fulfill({
      response: res,
      body: (await res.text()).replace(/<script[^>]*loader\.js[^>]*><\/script>/, ''),
    });
  });
  await bare.goto(`${SITES}/plain.html`);
  const clean = await bare.evaluate(() => ({
    styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
    globals: Object.keys(window),
  }));
  await bare.close();
  expect(page.styles).toBe(clean.styles);
  // Playwright's own globals (WebKit's trace snapshot streamer) are the harness, not the page.
  const added = page.globals.filter(
    (k) => !clean.globals.includes(k) && !k.startsWith('__playwright'),
  );
  expect(added).toEqual(['__kaki']);

  // The page turns dark: the widget follows within 500 ms without re-mounting (AC-8).
  const host = await visitor.locator('kaki-agent').elementHandle();
  await visitor.evaluate(() => {
    document.documentElement.classList.add('dark');
    document.documentElement.style.backgroundColor = '#111111';
    document.body.style.backgroundColor = '#111111';
    document.body.style.color = '#eeeeee';
  });
  await expect
    .poll(async () => (await widgetLook(visitor)).surface, { timeout: 500, intervals: [100] })
    .not.toBe(before.surface);
  expect(await visitor.evaluate((h) => h!.isConnected, host)).toBe(true);
  expect(await visitor.locator('kaki-agent').count()).toBe(1);
  await visitor.close();

  // A scheme the owner fixed stops the following (AC-8): the config carries a light
  // override, the page turns dark, and the widget keeps its light surface.
  const fixed = await browser.newPage();
  await openShadowRoots(fixed);
  await fixed.route(/\/widget\/v1\/config/, async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { theme: { overrides: Record<string, unknown> } };
    json.theme.overrides = { ...json.theme.overrides, scheme: 'light' };
    await route.fulfill({ response: res, json });
  });
  await fixed.goto(`${SITES}/plain.html`);
  const light = await widgetLook(fixed);
  await fixed.evaluate(() => {
    document.documentElement.classList.add('dark');
    document.documentElement.style.backgroundColor = '#111111';
    document.body.style.backgroundColor = '#111111';
  });
  await fixed.waitForTimeout(800);
  expect((await widgetLook(fixed)).surface).toBe(light.surface);
  await fixed.close();
});

test('the owner adjusts the look, installs the widget and sees the check turn green', async ({
  page: owner,
  browser,
}) => {
  // Detection waits on the ingest worker, so the whole flow gets more than the default 60 s.
  test.setTimeout(120_000);
  await signIn(owner, OWNER);
  await resetLook(owner);

  // SCR-APP-037 from Settings.
  await owner.goto('/settings');
  await owner.getByRole('link', { name: /Website widget/ }).click();
  await expect(owner.getByRole('heading', { name: 'Website widget', level: 1 })).toBeVisible();
  await expect(owner.locator('iframe[title="Widget preview"]')).toBeVisible();
  await expectNoSeriousA11yViolations(owner);

  // Detection settles: matched, or a failure the page explains (the dev site may be private).
  const match = owner.getByRole('button', { name: 'Match again' });
  if (await match.isVisible()) {
    await match.click();
    // The caption is the preview's status line; its text starts after the spinner's slot,
    // so the pattern isn't anchored. It shows the new run before the settled result, so an
    // earlier "Matched to …" can't pass for this one.
    const caption = owner.getByRole('region', { name: 'Widget preview' }).getByRole('status');
    await expect(caption).toHaveText(/Matching your website/);
    await expect(caption).toHaveText(
      /Matched to |We couldn't open |isn't a public website|took too long|didn't return a page/,
      { timeout: 60_000 },
    );
  }

  // Override the colour and the position; Save.
  await owner.getByLabel('Choose a colour').check();
  await owner.getByLabel('Colour code').fill('#0f766e');
  await owner.getByLabel('Bottom left').check();
  await owner.getByRole('button', { name: 'Save' }).click();
  await expect(
    owner.getByText('Saved. Your widget looks like this on your website now.'),
  ).toBeVisible();

  // Copy the snippet; the steps per platform.
  // The clipboard is captured, since Firefox and WebKit don't grant clipboard reads to tests.
  await owner.evaluate(() => {
    navigator.clipboard.writeText = async (text: string) => {
      (window as Window & { __copied?: string }).__copied = text;
    };
  });
  await owner.getByRole('button', { name: 'Copy' }).click();
  await expect(owner.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await owner.evaluate(() => (window as Window & { __copied?: string }).__copied);
  expect(copied).toMatch(/^<script .*loader\.js.*data-key="[^"]+".*><\/script>$/);
  for (const tab of ['Wix', 'Shopify', 'HTML', 'WordPress'])
    await owner.getByRole('tab', { name: tab }).click();

  // The override reaches the widget on its next load, on the left.
  const visitor = await browser.newPage();
  await openShadowRoots(visitor);
  await visitor.goto(`${SITES}/plain.html`);
  const look = await widgetLook(visitor);
  expect(look.left).toBe(true);
  expect(look.accent).not.toBe('#1d4ed8');
  await visitor.close();

  // Remove the fixture origin: the widget is silent there and the check names it (AC-4, AC-5).
  const row = owner.getByRole('listitem').filter({ hasText: 'localhost:5175' });
  await row.getByRole('button', { name: 'Remove localhost:5175' }).click();
  await owner.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row).toHaveCount(0);
  const silent = await browser.newPage();
  const config = silent.waitForResponse((r) => r.url().includes('/widget/v1/config'));
  await silent.goto(`${SITES}/plain.html`);
  expect((await config).status()).toBe(404);
  await silent.waitForTimeout(500);
  expect(await silent.locator('kaki-agent').count()).toBe(0);
  await silent.close();
  await expect(owner.getByText("Loaded on localhost:5175, which isn't allowed")).toBeVisible({
    timeout: 15_000,
  });
  await expectNoSeriousA11yViolations(owner);

  // Add it back from the alert; the widget loads there and the check turns green, no reload.
  await owner.getByRole('button', { name: 'Add localhost:5175' }).click();
  const back = await browser.newPage();
  await openShadowRoots(back);
  await back.goto(`${SITES}/plain.html`);
  await expect(back.locator('kaki-agent button.launcher')).toBeVisible();
  await back.close();
  await expect(owner.getByText('Installed on localhost:5175')).toBeVisible({ timeout: 15_000 });

  // SCR-APP-011, the setup step after "Test your assistant".
  await owner.goto('/setup/website');
  await expect(owner.getByRole('heading', { name: 'Add to your website' })).toBeVisible();
  await expect(owner.getByText('Your widget is on localhost:5175.')).toBeVisible();
  await expectNoSeriousA11yViolations(owner);

  await resetLook(owner);
});

test('an unlisted origin gets nothing and is recorded for the install check', async ({
  page: owner,
  browser,
}) => {
  // 127.0.0.1:5175 serves the same page but isn't allowed. The second dev tenant's key is
  // used, so the bakery's once-a-minute rejection record above doesn't throttle this one.
  const visitor = await browser.newPage();
  await visitor.route('http://127.0.0.1:5175/sites/plain.html', async (route) => {
    const res = await route.fetch();
    await route.fulfill({
      response: res,
      body: (await res.text()).replace(/data-key="[^"]*"/, 'data-key="wk_dev_second"'),
    });
  });
  const config = visitor.waitForResponse((r) => r.url().includes('/widget/v1/config'));
  await visitor.goto('http://127.0.0.1:5175/sites/plain.html');
  const res = await config;
  expect(res.status()).toBe(404);
  expect(await res.text()).not.toContain('token');
  await visitor.waitForTimeout(500);
  expect(await visitor.locator('kaki-agent').count()).toBe(0);
  await visitor.close();

  await signIn(owner, 'owner@second-tenant.test');
  const settings = await apiCall(owner, 'GET', '/api/v1/widget');
  const install = (settings.body as { install: { rejectedOrigin: string | null } }).install;
  expect(install.rejectedOrigin).toBe('http://127.0.0.1:5175');
});
