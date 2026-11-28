/**
 * @jest-environment jsdom
 */

/**
 * Connect → Postgres for a project with a database of its own, reached through
 * its region's connection pooler (lib/services/direct-access.ts):
 *
 *   - each login shows two strings: session pooling on port 5432 (migrations,
 *     psql, pg_dump) and transaction pooling on port 6543 (application
 *     traffic, serverless), both sslmode=verify-full, the password masked
 *     until shown, with which port is for what (Prisma included);
 *   - the read-write login's password is on the page once, right after the
 *     login is made or rotated, with a line saying to copy it now; read again
 *     later, the strings carry [YOUR-PASSWORD] and the row says the password
 *     was shown once and rotating gives a new one;
 *   - a login from before the project had a database of its own says to
 *     rotate it to connect through the pooler;
 *   - the note about other projects reading a shared database's catalogs is
 *     not shown: this database is the project's own.
 *
 * Elsewhere (a database its operator gives a host for) a login keeps one string.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
import { DirectDatabasePanel } from '@/components/connect/DirectDatabasePanel'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'
import { poolerPortShares } from '@/lib/data-plane/pooler-shares'

const OWNER = { success: true, data: { id: 'p1', name: 'shop', region: null, role: 'OWNER', canWrite: true, canAdminister: true } }
const HOST = 'ap-south-1.db.backenly.com'
const DB = 'p_0123456789abcdef0123456789abcdef'
const RO_PASSWORD = 'not-a-real-read-only-password'
const RW_PASSWORD = 'not-a-real-read-write-password'
const GUIDANCE = [
  'Port 5432 is session pooling: use it for migrations, psql, pg_dump and anything that holds a session (LISTEN, advisory locks, session SET).',
  'Port 6543 is transaction pooling: use it for application traffic and serverless functions.',
  'Prisma: the application on 6543 (url) and Prisma Migrate on 5432 (directUrl).',
]

const strings = (role: string, password: string) => ({
  connectionString: `postgresql://${role}:${password}@${HOST}:5432/${DB}?sslmode=verify-full`,
  transactionConnectionString: `postgresql://${role}:${password}@${HOST}:6543/${DB}?sslmode=verify-full`,
  psqlCommand: `psql "postgresql://${role}:${password}@${HOST}:5432/${DB}?sslmode=verify-full&sslrootcert=system"`,
  pgDumpCommand: `pg_dump "postgresql://${role}:${password}@${HOST}:5432/${DB}?sslmode=verify-full&sslrootcert=system"`,
})

function login(mode: 'READ_ONLY' | 'READ_WRITE', password: string | null, extra: Record<string, unknown> = {}) {
  const roleName = mode === 'READ_ONLY' ? 'bkn_ro_0123456789ab' : 'bkn_rw_0123456789ab'
  return {
    mode,
    roleName,
    password,
    passwordShown: mode === 'READ_ONLY' ? 'always' : 'once',
    host: HOST,
    port: 5432,
    transactionPort: 6543,
    database: DB,
    ...strings(roleName, password ?? '[YOUR-PASSWORD]'),
    createdAt: '2026-11-21T03:00:00.000Z',
    rotatedAt: null,
    ...(mode === 'READ_WRITE' ? { schemaChanges: 'refused' } : {}),
    ...extra,
  }
}

const POOLED = (credentials: unknown[], limit = 2) => ({
  schema: 'workspace_p1',
  available: true,
  tenancy: 'dedicated',
  pooler: { host: HOST, sessionPort: 5432, transactionPort: 6543, guidance: GUIDANCE },
  credentials,
  connectionLimit: limit,
  connectionShares: poolerPortShares(limit),
  pendingDriftEvents: 0,
})

let current: unknown
let created: unknown

beforeEach(() => {
  forgetProjectReads()
  clearProjectRoleCache()
  created = null
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).split('?')[0]
    if (url === '/api/projects/p1/database-access' && init?.method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ credential: created }) })
    }
    const body = url === '/api/projects/p1' ? OWNER : current
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  }) as unknown as typeof fetch
})

async function settle() {
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
}

async function renderPanel() {
  const rendered = render(<DirectDatabasePanel projectId="p1" />)
  await settle()
  return rendered
}

const pageText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

it('shows a session and a transaction string per login, through the pooler, masked, and says which port is for what', async () => {
  current = POOLED([login('READ_ONLY', RO_PASSWORD)])
  await renderPanel()
  const text = pageText()
  expect(text).toContain('Session (port 5432): migrations, psql, pg_dump')
  expect(text).toContain('Transaction (port 6543): application traffic, serverless')
  expect(text).toContain(`postgresql://bkn_ro_0123456789ab:••••••••@${HOST}:5432/${DB}?sslmode=verify-full`)
  expect(text).toContain(`postgresql://bkn_ro_0123456789ab:••••••••@${HOST}:6543/${DB}?sslmode=verify-full`)
  expect(text).not.toContain(RO_PASSWORD)
  expect(screen.getByRole('button', { name: 'Copy the session connection string' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy the transaction connection string' })).toBeTruthy()
  for (const line of GUIDANCE) expect(text).toContain(line)
  // What the number covers: each port has its own share of it. It used to say
  // "up to 2 connections at once" and no more, while two sessions closed on
  // port 5432 locked the same login out of port 6543 for a minute
  // (production QA, 2026-11-27).
  expect(text).toContain(
    'over TLS, with up to 2 connections at once: 1 on port 5432 and 1 on port 6543, so using one port never takes from the other. ' +
      'Every change to a login is recorded',
  )
  // Nothing of the retired regional endpoint is left.
  expect(text).not.toMatch(/verify-ca|hostaddr|rds-ca-cloud-regions|Allowed addresses|Allow my address/)
})

it("says each port's share of a larger plan's connections", async () => {
  current = POOLED([login('READ_ONLY', RO_PASSWORD)], 5)
  await renderPanel()
  expect(pageText()).toContain('with up to 5 connections at once: 2 on port 5432 and 3 on port 6543, so using one port never takes from the other.')
})

it('promises nothing about the ports for a limit that cannot be shared', async () => {
  current = POOLED([login('READ_ONLY', RO_PASSWORD)], 1)
  await renderPanel()
  expect(pageText()).toContain('over TLS, with up to 1 connection at once. Every change to a login is recorded')
})

it('says nothing about other projects reading the catalogs: the database is the project’s own', async () => {
  current = POOLED([login('READ_ONLY', RO_PASSWORD)])
  await renderPanel()
  expect(screen.queryByText('Other projects can see your table definitions')).toBeNull()
})

it('shows a new read-write login’s password once, with a line to copy it now, and never on a later read', async () => {
  current = POOLED([login('READ_ONLY', RO_PASSWORD)])
  created = login('READ_WRITE', RW_PASSWORD)
  const first = await renderPanel()

  // The status read after the login is made lists it without its password.
  current = POOLED([login('READ_ONLY', RO_PASSWORD), login('READ_WRITE', null)])
  fireEvent.click(screen.getByRole('button', { name: 'Create login' }))
  await settle()
  let text = pageText()
  expect(text).toContain('Read-write login created.')
  expect(text).toContain("Copy the password now: it isn't shown again. Rotate the login to get a new one.")
  expect(text).toContain(`postgresql://bkn_rw_0123456789ab:••••••••@${HOST}:5432/${DB}?sslmode=verify-full`)
  expect(text).not.toContain('[YOUR-PASSWORD]')

  // Shown again: it is the real one, for this once.
  const shows = screen.getAllByRole('button', { name: 'Show password' })
  fireEvent.click(shows[shows.length - 1])
  expect(pageText()).toContain(`postgresql://bkn_rw_0123456789ab:${RW_PASSWORD}@${HOST}:6543/${DB}?sslmode=verify-full`)

  // A fresh page has only what the status gives.
  first.unmount()
  await renderPanel()
  text = pageText()
  expect(text).not.toContain(RW_PASSWORD)
  expect(text).toContain(`postgresql://bkn_rw_0123456789ab:[YOUR-PASSWORD]@${HOST}:5432/${DB}?sslmode=verify-full`)
  expect(text).toContain('The password was shown once, when the login was made or last rotated, and Backenly doesn')
  expect(text).toContain('rotate the login to get a new one.')
})

it('says to rotate a login made before the project had a database of its own', async () => {
  current = POOLED([login('READ_WRITE', null, { passwordShown: 'rotate' })])
  await renderPanel()
  expect(pageText()).toContain(
    'This login was made before the project had a database of its own. Rotate its password to connect through the connection pooler.',
  )
})

it('keeps one string where the database is reached at a host its operator gives', async () => {
  current = {
    schema: 'workspace_p1',
    available: true,
    tenancy: 'shared',
    credentials: [
      login('READ_ONLY', RO_PASSWORD, {
        passwordShown: 'always',
        host: 'db.example.test',
        connectionString: `postgresql://bkn_ro_0123456789ab:${RO_PASSWORD}@db.example.test:5432/backenly?sslmode=require`,
        transactionConnectionString: undefined,
        transactionPort: undefined,
      }),
    ],
    connectionLimit: null,
    pendingDriftEvents: 0,
  }
  await renderPanel()
  const text = pageText()
  expect(text).not.toMatch(/Session \(port|Transaction \(port|connections at once|Prisma/)
  expect(screen.getAllByRole('button', { name: 'Copy connection string' })).toHaveLength(1)
  expect(text).toContain("Each login reaches only this project's schema, over TLS. Every change")
})
