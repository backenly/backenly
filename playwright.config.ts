import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:3000'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Only boot a local stack when the target IS the local stack.
  //
  // Previously this started `npm run dev` unconditionally, so pointing
  // PLAYWRIGHT_TEST_BASE_URL at a deployed environment spent 60s trying to
  // start a server nobody was going to talk to, then failed the run with a
  // timeout that looked like the deployment was broken.
  webServer: /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE_URL)
    ? {
        command: 'npm run dev',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
      }
    : undefined,
})
