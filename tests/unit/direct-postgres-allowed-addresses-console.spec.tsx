/**
 * @jest-environment jsdom
 */

/**
 * Connect → Postgres where the region's database endpoint admits only allowed
 * addresses (owner's decision, 2026-11-17).
 *
 * Until the project allows one, the tab says so first ("Allow an address
 * first"), before the logins and their strings, and offers "Allow my address"
 * with the address the request came from. With addresses allowed, each is a
 * row with Remove, and the line under them says how many the plan allows.
 * Where the region does not limit addresses there is no such section.
 *
 * The endpoint is shared by every project in the region and admits the union
 * of their addresses, so the page never says this project's list is the only
 * way in: an address another project allows reaches it too, and the login's
 * password is what lets a connection into this project. Removing an address
 * leaves open connections open, and the dialog says so. An address past the
 * plan's number (after a restore, or a smaller plan) is shown as not admitted.
 */

/** What the page said before, which was not true of a shared endpoint. */
const OVERCLAIMS = /Postgres takes connections only from these addresses|Postgres refuses every connection/

import { act, fireEvent, render, screen } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
import { DirectDatabasePanel } from '@/components/connect/DirectDatabasePanel'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'

const OWNER = { success: true, data: { id: 'p1', name: 'shop', region: null, role: 'OWNER', canWrite: true, canAdminister: true } }
const LOGIN = {
  mode: 'READ_ONLY',
  roleName: 'bkn_ro_0123456789ab',
  password: 'not-a-real-password',
  host: 'db.example.test',
  port: 5432,
  database: 'backenly',
  connectionString: 'postgresql://bkn_ro_0123456789ab:not-a-real-password@db.example.test:5432/backenly?sslmode=require',
  psqlCommand: 'psql "postgresql://…"',
  pgDumpCommand: 'pg_dump "postgresql://…"',
  createdAt: '2026-11-17T03:00:00.000Z',
  rotatedAt: null,
}

function status(addresses: Array<{ cidr: string; createdAt: string; admitted?: boolean }>, enforced = true, notAdmitted?: string) {
  return {
    schema: 'workspace_p1',
    available: true,
    credentials: [LOGIN],
    allowlist: { enforced, addresses: addresses.map((a) => ({ admitted: true, ...a })), limit: 2, planCode: 'SANDBOX', planName: 'Free', ...(notAdmitted ? { notAdmitted } : {}) },
    you: { address: '198.51.100.23', allowable: true },
    pendingDriftEvents: 0,
  }
}

let current: ReturnType<typeof status>
let posted: Array<{ url: string; body: unknown }>

beforeEach(() => {
  forgetProjectReads()
  clearProjectRoleCache()
  posted = []
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.split('?')[0] === '/api/projects/p1') return Promise.resolve({ ok: true, status: 200, json: async () => OWNER })
    if (url === '/api/projects/p1/database-access/allowed-addresses' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      posted.push({ url, body })
      if (body.address === '10.0.0.0/16') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ code: 'ADDRESS_NOT_PUBLIC', error: '10.0.0.0/16 is a private network range, which never connects from the internet.' }),
        })
      }
      const cidr = body.mine ? '198.51.100.23/32' : String(body.address)
      current = status([...current.allowlist.addresses, { cidr, createdAt: '2026-11-17T04:00:00.000Z' }])
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ address: { cidr }, added: true, applied: true }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => current })
  }) as unknown as typeof fetch
})

async function renderPanel() {
  render(<DirectDatabasePanel projectId="p1" />)
  await settle()
}
async function settle() {
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
}
const pageText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

it('says “Allow an address first” before the logins and their strings, and offers to allow the caller’s address', async () => {
  current = status([])
  await renderPanel()
  const text = pageText()
  expect(text).toContain('Allow an address first')
  expect(text).toContain('The endpoint refuses an address no project in this region allows. Allow the one you connect from.')
  expect(text).toContain(
    "The database endpoint is shared by the projects in this region and admits only the addresses they allow. Allow the ones you connect from; a login's password is what lets a connection into this project.",
  )
  expect(text).not.toMatch(OVERCLAIMS)
  expect(text.indexOf('Allow an address first')).toBeLessThan(text.indexOf('Logins'))
  expect(text.indexOf('Allow an address first')).toBeLessThan(text.indexOf('postgresql://'))

  fireEvent.click(screen.getByRole('button', { name: 'Allow my address (198.51.100.23)' }))
  await settle()
  expect(posted).toEqual([{ url: '/api/projects/p1/database-access/allowed-addresses', body: { mine: true } }])
  expect(pageText()).toContain('198.51.100.23/32 is allowed.')
  expect(pageText()).not.toContain('Allow an address first')
})

it('lists each allowed address with Remove, marks the caller’s own, and says how many the plan allows', async () => {
  current = status([{ cidr: '198.51.100.0/24', createdAt: '2026-11-17T03:00:00.000Z' }])
  await renderPanel()
  expect(screen.getByText('198.51.100.0/24')).toBeTruthy()
  expect(screen.getByText('Your address')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Actions for 198.51.100.0/24' })).toBeTruthy()
  expect(pageText()).toContain('1 of 2 on the Free plan.')
  expect(pageText()).not.toMatch(OVERCLAIMS)
  // The caller's address is already covered: no button to allow it again.
  expect(screen.queryByRole('button', { name: /Allow my address/ })).toBeNull()
  expect(pageText()).not.toContain('Allow an address first')
})

it('allows a typed range, and shows the server’s refusal in its own words', async () => {
  current = status([{ cidr: '203.0.113.7/32', createdAt: '2026-11-17T03:00:00.000Z' }])
  await renderPanel()
  const field = screen.getByRole('textbox', { name: 'Address or range to allow' })

  fireEvent.change(field, { target: { value: '10.0.0.0/16' } })
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await settle()
  expect(pageText()).toContain('10.0.0.0/16 is a private network range, which never connects from the internet.')

  fireEvent.change(field, { target: { value: '192.0.2.0/24' } })
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await settle()
  expect(posted.map((p) => p.body)).toEqual([{ address: '10.0.0.0/16' }, { address: '192.0.2.0/24' }])
  expect(screen.getByText('192.0.2.0/24')).toBeTruthy()
})

it('shows no allowed addresses where the region does not limit them', async () => {
  current = status([], false)
  await renderPanel()
  expect(pageText()).not.toMatch(/Allowed addresses|Allow an address first|Allow my address/)
  expect(pageText()).toContain('Logins')
})

it('says, before removing an address, that another project may still allow it and that open connections stay open', async () => {
  current = status([{ cidr: '198.51.100.0/24', createdAt: '2026-11-17T03:00:00.000Z' }])
  await renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'Actions for 198.51.100.0/24' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
  const dialog = screen.getByRole('dialog')
  expect((dialog.textContent ?? '').replace(/\s+/g, ' ')).toContain(
    "New connections from it are refused, unless another project in this region allows it too. Connections already open stay open: rotate a login's password to end them.",
  )
  expect(dialog.textContent ?? '').toContain('You can undo this in History.')
})

it('shows an address past the plan’s number as not admitted, with what to do', async () => {
  current = status(
    [
      { cidr: '198.51.100.1/32', createdAt: '2026-11-17T01:00:00.000Z' },
      { cidr: '198.51.100.2/32', createdAt: '2026-11-17T02:00:00.000Z' },
      { cidr: '198.51.100.3/32', createdAt: '2026-11-17T03:00:00.000Z', admitted: false },
    ],
    true,
    'Not admitted on the Free plan: remove one, or move to Pro for up to 10.',
  )
  await renderPanel()
  expect(screen.getAllByText('Not admitted on the Free plan: remove one, or move to Pro for up to 10.')).toHaveLength(1)
  expect(pageText()).toContain('3 of 2 on the Free plan.')
})
