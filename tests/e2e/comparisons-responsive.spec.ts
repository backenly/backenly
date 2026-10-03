/**
 * Comparisons and Alternatives at the five widths the site commits to.
 *
 * 1440 and 1728 matter for a specific reason: commit 65374cec widened subpage
 * containers at 2xl so a 1280 column would stop reading as mis-set under a
 * 1600px navbar. The risk that introduces is the opposite one — long-form prose
 * stretching to a line length nobody can track back from. So these widths check
 * both directions: nothing overflows, and nothing over-stretches.
 *
 * 375 is where the capability table would otherwise fail. Four columns of
 * sentence-length prose on a phone is either a horizontal scroll nobody finds
 * or columns too narrow to read, which is why the table has a stacked rendering
 * below md and why the assertion here is that the page body never scrolls
 * sideways.
 *
 * Run against a running app:
 *   npx playwright test tests/e2e/comparisons-responsive.spec.ts
 */

import { test, expect, type Page } from '@playwright/test'

/**
 * Above the 30s default. A dev server compiles each route on its first hit, and
 * with parallel workers several of those land at once, so the first navigation
 * to a route can take far longer than the page itself ever will. Against a
 * built server every test here finishes in a second or two.
 */
test.describe.configure({ timeout: 90_000 })

const WIDTHS = [375, 768, 1280, 1440, 1728] as const

const ROUTES = [
  '/comparisons',
  '/comparisons/backenly-vs-supabase',
  '/comparisons/backenly-vs-firebase',
  '/comparisons/backenly-vs-no-code-builders',
  '/comparisons/backenly-vs-traditional-backend-development',
  '/alternatives',
] as const

/**
 * Navigate and wait for the page to actually be there.
 *
 * Deliberately not `waitUntil: 'networkidle'`. Against a Next dev server that
 * never fires reliably — HMR keeps a socket open and routes compile lazily on
 * first hit — so a run fails on `page.goto` timeouts, on a different set of
 * routes each time, and the failures read like layout bugs rather than
 * navigation ones. Waiting for the h1 is the condition the assertions actually
 * depend on.
 */
async function open(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 60_000 })
}

/** Widest rendered paragraph, in CSS pixels. */
async function widestParagraph(page: Page): Promise<number> {
  return page.evaluate(() => {
    let widest = 0
    for (const p of Array.from(document.querySelectorAll('main p, main li, main dd'))) {
      const { width } = p.getBoundingClientRect()
      if (width > widest) widest = width
    }
    return widest
  })
}

for (const route of ROUTES) {
  test.describe(route, () => {
    for (const width of WIDTHS) {
      test(`${width}px: no horizontal overflow`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await open(page, route)

        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        // One pixel of slack for sub-pixel rounding on fractional viewports.
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
      })
    }

    test('has exactly one h1', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await open(page, route)
      await expect(page.locator('main h1')).toHaveCount(1)
    })

    test('heading levels never skip', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await open(page, route)

      const levels = await page.evaluate(() =>
        Array.from(document.querySelectorAll('main h1, main h2, main h3, main h4')).map((h) =>
          Number(h.tagName[1]),
        ),
      )
      expect(levels[0]).toBe(1)
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1)
      }
    })

    test('prose stays readable at 1728', async ({ page }) => {
      await page.setViewportSize({ width: 1728, height: 900 })
      await open(page, route)
      // max-w-3xl is 768px. Cards and table cells are narrower still. Anything
      // materially past this is a section that picked the wrong container.
      expect(await widestParagraph(page)).toBeLessThanOrEqual(820)
    })
  })
}

test.describe('the capability table', () => {
  const route = '/comparisons/backenly-vs-supabase'

  test('scroll region is reachable by keyboard on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await open(page, route)

    const region = page.getByRole('region', { name: /compared with Supabase/i })
    await expect(region).toBeVisible()
    await region.focus()
    await expect(region).toBeFocused()
  })

  test('stacks below md, with the table itself hidden', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 })
    await open(page, route)

    await expect(page.locator('main table')).toBeHidden()
    // The same rows are still present, as a definition list.
    await expect(page.locator('main dl dt').first()).toBeVisible()
  })

  test('is a real table with header semantics on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await open(page, route)

    await expect(page.locator('main table caption')).toHaveCount(1)
    expect(await page.locator('main table th[scope="col"]').count()).toBe(4)
    expect(await page.locator('main table th[scope="row"]').count()).toBeGreaterThan(4)
  })
})
