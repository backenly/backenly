/**
 * RESTORING A CHANGE, THROUGH A BROWSER
 * =====================================
 * Every change to production is checked after it applies, and the way back is
 * one menu item on its row in History. What matters here is the path
 * a person actually takes, end to end against the deployment:
 *
 *   a change made in the dashboard shows up as applied and verified;
 *   "Restore previous state" is in the row's ⋯ menu, not a page of its own;
 *   the dialog shows four plain checks and one button, with no SQL and nothing
 *     to type;
 *   the result is verified and the row says Restored;
 *   the technical detail is there, behind View details, and not before.
 *
 * And History is one section for the whole backend, in the sidebar; the
 * Database page no longer keeps a list of its own, and its old link lands here.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const HANDOFF = resolve(__dirname, '../../../.playwright/selfhost-project.json')
const projectId = () => JSON.parse(readFileSync(HANDOFF, 'utf8')).id

test.setTimeout(120_000)

test('a dashboard change is restored from its row, with four checks and nothing to type', async ({ page, request }) => {
  const table = `e2e_restore_${Date.now().toString(36)}`
  const made = await request.post(`/api/database/create-table?projectId=${projectId()}`, {
    data: { tableName: table, columns: [{ name: 'title', type: 'text' }] },
  })
  expect(made.ok(), `create-table failed (${made.status()}): ${await made.text()}`).toBe(true)

  await page.goto(`/app/projects/${projectId()}/changes`)
  const row = page.getByRole('button', { name: new RegExp(`Created table ${table}`) }).first()
  await expect(row).toBeVisible({ timeout: 60_000 })
  await expect(row).toHaveAccessibleName(/Applied · Verified/)
  const seq = (await row.getAttribute('aria-label'))!.match(/#(\d+)/)![1]

  await page.getByRole('button', { name: `Actions for change #${seq}` }).click()
  await page.getByRole('menuitem', { name: 'Restore previous state' }).click()

  const dialog = page.getByRole('dialog')
  for (const check of ['Restore point available', 'Current state protected', 'Recovery plan verified', 'No expected data loss']) {
    await expect(dialog.getByText(check, { exact: true })).toBeVisible({ timeout: 60_000 })
  }
  // Nothing to type, no SQL, no rehearsal language in the main flow.
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await expect(dialog.getByText(/CREATE TABLE|DROP TABLE|ALTER TABLE/)).toHaveCount(0)
  await expect(dialog.getByText(/rehears/i)).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Restore previous state', exact: true }).click()
  await expect(dialog.getByText(`The state before #${seq} is back, and verified.`)).toBeVisible({ timeout: 60_000 })
  await dialog.getByRole('button', { name: 'Done' }).click()

  await expect(page.getByRole('button', { name: new RegExp(`Change #${seq}:.*Restored`) })).toBeVisible({ timeout: 30_000 })

  // The ledger agrees with what the page said.
  const listed = await request.get(`/api/projects/${projectId()}/changes`)
  expect(listed.ok()).toBe(true)
  const { changes } = await listed.json()
  const original = changes.find((c: any) => c.seq === Number(seq))
  expect(original).toMatchObject({ status: 'restored', outcome: { state: 'restored' } })
  // The restore is recorded, but as how the change ended, not as a row of its own.
  expect(changes.filter((c: any) => /Restored the state before/.test(c.summary))).toHaveLength(0)
})

test('technical detail is behind View details, and the SQL behind one more click', async ({ page, request }) => {
  const table = `e2e_details_${Date.now().toString(36)}`
  const made = await request.post(`/api/database/create-table?projectId=${projectId()}`, {
    data: { tableName: table, columns: [{ name: 'title', type: 'text' }] },
  })
  expect(made.ok()).toBe(true)

  await page.goto(`/app/projects/${projectId()}/changes`)
  const row = page.getByRole('button', { name: new RegExp(`Created table ${table}`) }).first()
  await expect(row).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('CREATE TABLE')).toHaveCount(0)

  await row.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('What changed')).toBeVisible({ timeout: 30_000 })
  await expect(dialog.getByText('Checks')).toBeVisible()
  await expect(dialog.getByText('Timeline')).toBeVisible()
  await expect(dialog.getByText('CREATE TABLE')).toHaveCount(0)
  await dialog.getByRole('button', { name: /statement/ }).click()
  await expect(dialog.getByText(/CREATE TABLE/)).toBeVisible()
})

test('History is one section for the whole backend, and the old Database link lands there', async ({ page }) => {
  await page.goto(`/app/projects/${projectId()}/database?view=changes`)
  await expect(page).toHaveURL(/\/changes(\?|$)/, { timeout: 60_000 })
  const empty = page.getByText('No changes yet')
  const rows = page.getByRole('button', { name: /^Change #\d+:/ })
  await expect(empty.or(rows.first())).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('link', { name: 'History', exact: true })).toBeVisible()
  await page.goto(`/app/projects/${projectId()}/database`)
  await expect(page.getByRole('tab', { name: 'Tables', exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('tab', { name: 'Changes', exact: true })).toHaveCount(0)
})

test('on a phone the list fits the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/app/projects/${projectId()}/changes`)
  const empty = page.getByText('No changes yet')
  const rows = page.getByRole('button', { name: /^Change #\d+:/ })
  await expect(empty.or(rows.first())).toBeVisible({ timeout: 60_000 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
