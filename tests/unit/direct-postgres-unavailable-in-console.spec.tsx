/**
 * @jest-environment jsdom
 */

/**
 * Connect → Postgres where nothing outside Backenly can reach the database.
 *
 * Production QA re-test, 2026-11-16, new finding N4: the page handed out
 * logins for backenly.com:5432, where nothing listens. Where the server says
 * direct connections are unavailable, the page says why in the server's own
 * sentence (a shared database on Backenly Cloud, a project database whose
 * region does not offer the connection pooler yet, or a self-hosted database
 * with no host), offers no login, and lists the logins that exist by name
 * with Revoke only. Backups still work.
 */

import { act, render, screen } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
import { DirectDatabasePanel } from '@/components/connect/DirectDatabasePanel'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'

const OWNER = { success: true, data: { id: 'p1', name: 'shop', region: null, role: 'OWNER', canWrite: true, canAdminister: true } }
const SAID = {
  no_host:
    "Direct Postgres connections aren't available in this project's region yet: nothing outside Backenly can reach its database, so there is no connection string to give.",
  shared_database:
    "Direct Postgres connections are for projects with a database of their own, reached through Backenly's connection pooler. This project's data is in its region's shared database, which nothing outside Backenly can reach, so there is no connection string for it.",
  pooler_not_offered:
    "This project has a database of its own, but the connection pooler that direct Postgres connections go through isn't offered in its region yet, so there is no connection string for it yet.",
}

function unavailable(reason: keyof typeof SAID) {
  return {
    schema: 'workspace_p1',
    available: false,
    unavailable: SAID[reason],
    unavailableReason: reason,
    tenancy: reason === 'pooler_not_offered' ? 'dedicated' : 'shared',
    credentials: [],
    logins: [{ mode: 'READ_ONLY', roleName: 'bkn_ro_0123456789ab', createdAt: '2026-11-16T03:00:00.000Z', rotatedAt: null }],
    pendingDriftEvents: 0,
  }
}

let current: unknown = unavailable('no_host')

beforeEach(() => {
  forgetProjectReads()
  clearProjectRoleCache()
  current = unavailable('no_host')
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const body = String(input).split('?')[0] === '/api/projects/p1' ? OWNER : current
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  }) as unknown as typeof fetch
})

async function renderPanel() {
  render(<DirectDatabasePanel projectId="p1" />)
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
}

const pageText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

it.each(Object.keys(SAID) as Array<keyof typeof SAID>)('says why direct connections are not available (%s), what works instead, and offers no login', async (reason) => {
  current = unavailable(reason)
  await renderPanel()
  expect(pageText()).toContain(SAID[reason])
  expect(pageText()).toContain('Read and change data in the Database section or through the REST API, and download a backup below.')
  expect(screen.queryByRole('button', { name: 'Create login' })).toBeNull()
  expect(pageText()).not.toMatch(/postgresql:\/\/|Copy psql command|Copy pg_dump command|over TLS|Session \(port/)
})

it('lists the login that exists by name, with Revoke only, and keeps the backups', async () => {
  await renderPanel()
  expect(screen.getByText('bkn_ro_0123456789ab')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Rotate password/ })).toBeNull()
  expect(pageText()).toContain('Full backup (.sql)')
})
