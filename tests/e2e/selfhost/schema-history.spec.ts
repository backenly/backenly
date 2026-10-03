/**
 * SCHEMA HISTORY, THROUGH A BROWSER
 * =================================
 * The ledger was being written for as long as it has existed and nothing read
 * it. What matters in the page is the destructive path: rollback drops whatever
 * was added after the target version, and dropping a column drops its data.
 *
 * So these assert that the confirmation cannot be cleared by reflex — the
 * version number has to be typed — and that the empty and loaded states are
 * both real rather than a blank pane.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const HANDOFF = resolve(__dirname, '../../../.playwright/selfhost-project.json')
const projectId = () => JSON.parse(readFileSync(HANDOFF, 'utf8')).id

test.setTimeout(90_000)

test.beforeEach(async ({ page }) => {
  await page.goto(`/app/projects/${projectId()}/database`)
  const tab = page.getByRole('tab', { name: 'History', exact: true })
  await expect(tab).toBeVisible({ timeout: 60_000 })
  await tab.click()
  await expect(page.getByText('Schema history')).toBeVisible({ timeout: 30_000 })
})

test('shows either versions or a stated empty state, never a blank pane', async ({ page }) => {
  const empty = page.getByText('No schema versions yet')
  const rows = page.locator('button', { hasText: /^v\d+/ })
  await expect(empty.or(rows.first())).toBeVisible({ timeout: 30_000 })
})

test('asks which version to inspect before showing a snapshot', async ({ page }) => {
  // The right-hand pane must say what it wants rather than sitting empty.
  const prompt = page.getByText('Select a version to see the schema it captured.')
  const empty = page.getByText('No schema versions yet')
  await expect(prompt.or(empty)).toBeVisible({ timeout: 30_000 })
})

test('rollback needs the version number typed, not just a click', async ({ page }) => {
  const rows = page.locator('button', { hasText: /^v\d+/ })
  const count = await rows.count()
  // A deployment with no schema changes has nothing to roll back to. Skipping
  // says so instead of passing quietly.
  test.skip(count === 0, 'this deployment has recorded no schema versions')

  await rows.first().click()
  await page.getByRole('button', { name: /roll back to this/i }).click()

  const confirm = page.getByRole('button', { name: 'Roll back', exact: true })
  await expect(confirm).toBeVisible()
  // Disabled until the number is typed: a modal with a single live Confirm is
  // dismissed by reflex, which is the wrong reflex for dropping columns.
  await expect(confirm).toBeDisabled()

  const field = page.getByLabel('Type the version number to confirm')
  await field.fill('999999')
  await expect(confirm).toBeDisabled()

  // The warning says what will be lost, in those words.
  await expect(page.getByText(/dropping a\s+column drops its data/i)).toBeVisible()

  await page.getByRole('button', { name: /cancel/i }).click()
  await expect(confirm).toHaveCount(0)
})
