import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:3000'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries. A dashboard that works on the second attempt is a defect, and
  // retrying here would launder it the same way a retried CI job launders a
  // flaky suite.
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'list' : 'html',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The original suite. It assumes a session nothing creates, so it is kept
      // out of the self-host run rather than switched on and left red.
      testIgnore: /[\\/]selfhost[\\/]/,
    },

    // ── The self-host browser suite ──────────────────────────────────────────
    // Split into its own projects so CI can run THESE without also running the
    // aspirational specs above. `--project=selfhost` is the whole entry point.
    {
      name: 'selfhost-setup',
      use: { ...devices['Desktop Chrome'] },
      testDir: './tests/e2e/selfhost',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'selfhost',
      use: {
        ...devices['Desktop Chrome'],
        // Every spec starts signed in, as the first operator.
        storageState: '.playwright/selfhost-state.json',
      },
      testDir: './tests/e2e/selfhost',
      testIgnore: /auth\.setup\.ts/,
      dependencies: ['selfhost-setup'],
    },
  ],

  // Only boot a local stack when the target IS the local stack, and only when
  // nothing has already booted one.
  //
  // Previously this started `npm run dev` unconditionally, so pointing
  // PLAYWRIGHT_TEST_BASE_URL at a deployed environment spent 60s trying to
  // start a server nobody was going to talk to, then failed the run with a
  // timeout that looked like the deployment was broken.
  //
  // PLAYWRIGHT_SERVER_ALREADY_RUNNING is for CI, where the self-host job builds
  // and starts the app itself against the deployment it just installed. Without
  // it Playwright would start a SECOND server on a port already in use, because
  // reuseExistingServer is false under CI — and the failure would look like the
  // app was broken rather than doubly started.
  webServer:
    process.env.PLAYWRIGHT_SERVER_ALREADY_RUNNING ||
    !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE_URL)
      ? undefined
      : {
          command: 'npm run dev',
          url: 'http://localhost:3000',
          reuseExistingServer: !process.env.CI,
        },
})
