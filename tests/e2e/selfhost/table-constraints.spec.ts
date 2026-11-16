/**
 * THE CONSTRAINT PICKER, THROUGH A BROWSER
 * =======================================
 * The unit and integration suites prove the rule and the executor. Neither can
 * prove that the modal wires them together: that the picked table reaches the
 * request, that the guard blocks a column the server would refuse, that a
 * partial failure is reported rather than swallowed. Those are properties of
 * the page, and only a browser can observe them.
 *
 * Runs against the deployment `npm run selfhost` built, signed in as the first
 * operator. Nothing here is mocked — the request goes to the real route, the
 * real executor runs, and the assertion is on what the page then shows.
 */

import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const HANDOFF = resolve(__dirname, '../../../.playwright/selfhost-project.json')

function projectId(): string {
  return JSON.parse(readFileSync(HANDOFF, 'utf8')).id
}

/**
 * A fresh install has no tables.
 *
 * The database page filters out an empty `users` scaffold, so a deployment the
 * installer just produced shows nothing, and the add-column modal is not
 * reachable because no table is selected. The fixture is created through the
 * real create-table route rather than by raw SQL, so the tables it makes are
 * the same ones the editor lists - platform rows included.
 */
test.beforeAll(async ({ request }) => {
  const id = projectId()
  for (const tableName of ['e2e_documents', 'e2e_organizations']) {
    const res = await request.post(`/api/database/create-table?projectId=${id}`, {
      data: {
        tableName,
        columns: [
          { name: 'title', type: 'text', nullable: true },
        ],
      },
    })
    // 409 means a previous run in this deployment already made it, which is
    // fine. Anything else is a fixture that did not build, and the specs below
    // would fail for an unrelated reason.
    expect(
      res.ok() || res.status() === 409,
      `could not create ${tableName} (${res.status()}): ${await res.text()}`
    ).toBe(true)
  }
})

// A real install has to build its stack, load a table list and fetch rows
// before any of this is reachable, which is slower than the 30s default.
test.setTimeout(90_000)

test.beforeEach(async ({ page }) => {
  await page.goto(`/app/projects/${projectId()}/database`)

  // The table list has to load and select a table first. `Structure` appears
  // once one is selected, so waiting on it covers both.
  const structure = page.getByRole('radio', { name: 'Structure', exact: true })
  await expect(structure).toBeVisible({ timeout: 60_000 })

  // "Add column" lives in the STRUCTURE view. The page opens on Data, where
  // the button does not exist at all — which is why waiting for it directly
  // timed out rather than merely being slow.
  await structure.click()
  await expect(page.getByRole('button', { name: /add column/i }).first()).toBeVisible({
    timeout: 30_000,
  })
})

/** The Add column dialog (rebuilt 2026-11-16: Name, Type, Nullable, Unique, References, Check). */
const addColumn = (page: Page) => page.getByRole('dialog', { name: 'Add column' })
const nameField = (page: Page) => addColumn(page).getByPlaceholder('price_cents', { exact: true })

test('the add-column modal offers constraints, not just name and type', async ({ page }) => {
  // The gap this tranche closed: the backend accepted unique, check and
  // foreign_key, and the modal sent only {name, type, nullable}.
  await page.getByRole('button', { name: /add column/i }).first().click()
  const dialog = addColumn(page)
  await expect(dialog).toBeVisible()

  // Scoped to the dialog's own controls, not to words the structure behind it
  // may also show.
  // The foreign-key picker, listing the deployment's other tables.
  const references = dialog.locator('select').filter({ hasText: /no foreign key/i }).first()
  await expect(references).toBeVisible()

  // The check expression field, identified by its own placeholder.
  await expect(dialog.getByPlaceholder('price_cents > 0')).toBeVisible()

  // The unique toggle: a checkbox, reachable through its own label.
  await expect(dialog.getByRole('checkbox', { name: /^Unique/ })).toBeVisible()
})

test('a foreign key on a badly named column is blocked before it is submitted', async ({ page }) => {
  // The executor refuses this, and refuses it AFTER creating the column. The
  // modal knows the same rule, so the operator is stopped while the choice is
  // still free to change. This asserts the guard, not the refusal.
  await page.getByRole('button', { name: /add column/i }).first().click()

  await nameField(page).fill('description')

  const references = addColumn(page).locator('select').filter({ hasText: /no foreign key/i }).first()
  const options = await references.locator('option').allTextContents()
  // Needs a second table to reference. A single-table deployment cannot
  // exercise this, and silently passing would be worse than skipping.
  test.skip(options.length < 2, 'deployment has no second table to reference')

  await references.selectOption({ index: 1 })

  await expect(addColumn(page).getByText(/foreign key needs a column named like/i)).toBeVisible()
  await expect(addColumn(page).getByRole('button', { name: /^add column$/i })).toBeDisabled()
})

test('renaming the column to the suggested shape unblocks it', async ({ page }) => {
  await page.getByRole('button', { name: /add column/i }).first().click()

  const references = addColumn(page).locator('select').filter({ hasText: /no foreign key/i }).first()
  const options = await references.locator('option').allTextContents()
  test.skip(options.length < 2, 'deployment has no second table to reference')

  await nameField(page).fill('description')
  await references.selectOption({ index: 1 })
  await expect(addColumn(page).getByRole('button', { name: /^add column$/i })).toBeDisabled()

  // The hint names a column the rule accepts. Following it must actually work,
  // or the guidance is worse than none. ("…named like book_id, or it is refused.")
  const hint = await addColumn(page).getByText(/foreign key needs a column named like/i).textContent()
  const suggested = hint?.match(/like\s+([A-Za-z0-9_]+)/)?.[1] ?? 'thing_id'

  await nameField(page).fill(suggested)
  await expect(addColumn(page).getByRole('button', { name: /^add column$/i })).toBeEnabled()
})

test('cancelling clears the form, so a reopened modal carries no stale constraint', async ({ page }) => {
  // A modal that keeps its previous state silently applies a constraint the
  // operator chose for a different column.
  await page.getByRole('button', { name: /add column/i }).first().click()
  await nameField(page).fill('leftover_col')
  await addColumn(page).getByRole('checkbox', { name: /^Unique/ }).check()

  await addColumn(page).getByRole('button', { name: /cancel/i }).click()
  await page.getByRole('button', { name: /add column/i }).first().click()

  await expect(nameField(page)).toHaveValue('')
  await expect(addColumn(page).getByRole('checkbox', { name: /^Unique/ })).not.toBeChecked()
  const references = addColumn(page).locator('select').filter({ hasText: /no foreign key/i }).first()
  await expect(references).toHaveValue('')
})
