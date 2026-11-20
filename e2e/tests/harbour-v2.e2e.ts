import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, signIn } from './support.ts';

/**
 * FEAT-076 Harbour v2 restyle (technical-design §6): Inter from the app's own origin, selection by
 * the neutral fill, segmented tabs, gradient-edge alerts, the Source page's meta-grid and
 * event-timeline, and axe at 1440 and 375 px on the screens the restyle touches. The Source
 * states come from a stubbed detail response so each state is shown without waiting for a crawl.
 */
const OPERATOR = 'http://localhost:5174/';
/**
 * Phone width for axe, tall enough that no control sits under the sticky tab bar: at 375 × 812
 * axe's target-size rule flags whichever control the bar happens to cover, on main as on this
 * branch (verify A/B, 2026-11-20), which is a viewport artifact, not a layout fault.
 */
const PHONE = { width: 375, height: 5000 };
const at = '2026-11-17T02:02:00Z';
const counts = {
  pagesFound: 44,
  pagesIncluded: 38,
  pagesExcluded: 5,
  pagesFailed: 0,
  pagesSkipped: 1,
  pagesExtracted: 18,
  facts: 0,
  factsNeedingReview: 0,
};
const source = (id: string, o: Record<string, unknown>) => ({
  id,
  kind: 'website',
  status: 'processing',
  stage: 'extract',
  name: 'harbour-v2.test',
  url: 'https://harbour-v2.test',
  domain: 'harbour-v2.test',
  subdomains: [],
  pageLimit: 50,
  failure: null,
  retryable: false,
  file: null,
  sheet: null,
  chat: null,
  counts,
  attestedAt: at,
  createdAt: at,
  updatedAt: at,
  finishedAt: null,
  version: 1,
  ...o,
});
const SOURCES = {
  processing: source('7f6e0a10-0000-4000-8000-000000000001', {}),
  ready: source('7f6e0a10-0000-4000-8000-000000000002', {
    status: 'ready',
    stage: null,
    finishedAt: '2026-11-17T02:09:00Z',
    counts: { ...counts, pagesExtracted: 38, facts: 41, factsNeedingReview: 6 },
  }),
  failed: source('7f6e0a10-0000-4000-8000-000000000003', {
    status: 'failed',
    stage: 'crawl',
    failure: 'site_unreachable',
    retryable: true,
    finishedAt: '2026-11-17T02:04:00Z',
  }),
};

async function stubSources(page: Page) {
  for (const s of Object.values(SOURCES))
    await page.route(`**/api/v1/kb/sources/${s.id}`, (route) =>
      route.fulfill({ json: { source: s, pages: [] } }),
    );
}

const token = (page: Page, name: string) =>
  page.evaluate((n) => {
    // Resolve the token to the same serialisation getComputedStyle gives a background.
    const probe = document.createElement('i');
    probe.style.backgroundColor = `var(${n})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, name);
const style = (page: Page, selector: string, prop: string, pseudo?: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((e, [p, ps]) => getComputedStyle(e, ps ?? null).getPropertyValue(p!), [prop, pseudo]);

test('Inter is served from the dashboard and operator origins, never Google Fonts', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await signIn(page, 'owner@kaki-bakery.test');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('500 14px Inter'))).toBe(true);
  const fonts = requests.filter((u) => u.endsWith('.woff2'));
  expect(fonts.length).toBeGreaterThan(0);
  for (const u of fonts) expect(new URL(u).origin).toBe(new URL(page.url()).origin);

  await page.goto(OPERATOR);
  await expect(page.getByRole('heading', { name: 'Tenants', level: 1 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('600 14px Inter'))).toBe(true);
  expect(requests.some((u) => /fonts\.(googleapis|gstatic)\.com/.test(u))).toBe(false);
});

test('selection is the neutral fill: sidebar, tabs and the phone tab bar', async ({ page }) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/knowledge/sources');
  await expect(page.getByRole('heading', { name: 'Knowledge', level: 1 })).toBeVisible();
  const fill = await token(page, '--color-bg-fill');
  const primary = await token(page, '--color-text-primary');

  const nav = page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /Knowledge/ });
  await expect(nav).toHaveAttribute('aria-current', 'page');
  await expect(nav).toHaveCSS('background-color', fill);
  await expect(nav).toHaveCSS('color', primary);

  const tab = page
    .getByRole('navigation', { name: 'Knowledge' })
    .getByRole('link', { name: /Sources/ });
  await expect(tab).toHaveCSS('background-color', fill);
  await expect(tab).toHaveCSS('border-bottom-width', '0px');
  await expect(tab).toHaveCSS('border-top-left-radius', '12px');

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/inbox');
  const inboxTab = page.locator('.tabbar .tab-bar-item.active .tab-bar-item__icon');
  await expect(inboxTab).toHaveCSS('background-color', fill);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('Source page: meta-grid, event-timeline and gradient-edge alerts in every state', async ({
  page,
}) => {
  await signIn(page, 'owner@kaki-bakery.test');
  await stubSources(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Processing: the step in progress is marked and says how far it is.
  await page.goto(`/knowledge/sources/${SOURCES.processing.id}`);
  await expect(page.getByRole('heading', { name: 'harbour-v2.test', level: 1 })).toBeVisible();
  const meta = page.locator('dl.kaki-meta-grid');
  await expect(meta.getByText('Status')).toBeVisible();
  await expect(meta.getByText('Not yet')).toBeVisible();
  await expect(meta.getByText(/^Confirmed by you on /)).toBeVisible();
  const steps = page.getByRole('list', { name: 'Steps' });
  await expect(steps.getByRole('listitem')).toHaveCount(5);
  const current = steps.locator('li[aria-current="step"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText('Find facts');
  await expect(current).toContainText('In progress · 18 of 38');
  await expectNoSeriousA11yViolations(page);

  // Ready: one "Ready", the success outcome with its Review link, and the figures.
  await page.goto(`/knowledge/sources/${SOURCES.ready.id}`);
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Finished reading 38 pages.')).toBeVisible();
  await expect(
    page.getByText('6 of the 41 facts need your review before your assistant uses them.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review facts' })).toHaveAttribute('href', '/review');
  await expect(page.getByText('Facts found')).toHaveCount(1);
  await expect(steps.locator('li[aria-current="step"]')).toHaveCount(0);
  await expect(steps.getByText('Finished')).toBeVisible();
  const success = page.locator('.alert--success');
  await expect(success).toHaveCSS('border-top-width', '1px');
  await expect(success).toHaveCSS('border-top-left-radius', '16px');
  expect(await style(page, '.alert--success', 'background-image')).toContain(
    (await token(page, '--color-success-soft')).replace('rgb(', ''),
  );
  expect(await style(page, '.alert--success', 'width', '::before')).toBe('20px');
  await expectNoSeriousA11yViolations(page);

  // Failed: the danger alert with Retry; the failing stage stopped, Failed ends the timeline.
  await page.goto(`/knowledge/sources/${SOURCES.failed.id}`);
  const danger = page.getByRole('alert').filter({ hasText: "We couldn't reach the site." });
  await expect(danger).toBeVisible();
  await expect(danger.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(steps.getByText('Stopped here')).toBeVisible();
  await expect(steps.getByText('Failed', { exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // Phone: the steps stack and nothing scrolls sideways. The page is as tall as its content
  // (PHONE), as in the other phone-width axe checks, so nothing sits under the sticky tab bar.
  await page.setViewportSize(PHONE);
  await page.goto(`/knowledge/sources/${SOURCES.processing.id}`);
  await expect(current).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page);
});

test('the restyled screens pass axe at 1440 and 375 px', async ({ page }) => {
  test.slow();
  await signIn(page, 'owner@kaki-bakery.test');
  for (const width of [1440, 375]) {
    await page.setViewportSize(width === 375 ? PHONE : { width, height: 900 });
    for (const path of ['/', '/inbox', '/knowledge', '/knowledge/sources', '/settings/team']) {
      await page.goto(path);
      await expect(page.locator('h1').first()).toBeVisible();
      // Axe a settled page: loading skeletons are replaced by content first.
      await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
      await expectNoSeriousA11yViolations(page);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(OPERATOR);
  await expect(page.getByRole('heading', { name: 'Tenants', level: 1 })).toBeVisible();
  await expect(page.locator('.ops__nav-item[aria-current="page"]')).toHaveText('Tenants');
  await expectNoSeriousA11yViolations(page);
});
