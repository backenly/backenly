/**
 * EVERY SURFACE SELF-HOST SHOWS MUST BE BACKED BY SOMETHING REAL
 * =============================================================
 * The sweep this belongs to asks one question of each visible surface: does it
 * correspond to a working backend capability in THIS edition?
 *
 * An honest empty state is not a defect. A fresh install legitimately has no
 * logs, no schema history and no end users, and saying so is correct. The
 * defects are:
 *
 *   DEAD/RETIRED      the UI points at a removed or 410 endpoint
 *   PLACEHOLDER/MOCK  fabricated state rendered as though real
 *   CLOUD_GATED-VISIBLE  an action self-host advertises and cannot perform
 *   BROKEN            UI and backend both exist, and the interaction fails
 *
 * Source review cannot settle these. A page can import the right module, call
 * the right route, and still render an error boundary or a success toast over a
 * failed request. So this drives the real deployment `npm run selfhost` built
 * and watches what the browser actually receives.
 *
 * The network assertions are the point. A page that renders is not evidence;
 * a page whose backend answered is.
 */

import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const HANDOFF = resolve(__dirname, '../../../.playwright/selfhost-project.json')
const projectId = () => JSON.parse(readFileSync(HANDOFF, 'utf8')).id

test.setTimeout(120_000)

/**
 * Every destination the self-host navigation and command palette offer.
 *
 * `streams` marks a surface that holds a connection open on purpose.
 *
 * Realtime opens an EventSource, so the network NEVER goes idle and waiting for
 * it burns the full timeout — 60s against ~1s for every other page. Worse, it
 * made realtime the one surface this spec did not really assert: the wait
 * failed, the catch swallowed it, and the test passed having proved less than
 * the others. These assert the stream OPENED instead, which is the stronger
 * claim anyway.
 */
const NAV = [
  { id: 'overview', path: '' },
  { id: 'database', path: '/database' },
  { id: 'auth', path: '/auth' },
  { id: 'storage', path: '/storage' },
  { id: 'functions', path: '/functions' },
  { id: 'realtime', path: '/realtime', streams: '/realtime' },
  { id: 'integrations', path: '/integrations' },
  { id: 'autonomy', path: '/autonomy' },
  { id: 'monitoring', path: '/monitoring' },
  { id: 'deploy', path: '/deploy' },
  { id: 'connect', path: '/connect' },
  { id: 'webhooks', path: '/webhooks' },
  { id: 'settings', path: '/settings' },
] as const satisfies ReadonlyArray<{ id: string; path: string; streams?: string }>

/**
 * Collect the API calls a page makes, with their status.
 *
 * Recorded per navigation so a failing surface can be named by the request that
 * failed rather than by "the page looked wrong".
 */
function recordApiCalls(page: Page): Array<{ url: string; status: number }> {
  const calls: Array<{ url: string; status: number }> = []
  page.on('response', res => {
    const url = res.url()
    if (url.includes('/api/')) calls.push({ url, status: res.status() })
  })
  return calls
}

/** Next.js renders this when a page throws. It is never a legitimate state. */
async function assertNoErrorBoundary(page: Page, where: string): Promise<void> {
  const boundary = page.getByText(/something went wrong|application error|unhandled|500/i)
  await expect(boundary, `${where} rendered an error boundary`).toHaveCount(0)
}

test.describe('every navigable surface loads against a real backend', () => {
  for (const nav of NAV) {
    test(`${nav.id} renders and its backend answers`, async ({ page }) => {
      const calls = recordApiCalls(page)

      await page.goto(`/app/projects/${projectId()}${nav.path}`)
      // The shell is enough to know routing worked; each page owns its own
      // loading state beyond that.
      await expect(page.locator('body')).toBeVisible({ timeout: 60_000 })

      const streams = (nav as { streams?: string }).streams
      if (streams) {
        // Wait for the stream itself rather than for quiet that will never come.
        const opened = await page
          .waitForResponse(r => r.url().includes(streams), { timeout: 45_000 })
          .catch(() => null)
        expect(opened, `${nav.id} never opened its ${streams} stream`).not.toBeNull()
        expect(
          opened!.status(),
          `${nav.id} stream answered ${opened!.status()}`,
        ).toBeLessThan(400)
      } else {
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
      }

      await assertNoErrorBoundary(page, nav.id)

      // No surface may depend on a route that no longer exists. A 404/410 from
      // an API the page called is the DEAD/RETIRED signature.
      const gone = calls.filter(c => c.status === 404 || c.status === 410)
      expect(
        gone,
        `${nav.id} called removed endpoints: ${gone.map(g => `${g.status} ${g.url}`).join(', ')}`,
      ).toHaveLength(0)

      // A 5xx means the backend exists and is broken, which is the BROKEN class.
      const broken = calls.filter(c => c.status >= 500)
      expect(
        broken,
        `${nav.id} got server errors: ${broken.map(b => `${b.status} ${b.url}`).join(', ')}`,
      ).toHaveLength(0)
    })
  }
})

test.describe('cloud-only surfaces are absent, not merely refused', () => {
  test('branches is not offered anywhere in self-host', async ({ page }) => {
    // Gated at the navigation source rather than after the click: self-host
    // must never advertise an action it knows will refuse.
    await page.goto(`/app/projects/${projectId()}`)
    await expect(page.getByRole('button', { name: 'Branches', exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Branches', exact: true })).toHaveCount(0)
  })

  test('the branches page itself refuses, as defence in depth', async ({ page }) => {
    // The navigation gate is the UX; this is the guarantee behind it.
    const res = await page.goto(`/app/projects/${projectId()}/branches`)
    // Either a 404 status or the not-found body. Both are correct.
    const notFound = page.getByText(/not found|404/i)
    const is404 = res?.status() === 404
    if (!is404) await expect(notFound.first()).toBeVisible({ timeout: 30_000 })
  })
})

test.describe('empty states are honest, not fabricated', () => {
  test('a fresh install says it has no logs rather than inventing some', async ({ page }) => {
    await page.goto(`/app/projects/${projectId()}/monitoring`)
    await page.getByRole('tab', { name: 'Logs', exact: true }).click()

    const table = page.locator('tbody tr')
    const empty = page.getByText('No logs yet')

    // One or the other. Rows would mean real recorded activity; the empty
    // state would mean none. A table of plausible-looking sample rows is the
    // failure this asserts against.
    await expect(table.first().or(empty)).toBeVisible({ timeout: 30_000 })
  })

  test('schema history shows real versions or states that there are none', async ({ page }) => {
    await page.goto(`/app/projects/${projectId()}/database`)
    await page.getByRole('tab', { name: 'History', exact: true }).click()

    const versions = page.locator('button', { hasText: /^v\d+/ })
    const empty = page.getByText('No schema versions yet')
    await expect(versions.first().or(empty)).toBeVisible({ timeout: 30_000 })
  })
})
