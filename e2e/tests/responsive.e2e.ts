import { expect, test, type Browser, type Page } from '@playwright/test';
import { openShadowRoots, signIn } from './support.ts';

/**
 * Laptop and monitor layouts (fix: 14" laptops at 150% scaling get a 1280 px window). At the
 * common desktop window sizes every main dashboard screen fits without sideways scrolling, a
 * channel-health banner sits under the top bar and beside the sidebar (not under them), and an
 * open conversation keeps at least 480 px with the details panel beside it only from 1440 px.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const SIZES = [
  { width: 1280, height: 680 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const SCREENS = [
  '/',
  '/inbox',
  '/approvals',
  '/review',
  '/knowledge',
  '/knowledge/coverage',
  '/coach',
  '/leads?status=all',
  '/settings',
  '/settings/assistant',
  '/settings/audit',
  '/settings/team',
  '/settings/channels',
  '/settings/widget',
  '/account',
];

async function conversationFromWidget(browser: Browser): Promise<string> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  const panel = page.getByRole('dialog');
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/widget/v1/conversations') && r.request().method() === 'POST',
  );
  await panel.getByLabel('Message').fill('Can I talk to a person please?');
  await panel.getByRole('button', { name: 'Send' }).click();
  const id = ((await (await created).json()) as { conversationId: string }).conversationId;
  await context.close();
  return id;
}

/** Reports the first channel as degraded, so every page shows the channel-health banner. */
async function forceChannelBanner(page: Page) {
  await page.route('**/api/v1/channels', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { channels: { health: string | null }[] };
    expect(body.channels.length).toBeGreaterThan(0);
    body.channels[0]!.health = 'degraded';
    await route.fulfill({ response: res, json: body });
  });
}

const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (s: string) => document.querySelector(s)?.getBoundingClientRect() ?? null;
    const top = box('.topbar');
    const side = box('.sidebar');
    const banner = box('.banners');
    return {
      sideways: document.documentElement.scrollWidth - window.innerWidth,
      bannerTop: banner && top ? banner.top - top.bottom : null,
      bannerLeft: banner && side && side.width > 0 ? banner.left - side.right : null,
    };
  });

test('every main screen fits laptop and monitor windows, banner and all', async ({ page }) => {
  test.slow();
  await signIn(page, 'owner@kaki-bakery.test');
  await forceChannelBanner(page);
  for (const size of SIZES) {
    await page.setViewportSize(size);
    for (const path of SCREENS) {
      await page.goto(path);
      // Channels shows the problem as its own alert instead of the banner (channels.e2e).
      if (path !== '/settings/channels')
        await expect(page.getByRole('region', { name: 'Channel problem' })).toBeVisible();
      await expect(page.locator('h1').first()).toBeVisible();
      const l = await layout(page);
      expect(l.sideways, `${path} at ${size.width} px scrolls sideways`).toBeLessThanOrEqual(0);
      if (path === '/settings/channels') continue;
      expect(
        l.bannerTop,
        `${path} at ${size.width} px: banner under the top bar`,
      ).toBeGreaterThanOrEqual(-1);
      expect(
        l.bannerLeft,
        `${path} at ${size.width} px: banner under the sidebar`,
      ).toBeGreaterThanOrEqual(-1);
    }
  }
});

test('an open conversation stays readable from 1280 to 1920 px', async ({ page, browser }) => {
  const id = await conversationFromWidget(browser);
  await signIn(page, 'owner@kaki-bakery.test');
  await forceChannelBanner(page);
  const inline = page.getByRole('complementary', { name: 'Conversation details' });
  const detailsButton = page.getByRole('button', { name: 'Conversation details' });
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await page.goto(`/inbox/${id}`);
    await expect(page.getByTestId('thread-dock')).toBeVisible();
    const m = await page.evaluate(() => ({
      conversation: document.querySelector('.conversation__main')!.getBoundingClientRect().width,
      dock: document.querySelector('[data-testid="thread-dock"]')!.getBoundingClientRect().bottom,
      pageFits: document.scrollingElement!.scrollHeight <= window.innerHeight,
    }));
    expect(m.conversation, `conversation width at ${size.width} px`).toBeGreaterThanOrEqual(480);
    expect(m.dock).toBeLessThanOrEqual(size.height);
    expect(m.pageFits).toBe(true);
    if (size.width >= 1440) {
      await expect(inline).toBeVisible();
      await expect(detailsButton).toHaveCount(0);
    } else {
      // Laptops: the details open from the header as a drawer instead.
      await expect(inline).toHaveCount(0);
      await detailsButton.click();
      await expect(page.getByRole('dialog', { name: 'Conversation details' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(detailsButton).toBeFocused();
    }
  }
});
