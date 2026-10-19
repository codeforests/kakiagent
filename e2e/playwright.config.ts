import { defineConfig, devices } from '@playwright/test';

/**
 * The skeleton E2E (plan §2). CI installs all three engines; locally, set
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE to use a preinstalled Chromium and run
 * `--project=chromium`.
 *
 * The stack (compose, `pnpm db:setup`) must be up first. `pnpm dev` is started here
 * unless E2E_REUSE_SERVERS=true and it is already running.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './global-setup.ts',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'pnpm dev',
    cwd: '..',
    url: 'http://localhost:3000/readyz',
    reuseExistingServer: process.env.E2E_REUSE_SERVERS === 'true' || !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
    // SIGTERM lets turbo stop every dev server; the default kill leaves them orphaned.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
