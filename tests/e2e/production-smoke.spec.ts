import { test, expect } from '@playwright/test'

/**
 * Read-only smoke tests against a LIVE deployment.
 *
 * The other specs in this directory create backends — they provision real
 * schemas and real infrastructure, which is correct for a disposable local
 * stack and unacceptable against production. Nothing here writes anything: no
 * signup, no project creation, no mutation of any kind. Every assertion is a
 * GET, so this is safe to run against backenly.com on every deploy.
 *
 *   npx playwright test tests/e2e/production-smoke.spec.ts \
 *     --project=chromium
 *
 * Point it somewhere else with PLAYWRIGHT_TEST_BASE_URL.
 *
 * What it is actually for: unit tests prove the pieces agree with their own
 * assumptions. This proves the deployed thing is up, serves the contract it
 * claims, and does not leak — three properties no unit test can establish,
 * because they depend on nginx, PM2, the build output, and the environment all
 * being right at the same time.
 */

const BASE = process.env.PLAYWRIGHT_TEST_BASE_URL || 'https://backenly.com'

// A real project id, used only for its PUBLIC discovery document. No auth, no
// data — the discovery endpoint is designed to be safe to expose.
// Overridable, because a hardcoded project id turns a deleted project into a
// failing smoke test that looks like a production outage. That happened.
const PUBLIC_PROJECT =
  process.env.SMOKE_PROJECT_ID || 'ce18214a-51bc-42cf-8b69-ffaf495234b0'

test.describe('liveness', () => {
  test('health endpoint answers 200', async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`)
    expect(res.status()).toBe(200)
  })

  test('landing page renders server-side', async ({ page }) => {
    // Catches the failure mode where the build succeeded, PM2 restarted, and
    // the standalone output is missing its static assets — the page 200s but
    // renders nothing.
    const res = await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    expect(res?.status()).toBe(200)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('page loads its CSS, not just its HTML', async ({ page }) => {
    // The postbuild static-asset copy has silently failed before, leaving an
    // unstyled page that every status check calls healthy.
    const failed: string[] = []
    page.on('requestfailed', r => {
      if (/\.(css|js)$/.test(r.url())) failed.push(r.url())
    })
    await page.goto(BASE, { waitUntil: 'load' })
    expect(failed).toEqual([])
  })
})

test.describe('public API contract', () => {
  test('discovery document has the documented shape', async ({ request }) => {
    const res = await request.get(`${BASE}/api/v1/${PUBLIC_PROJECT}`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      projectId: PUBLIC_PROJECT,
      authentication: { scheme: 'apiKey', header: 'x-api-key' },
    })
    expect(body.endpoints).toBeDefined()
  })

  test('discovery leaks no rows and no secrets', async ({ request }) => {
    // It names what the backend can do; it must never include a row of customer
    // data or anything credential-shaped.
    const body = await (await request.get(`${BASE}/api/v1/${PUBLIC_PROJECT}`)).text()
    expect(body).not.toMatch(/password|jwtSecret|secret_key|sk-[A-Za-z0-9]{20}/i)
  })

  test('data routes refuse an unauthenticated caller', async ({ request }) => {
    const res = await request.get(`${BASE}/api/v1/${PUBLIC_PROJECT}/db/orders`)
    expect([401, 403, 404]).toContain(res.status())
    const body = await res.text()
    expect(body).not.toMatch(/"data"\s*:\s*\[\s*\{/)
  })

  test('the users table is not reachable over the public API', async ({ request }) => {
    // The credential table. Denied at the database grant level AND by the
    // exposure gate; this asserts the outcome rather than either mechanism.
    const res = await request.get(`${BASE}/api/v1/${PUBLIC_PROJECT}/db/users`)
    expect(res.status()).not.toBe(200)
    const body = await res.text()
    expect(body).not.toMatch(/\$2[aby]\$\d{2}\$/) // bcrypt hash shape
    expect(body).not.toMatch(/"email"\s*:/)
  })

  test('an invalid api key is rejected, not ignored', async ({ request }) => {
    const res = await request.get(`${BASE}/api/v1/${PUBLIC_PROJECT}/db/orders`, {
      headers: { 'x-api-key': 'definitely-not-a-real-key' },
    })
    expect([401, 403, 404]).toContain(res.status())
  })
})

test.describe('tenant isolation', () => {
  test('a well-formed but unknown project id does not 500', async ({ request }) => {
    // Must be a clean 404. A 500 here means an unauthenticated caller can reach
    // code that assumed the project existed.
    const res = await request.get(`${BASE}/api/v1/00000000-0000-0000-0000-000000000000`)
    expect(res.status()).toBe(404)
  })

  test('a path-traversal shaped project id is rejected', async ({ request }) => {
    const res = await request.get(`${BASE}/api/v1/..%2F..%2Fetc%2Fpasswd`)
    expect(res.status()).not.toBe(200)
    expect(await res.text()).not.toMatch(/root:/)
  })
})

test.describe('exposure', () => {
  test('PostgREST is not reachable from the public internet', async ({ request }) => {
    // It selects the tenant schema from a request header, so direct reachability
    // would let any client choose its own schema. It binds to loopback; this
    // asserts that from the outside.
    const res = await request.get(`${BASE}:3002/`, { failOnStatusCode: false }).catch(() => null)
    if (res) expect(res.status()).not.toBe(200)
  })

  test('no environment values are embedded in the served HTML', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const html = await page.content()
    expect(html).not.toMatch(/sk-(proj|ant)-[A-Za-z0-9_-]{20}/)
    expect(html).not.toMatch(/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/)
    expect(html).not.toMatch(/JWT_SECRET|PADDLE_API_KEY|CRON_SECRET/)
  })

  test('the dashboard is not served to an anonymous visitor', async ({ page }) => {
    const res = await page.goto(`${BASE}/app/projects`, { waitUntil: 'domcontentloaded' })
    // Either redirected to auth, or refused — but never rendered with content.
    const url = page.url()
    const status = res?.status() ?? 0
    const redirectedToAuth = /login|signin|auth/i.test(url)
    expect(redirectedToAuth || status >= 400).toBe(true)
  })
})
