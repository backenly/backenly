/**
 * WEBHOOKS, THROUGH A BROWSER
 * ===========================
 *
 * ── What this spec is and is not evidence for ───────────────────────────────
 *
 * It does NOT prove delivery. `tests/integration/webhook-delivery.spec.ts` owns
 * that: a real capture trigger, a real INSERT, a real drain, a real HTTP
 * receiver and an HMAC verified over the bytes that arrived. Repeating it here
 * over a loopback receiver would mean switching
 * `BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE` on in the installed deployment, which
 * would make the browser evidence come from a configuration no operator runs by
 * default.
 *
 * What it proves is that the SURFACE is real: that the form writes to the
 * database through the actual API, that the list reflects what was written,
 * that the secret is shown once and then genuinely unreadable, that a refused
 * destination surfaces the egress guard's real reason, and that an endpoint
 * which has never fired says so instead of rendering an invented history.
 *
 * That split matters because the defect being fixed here was precisely a
 * backend nothing called. A page that renders is not evidence; a page whose
 * backend answered, and whose writes survive a reload, is.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const HANDOFF = resolve(__dirname, '../../../.playwright/selfhost-project.json')
const projectId = () => JSON.parse(readFileSync(HANDOFF, 'utf8')).id

test.setTimeout(90_000)

/**
 * Serial, explicitly.
 *
 * These build on one another: one test creates the endpoint the next four
 * inspect, test and delete. The config sets `fullyParallel: true` and only
 * pins `workers: 1` under CI, so relying on declaration order would mean a
 * suite that passes in CI and races on a developer's machine — which is the
 * worst of both, because the failure appears where nobody is looking for it.
 */
test.describe.configure({ mode: 'serial' })

/** A destination the guard accepts as a literal, so create succeeds. */
const PUBLIC_TARGET = 'https://example.com/backenly-hook'

test.beforeEach(async ({ page }) => {
  await page.goto(`/app/projects/${projectId()}/webhooks`)
  await expect(page.getByRole('heading', { name: 'Webhooks', exact: true, level: 1 })).toBeVisible({ timeout: 60_000 })
})

test('the page is reachable from the sidebar, not only by URL', async ({ page }) => {
  await page.goto(`/app/projects/${projectId()}`)
  // A real link in the sidebar, so it can be opened in a new tab as well.
  const link = page.getByRole('link', { name: 'Webhooks', exact: true })
  await expect(link).toBeVisible({ timeout: 60_000 })
  await link.click()
  await expect(page).toHaveURL(/\/webhooks$/, { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'Webhooks', exact: true, level: 1 })).toBeVisible({ timeout: 30_000 })
})

test('an endpoint created in the form survives a reload, and its secret does not', async ({ page }) => {
  const created = page.waitForResponse(
    r => r.url().includes('/webhooks') && r.request().method() === 'POST',
  )

  await page.getByRole('button', { name: /add endpoint/i }).first().click()
  await page.getByPlaceholder('https://example.com/hooks/backenly').fill(PUBLIC_TARGET)
  await page.getByRole('button', { name: 'Save endpoint', exact: true }).click()

  // The API actually answered, and answered 201. A toast is not evidence.
  const res = await created
  expect(res.status(), 'create did not return 201').toBe(201)

  // Shown exactly once, at creation.
  //
  // Located by ROLE, not by text. `getByText('Signing secret')` also matched
  // the prose below the list that explains how to verify a delivery, and
  // Playwright's strict mode correctly refused an ambiguous locator. A test
  // that says "the dialog appeared" must not be satisfiable by a paragraph
  // that merely mentions it.
  const dialog = page.getByRole('dialog')
  await expect(page.getByRole('heading', { name: 'Signing secret' })).toBeVisible({ timeout: 30_000 })

  const secret = (await dialog.locator('code').first().innerText()).trim()
  expect(secret, 'the creation response carried no secret').toMatch(/^[0-9a-f]{64}$/)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()

  await expect(page.getByText(PUBLIC_TARGET).first()).toBeVisible({ timeout: 30_000 })

  // The write reached the database rather than only the component's state.
  await page.reload()
  await expect(page.getByText(PUBLIC_TARGET).first()).toBeVisible({ timeout: 60_000 })

  // And the secret is now genuinely unreadable — not merely hidden behind a
  // toggle. Asserting on the page text is the weak half; the strong half is
  // that no route returns it, which the integration suite pins.
  await expect(page.locator('body')).not.toContainText(secret)
})

const REFUSED_TARGET = 'http://169.254.169.254/latest/meta-data/'

test('a refused destination reports the guard’s real reason, and writes nothing', async ({ page }) => {
  // Wait for the list to have LOADED before measuring it.
  //
  // The first version counted immediately after the shell appeared, which is
  // before the endpoint list has fetched. It read 0, the reload read 1, and the
  // test failed having found nothing wrong with the product. It passed the run
  // it was written in purely on timing, which is the definition of the flake
  // this program refuses to retry away.
  await expect(page.getByText(PUBLIC_TARGET).first()).toBeVisible({ timeout: 60_000 })
  const before = await page.getByText(PUBLIC_TARGET).count()

  await page.getByRole('button', { name: /add endpoint/i }).first().click()
  await page.getByPlaceholder('https://example.com/hooks/backenly').fill(REFUSED_TARGET)

  const refused = page.waitForResponse(
    r => r.url().includes('/webhooks') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Save endpoint', exact: true }).click()

  const res = await refused
  expect(res.status(), 'a link-local destination was not refused').toBe(400)

  // The operator is told WHY, in the dialog they are looking at. "Invalid URL"
  // over a metadata address would send them to check their typing.
  await expect(
    page.getByRole('dialog').getByText(/link-local|metadata|refus/i).first(),
  ).toBeVisible({ timeout: 15_000 })

  // The dialog stays open on failure rather than closing over a silent no-op,
  // and nothing was added to the list.
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByText(PUBLIC_TARGET).first()).toBeVisible({ timeout: 60_000 })

  // The direct claim, and the one that does not depend on a count: the refused
  // address is nowhere in the list. A count comparison alone would also pass if
  // the refusal had somehow replaced an existing row rather than adding one.
  await expect(page.getByText(REFUSED_TARGET)).toHaveCount(0)
  expect(await page.getByText(PUBLIC_TARGET).count()).toBe(before)
})

test('an endpoint that has never fired says so, rather than showing invented history', async ({ page }) => {
  const row = page.getByText(PUBLIC_TARGET).first()
  await expect(row).toBeVisible({ timeout: 30_000 })

  const logs = page.waitForResponse(r => r.url().includes('/logs'))
  await row.click()
  const res = await logs
  expect(res.status(), 'the delivery history endpoint did not answer').toBe(200)

  // Honest empty state. The alternative — a seeded "delivered 2 minutes ago" —
  // is the PLACEHOLDER/MOCK class the surface sweep exists to find.
  await expect(page.getByText('No deliveries recorded. This endpoint has not fired yet.')).toBeVisible({
    timeout: 30_000,
  })
})

test('the test button performs a real delivery attempt and reports its real outcome', async ({ page }) => {
  await expect(page.getByText(PUBLIC_TARGET).first()).toBeVisible({ timeout: 30_000 })

  const attempted = page.waitForResponse(
    r => r.url().includes('/test') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Send test', exact: true }).first().click()

  const res = await attempted
  expect(res.status(), 'the test route did not answer').toBe(200)
  const body = await res.json()

  // Either outcome is legitimate here — example.com does not accept POSTs, and
  // a CI runner may have no egress at all. What must be true is that the answer
  // DESCRIBES A RESULT rather than acknowledging a dispatch: on failure it
  // names a status code or an error, and never reports success without one.
  expect(body).toHaveProperty('logId')
  if (body.success) {
    expect(body.statusCode).toBeGreaterThanOrEqual(200)
    expect(body.statusCode).toBeLessThan(300)
  } else {
    expect(body.statusCode ?? body.error, 'a failure with neither status nor reason').toBeTruthy()
  }

  // And the attempt is now in the durable history, because a test delivery is a
  // real delivery.
  await page.reload()
  await page.getByText(PUBLIC_TARGET).first().click()
  await expect(
    page.getByText('No deliveries recorded. This endpoint has not fired yet.'),
  ).toHaveCount(0, { timeout: 30_000 })
})

test('deleting an endpoint asks first, and then actually removes it', async ({ page }) => {
  await expect(page.getByText(PUBLIC_TARGET).first()).toBeVisible({ timeout: 30_000 })

  // Delete lives in the row's overflow menu, beside the other rare actions.
  await page.getByRole('button', { name: `More actions for ${PUBLIC_TARGET}` }).first().click()
  await page.getByRole('menuitem', { name: 'Delete endpoint…' }).click()

  // Named, not a bare "are you sure?" — the dialog says what stops and what is
  // lost with it.
  const confirm = page.getByRole('dialog')
  await expect(confirm.getByText(/stops receiving events immediately/i)).toBeVisible({
    timeout: 15_000,
  })

  const removed = page.waitForResponse(
    r => r.url().includes('/webhooks/') && r.request().method() === 'DELETE',
  )
  // Scoped to the dialog rather than picking the last matching button on the
  // page, so a future row added below cannot silently retarget the click.
  await confirm.getByRole('button', { name: 'Delete endpoint', exact: true }).click()
  const res = await removed
  expect(res.status(), 'delete did not succeed').toBe(200)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Webhooks', exact: true, level: 1 })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(PUBLIC_TARGET)).toHaveCount(0, { timeout: 30_000 })
})
