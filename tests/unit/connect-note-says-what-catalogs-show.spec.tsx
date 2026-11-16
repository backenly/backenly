/**
 * @jest-environment jsdom
 */

/**
 * The note on Connect → Postgres says what a database login can see of other
 * projects. Production QA (2026-11-09, report 90): it said catalogs "can list
 * other projects' schema names". On Backenly Cloud a region's projects share one
 * PostgreSQL database, and PostgreSQL lets every login read that database's
 * catalogs, which hold far more than schema names: table and column names,
 * defaults, constraints, policies, view definitions, function code and row
 * counts. The note now lists them and says what to keep out of them. A
 * self-hosted deployment has one project, so there is no note there, only the
 * line that each login reaches this project's schema.
 *
 * Since 2026-11-16 it is one warning note titled "Other projects can see your
 * table definitions", shown to everyone (it is about what people write), while
 * the logins are shown to owners and admins.
 */

import { act, render, screen } from '@testing-library/react'

let mockCloud = true
jest.mock('@cloud/control-plane', () => ({
  get CLOUD_CONTROL_PLANE() {
    return mockCloud
  },
}))
import { DirectDatabasePanel } from '@/components/connect/DirectDatabasePanel'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'

const STATUS = { schema: 'workspace_p1', credentials: [], pendingDriftEvents: 0 }
const OWNER = { success: true, data: { id: 'p1', name: 'shop', region: null, role: 'OWNER', canWrite: true, canAdminister: true } }

beforeEach(() => {
  forgetProjectReads()
  clearProjectRoleCache()
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const body = String(input).split('?')[0] === '/api/projects/p1' ? OWNER : STATUS
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
})

async function renderPanel() {
  render(<DirectDatabasePanel projectId="p1" />)
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
}

const TITLE = 'Other projects can see your table definitions'

/** The note's words as a reader sees them: the source's line breaks are single spaces. */
function noteText(): string {
  const note = screen.getByText(TITLE).parentElement
  return (note?.textContent ?? '').replace(/\s+/g, ' ')
}

/** Everything the panel says. */
const pageText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

it('on Backenly Cloud, lists what the shared catalogs show and what to keep out of them', async () => {
  mockCloud = true
  await renderPanel()
  const text = noteText()
  expect(text).toContain(
    "Every project in Mumbai, from every account, shares one Postgres database, and any project's login can read its catalogs.",
  )
  expect(text).toContain(
    "They show every project's ID, the names and definitions of its tables, columns, constraints, policies, views and functions, and its row counts, yours included.",
  )
  expect(text).toContain('They show no row data.')
  expect(text).toContain('Keep secrets out of names, comments, defaults, policies, views and function code.')
})

it('no longer says catalogs list schema names only', async () => {
  mockCloud = true
  await renderPanel()
  expect(noteText()).not.toMatch(/schema names, never their data/)
})

it('self-hosted, where the database holds one project, says nothing about other projects', async () => {
  mockCloud = false
  await renderPanel()
  expect(screen.queryByText(TITLE)).toBeNull()
  const text = pageText()
  expect(text).toContain("Each login reaches only this project's schema, over TLS.")
  expect(text).not.toMatch(/other projects|share one Postgres|catalogs/)
})
