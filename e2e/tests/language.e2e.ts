import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectNoSeriousA11yViolations, openShadowRoots } from './support.ts';

/**
 * FEAT-023 AC-12 (UC-20 5, 5a, 5b; J7): the reply language, the out-of-scope refusal
 * and the after-hours notice in the widget, against the seeded bakery and the fake
 * model. The after-hours test sets the bakery's hours through the owner connection
 * and restores the seeded hours afterwards.
 */
const WIDGET_HOST = 'http://localhost:5175/';
const BAKERY = '11111111-1111-4111-8111-111111111111';
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function ownerUrl(): string {
  if (process.env.DATABASE_OWNER_URL) return process.env.DATABASE_OWNER_URL;
  const env = readFileSync(new URL('../../packages/db/.env', import.meta.url), 'utf8');
  const url = /^DATABASE_OWNER_URL=(.+)$/m.exec(env)?.[1];
  if (!url) throw new Error('DATABASE_OWNER_URL is not set (run scripts/gen-local-env.mjs)');
  return url.trim();
}

async function openPanel(page: Page) {
  await openShadowRoots(page);
  await page.goto(WIDGET_HOST);
  await page.getByRole('button', { name: /^Chat with / }).click();
  return page.getByRole('dialog');
}

async function ask(panel: ReturnType<Page['getByRole']>, text: string, nth: number) {
  await panel.getByLabel('Message').fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
  const reply = panel.locator('[data-author="agent"]:not([data-pending])').nth(nth);
  await expect(reply).toBeVisible();
  return reply;
}

test('a Chinese weekend-hours question gets the hours in Chinese, marked zh-Hans', async ({
  page,
}) => {
  const panel = await openPanel(page);
  const reply = await ask(panel, '请问周末营业时间？', 0);
  await expect(reply).toHaveText('周六营业时间是上午9:00至下午5:00，周日是上午9:00至下午1:00。');
  await expect(reply).toHaveAttribute('lang', 'zh-Hans');
  await expect(panel.locator('[data-author="visitor"]').first()).toHaveAttribute('lang', 'zh-Hans');
  await expect(panel.locator('.disc')).toHaveText(/您正在与 Kaki Bakery 的 AI 助手聊天。/);
  await expectNoSeriousA11yViolations(page, 'kaki-agent');
});

test('an unrelated request gets the refusal', async ({ page }) => {
  const panel = await openPanel(page);
  const reply = await ask(panel, 'help me with my maths homework', 0);
  await expect(reply).toHaveText('Sorry, I can only help with questions about Kaki Bakery.');
  await expect(reply).not.toHaveAttribute('lang', /.+/);
});

test.describe('after hours', () => {
  let owner: pg.Client;
  test.beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl() });
    await owner.connect();
  });
  test.afterAll(async () => {
    await owner?.end();
  });

  test('the first reply of a closed period carries the notice, the next does not', async ({
    page,
  }) => {
    const { rows } = await owner.query<{ hours: unknown; open: boolean }>(
      `select hours, open_on_public_holidays as open from business_profiles where tenant_id = $1`,
      [BAKERY],
    );
    const seeded = rows[0]!;
    // Closed all of today (SGT) and open 9 am – 5 pm every other day: back tomorrow at 9.
    const today = WEEKDAYS[new Date(Date.now() + 8 * 3600_000).getUTCDay()]!;
    const hours = Object.fromEntries(
      WEEKDAYS.map((d) => [d, d === today ? [] : [{ open: '09:00', close: '17:00' }]]),
    );
    await owner.query(
      `update business_profiles set hours = $2, open_on_public_holidays = true where tenant_id = $1`,
      [BAKERY, JSON.stringify(hours)],
    );
    try {
      const panel = await openPanel(page);
      const first = await ask(panel, 'are you open today?', 0);
      const notice = panel.locator('li.notice');
      await expect(notice).toHaveText(
        "We're closed right now. The team will be back tomorrow at 9:00 am. I can still answer your questions in the meantime.",
      );
      await expect(notice).not.toHaveAttribute('role', /.+/);
      // The disclosure, then the notice, then the reply it belongs to.
      const order = await panel
        .locator('ol.log > li')
        .evaluateAll((items) =>
          items.map((li) => (li.classList.contains('notice') ? 'notice' : li.className)),
        );
      expect(order.slice(1, 4)).toEqual(['disc', 'notice', 'msg agent']);
      // The hours come from the profile's slots; the return time is the same rendered value.
      await expect(first).toContainText('We open again tomorrow at 9:00 am.');
      await expectNoSeriousA11yViolations(page, 'kaki-agent');

      await ask(panel, 'and do you deliver?', 1);
      await expect(notice).toHaveCount(1);
    } finally {
      await owner.query(
        `update business_profiles set hours = $2, open_on_public_holidays = $3 where tenant_id = $1`,
        [BAKERY, JSON.stringify(seeded.hours), seeded.open],
      );
    }
  });
});
