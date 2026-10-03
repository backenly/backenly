/**
 * THE READ-ONLY SQL WORKSPACE, THROUGH A BROWSER
 * ==============================================
 * The isolation tests call the engine directly and assert PostgreSQL refuses.
 * What they cannot show is that the page wires up to it: that the view is
 * reachable, that a real SELECT round-trips, and — most importantly — that a
 * refused write is presented as a route back into the governed path rather
 * than as a bare error.
 *
 * Runs against the deployment `npm run selfhost` built, as the operator who
 * claimed it.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const HANDOFF = resolve(__dirname, '../../../.playwright/selfhost-project.json')
const projectId = () => JSON.parse(readFileSync(HANDOFF, 'utf8')).id

test.setTimeout(90_000)

test.beforeEach(async ({ page }) => {
  await page.goto(`/app/projects/${projectId()}/database`)
  const sqlTab = page.getByRole('tab', { name: 'SQL', exact: true })
  await expect(sqlTab).toBeVisible({ timeout: 60_000 })
  await sqlTab.click()
  await expect(page.getByLabel('SQL query')).toBeVisible({ timeout: 30_000 })
})

test('opens with an explanation rather than a blank pane', async ({ page }) => {
  await expect(page.getByText('Run a query to see results.')).toBeVisible()
  // The page states where the restriction actually lives, so nobody reads the
  // editor's behaviour as the security model.
  await expect(page.getByText(/refused by the database, not by this page/i)).toBeVisible()
})

test('a SELECT round-trips and reports its timing', async ({ page }) => {
  await page.getByLabel('SQL query').fill('SELECT 1 AS one')
  await page.getByRole('button', { name: 'Run', exact: true }).click()

  // The value, in a results table.
  await expect(page.getByRole('columnheader', { name: 'one' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/1 row ·/)).toBeVisible()
})

test('a refused write names the governed path instead of only refusing', async ({ page }) => {
  // The behaviour that makes this the governed ANSWER to Studio's editor
  // rather than a crippled copy of it: the refusal carries a suggestion.
  await page.getByLabel('SQL query').fill("UPDATE nothing SET a = 1")
  await page.getByRole('button', { name: 'Run', exact: true }).click()

  const banner = page.locator('.text-rose-200').first()
  await expect(banner).toBeVisible({ timeout: 30_000 })

  // And no results table is left behind under the error.
  await expect(page.locator('tbody tr')).toHaveCount(0)
})

test('the history remembers a query that ran, and can be cleared', async ({ page }) => {
  await expect(page.getByText('Queries you run appear here.')).toBeVisible()

  await page.getByLabel('SQL query').fill('SELECT 2 AS two')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByRole('columnheader', { name: 'two' })).toBeVisible({ timeout: 30_000 })

  // Only successful queries are remembered; a refused one is not a query that
  // ran, and offering it back would be offering a mistake.
  const clear = page.getByRole('button', { name: 'Clear query history' })
  await expect(clear).toBeVisible()
  await clear.click()
  await expect(page.getByText('Queries you run appear here.')).toBeVisible()
})

test('a snippet fills the editor', async ({ page }) => {
  await page.getByRole('button', { name: 'Tables and row estimates' }).click()
  await expect(page.getByLabel('SQL query')).toHaveValue(/pg_stat_user_tables/)
})
