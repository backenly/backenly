/**
 * @jest-environment jsdom
 */

/**
 * Connect → Postgres where nothing outside Backenly can reach the database.
 *
 * Production QA re-test, 2026-11-16, new finding N4: the page handed out
 * logins for backenly.com:5432, where nothing listens. Where the server says
 * direct connections are unavailable, the page says so, offers no login, and
 * lists the logins that exist by name with Revoke only. Backups still work.
 */

import { act, render, screen } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
import { DirectDatabasePanel } from '@/components/connect/DirectDatabasePanel'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'

const OWNER = { success: true, data: { id: 'p1', name: 'shop', region: null, role: 'OWNER', canWrite: true, canAdminister: true } }
const UNAVAILABLE = {
  schema: 'workspace_p1',
  available: false,
  unavailable: "Direct Postgres connections aren't available in this project's region yet.",
  credentials: [],
  logins: [{ mode: 'READ_ONLY', roleName: 'bkn_ro_0123456789ab', createdAt: '2026-11-16T03:00:00.000Z', rotatedAt: null }],
  pendingDriftEvents: 0,
}

beforeEach(() => {
  forgetProjectReads()
  clearProjectRoleCache()
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const body = String(input).split('?')[0] === '/api/projects/p1' ? OWNER : UNAVAILABLE
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  }) as unknown as typeof fetch
})

async function renderPanel() {
  render(<DirectDatabasePanel projectId="p1" />)
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
}

const pageText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

it('says direct connections are not available here, and offers no login', async () => {
  await renderPanel()
  expect(pageText()).toContain(
    "Direct Postgres connections aren't available in this project's region yet: nothing outside Backenly can reach its database.",
  )
  expect(screen.queryByRole('button', { name: 'Create login' })).toBeNull()
  expect(pageText()).not.toMatch(/postgresql:\/\/|Copy psql command|Copy pg_dump command|over TLS/)
})

it('lists the login that exists by name, with Revoke only, and keeps the backups', async () => {
  await renderPanel()
  expect(screen.getByText('bkn_ro_0123456789ab')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Rotate password/ })).toBeNull()
  expect(pageText()).toContain('Full backup (.sql)')
})
