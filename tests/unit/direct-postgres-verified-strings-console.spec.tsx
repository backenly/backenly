/**
 * @jest-environment jsdom
 */

/**
 * Connect → Postgres where the region's endpoint fronts its RDS instance
 * (owner's decision, 2026-11-17): each login shows two strings, one for psql,
 * pg_dump and other libpq tools and one for every other client, with a link to
 * the CA bundle both name, and says how many connections a login may hold at
 * once on the plan. Elsewhere a login keeps its one string.
 */

import { act, render, screen } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
import { DirectDatabasePanel } from '@/components/connect/DirectDatabasePanel'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'

const OWNER = { success: true, data: { id: 'p1', name: 'shop', region: null, role: 'OWNER', canWrite: true, canAdminister: true } }
const PASSWORD = 'not-a-real-password'
const LIBPQ = `postgresql://bkn_ro_0123456789ab:${PASSWORD}@instance-1.rds.example.test:5432/backenly?hostaddr=192.0.2.10&sslmode=verify-full&sslrootcert=rds-ca-cloud-regions.pem`
const OTHER = `postgresql://bkn_ro_0123456789ab:${PASSWORD}@db.example.test:5432/backenly?sslmode=verify-ca&sslrootcert=rds-ca-cloud-regions.pem`
const CA = { file: 'rds-ca-cloud-regions.pem', url: 'https://backenly.example.test/certs/rds-ca-cloud-regions.pem' }

function login(extra: Record<string, unknown>) {
  return {
    mode: 'READ_ONLY',
    roleName: 'bkn_ro_0123456789ab',
    password: PASSWORD,
    host: 'db.example.test',
    port: 5432,
    database: 'backenly',
    psqlCommand: `psql "${LIBPQ}"`,
    pgDumpCommand: `pg_dump "${LIBPQ}"`,
    createdAt: '2026-11-17T03:00:00.000Z',
    rotatedAt: null,
    ...extra,
  }
}

let current: unknown

beforeEach(() => {
  forgetProjectReads()
  clearProjectRoleCache()
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

it('shows a string for libpq tools and one for every other client, the CA bundle to download, and the limit per login', async () => {
  current = {
    schema: 'workspace_p1',
    available: true,
    credentials: [login({ connectionString: LIBPQ, otherClientsConnectionString: OTHER, caBundle: CA })],
    connectionLimit: 2,
    pendingDriftEvents: 0,
  }
  await renderPanel()
  const text = pageText()
  expect(text).toContain('For psql, pg_dump and other libpq tools')
  expect(text).toContain('For every other client')
  // Masked until shown, as before.
  expect(text).toContain('postgresql://bkn_ro_0123456789ab:••••••••@instance-1.rds.example.test:5432/backenly?hostaddr=192.0.2.10&sslmode=verify-full')
  expect(text).toContain('postgresql://bkn_ro_0123456789ab:••••••••@db.example.test:5432/backenly?sslmode=verify-ca')
  expect(text).not.toContain(PASSWORD)
  expect(screen.getByRole('button', { name: 'Copy connection string' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy the connection string for other clients' })).toBeTruthy()

  const link = screen.getByRole('link', { name: 'Download rds-ca-cloud-regions.pem' })
  expect(link.getAttribute('href')).toBe(CA.url)
  expect(link.getAttribute('download')).toBe('rds-ca-cloud-regions.pem')
  expect(text).toContain("The strings check the server's certificate against Backenly's CA bundle.")
  expect(text).toContain('over TLS, with up to 2 connections at once. Every change to a login is recorded')
})

it('keeps one string and no CA bundle where the region’s endpoint is not described further', async () => {
  current = {
    schema: 'workspace_p1',
    available: true,
    credentials: [login({ connectionString: `postgresql://bkn_ro_0123456789ab:${PASSWORD}@db.example.test:5432/backenly?sslmode=require` })],
    connectionLimit: null,
    pendingDriftEvents: 0,
  }
  await renderPanel()
  const text = pageText()
  expect(text).not.toMatch(/For every other client|Download rds-ca-cloud-regions\.pem|connections at once/)
  expect(screen.getAllByRole('button', { name: 'Copy connection string' })).toHaveLength(1)
  expect(text).toContain("Each login reaches only this project's schema, over TLS. Every change")
})
