/**
 * THE LOGS EXPLORER, THROUGH A BROWSER
 * ====================================
 * `/api/logs` had eight filters and paging and nothing called it. The tab is
 * the surface, so the things worth asserting are properties of the page: that
 * it is reachable, that it renders one of its states rather than a blank
 * region, and that a quiet deployment gets "no logs yet" rather than the
 * workbench's "nothing to watch yet" — which was the real bug, because the
 * shared gate would have swallowed the whole tab on exactly the deployment a
 * fresh install produces.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const HANDOFF = resolve(__dirname, '../../../.playwright/selfhost-project.json')
const projectId = () => JSON.parse(readFileSync(HANDOFF, 'utf8')).id

test.beforeEach(async ({ page }) => {
  await page.goto(`/app/projects/${projectId()}/monitoring`)
})

test('logs is a tab on monitoring, not a page nobody links to', async ({ page }) => {
  const tab = page.getByRole('tab', { name: 'Logs', exact: true })
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await tab.click()

  // The filter bar is the part that exists in every state, including empty.
  await expect(page.getByLabel('Search logs')).toBeVisible()
  await expect(page.getByLabel('Filter by type')).toBeVisible()
  await expect(page.getByLabel('Filter by severity')).toBeVisible()
})

test('a fresh deployment shows the logs empty state, not the monitoring one', async ({ page }) => {
  // The regression that matters. The workbench returns "Nothing to watch yet"
  // when the backend is not live, and the logs tab has to be reached before
  // that gate — a deployment with no traffic still records system and auth
  // logs, and hiding the tab would hide them.
  await page.getByRole('tab', { name: 'Logs', exact: true }).click()

  await expect(page.getByText('Nothing to watch yet')).toHaveCount(0)

  // Either rows or one of the two empty states. All three are correct
  // outcomes; a blank panel is not.
  const table = page.locator('table')
  const emptyNoLogs = page.getByText('No logs yet')
  const emptyFiltered = page.getByText('No logs match these filters')
  await expect(table.or(emptyNoLogs).or(emptyFiltered).first()).toBeVisible({ timeout: 30_000 })
})

test('filtering to a severity with nothing in it offers a way back', async ({ page }) => {
  await page.getByRole('tab', { name: 'Logs', exact: true }).click()
  await expect(page.getByLabel('Filter by severity')).toBeVisible({ timeout: 30_000 })

  await page.getByLabel('Filter by severity').selectOption('debug')
  await page.getByLabel('Filter by type').selectOption('function')

  // "Nothing matches your filters" and "nothing exists" are different
  // situations needing different actions, and only the first can offer a
  // clear-filters button that means anything.
  const cleared = page.getByRole('button', { name: /clear/i })
  const rows = page.locator('tbody tr')
  const filteredEmpty = page.getByText('No logs match these filters')

  await expect(filteredEmpty.or(rows.first())).toBeVisible({ timeout: 30_000 })
  if (await filteredEmpty.isVisible()) {
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible()
  }
  await expect(cleared.first()).toBeVisible()
})

test('the tab survives a reload of the monitoring page', async ({ page }) => {
  // Guards against the tab depending on state only reachable by clicking
  // through from a warm page.
  await page.getByRole('tab', { name: 'Logs', exact: true }).click()
  await expect(page.getByLabel('Search logs')).toBeVisible({ timeout: 30_000 })

  await page.reload()
  await page.getByRole('tab', { name: 'Logs', exact: true }).click()
  await expect(page.getByLabel('Search logs')).toBeVisible({ timeout: 30_000 })
})
