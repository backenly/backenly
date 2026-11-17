/**
 * @jest-environment jsdom
 */
/**
 * The Projects page lists the projects deleted in the last 7 days under
 * "Recently deleted", with the day each is removed for good, and restores one
 * in place (production QA re-test 2026-11-16, report #106: deleting was
 * immediate and could not be taken back).
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
const mockRouter = { push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useParams: () => ({}),
  usePathname: () => '/app',
  useSearchParams: () => new URLSearchParams(),
}))
jest.mock('@/components/shell/OrgShell', () => ({
  OrgShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { ProjectsHome } from '@/components/projects/ProjectsHome'

const project = (id: string, name: string) => ({
  id, name, description: null, userId: 'u1', projectStatus: 'PRIVATE', environment: 'production',
  region: 'ap-south-1', lastActivityAt: null, createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
  metrics: { totalFunctions: 0, totalTables: 0, totalWorkspaces: 1, apiRequests: 0, avgLatency: 0, errorCount: 0, storageUsed: '0', activeUsers: 0 },
})

let live = [project('p1', 'todo-list')]
let deleted = [{ id: 'p2', name: 'shop-staging', organizationId: null, deletedAt: '2026-11-17T10:00:00.000Z', purgeAfter: '2026-11-24T10:00:00.000Z' }]
let undeleteAnswer: { status: number; body: unknown } = { status: 200, body: { success: true } }
const posted: string[] = []

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  live = [project('p1', 'todo-list')]
  deleted = [{ id: 'p2', name: 'shop-staging', organizationId: null, deletedAt: '2026-11-17T10:00:00.000Z', purgeAfter: '2026-11-24T10:00:00.000Z' }]
  undeleteAnswer = { status: 200, body: { success: true } }
  posted.length = 0
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const [path, query = ''] = url.split('?')
    if (path === '/api/projects/p2/undelete' && init?.method === 'POST') {
      posted.push(path)
      if (undeleteAnswer.status === 200) {
        live = [...live, project('p2', 'shop-staging')]
        deleted = []
      }
      return json(undeleteAnswer.status, undeleteAnswer.body)
    }
    if (path === '/api/projects' && new URLSearchParams(query).get('deleted') === '1') return json(200, { success: true, data: deleted, count: deleted.length })
    const body =
      path === '/api/auth/me' ? { user: { id: 'u1', email: 'owner@example.test', name: 'Owner' } }
      : path === '/api/projects/can-create' ? { allowed: true }
      : path === '/api/projects' ? { success: true, data: live, count: live.length }
      : path === '/api/billing/usage' ? { projectsUsed: live.length, maxProjects: null }
      : path === '/api/projects/status' ? { success: true, data: [] }
      : path === '/api/import' ? { jobs: [] }
      : {}
    return json(200, body)
  }) as unknown as typeof fetch
})

let orgs = 0
async function renderPage() {
  render(<ProjectsHome org={{ id: `org-rd-${++orgs}`, name: 'Acme', role: 'OWNER' }} />)
  await settle()
}
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })

it('lists a deleted project with the day it is removed for good, and restores it', async () => {
  await renderPage()
  const section = screen.getByRole('region', { name: 'Recently deleted' })
  expect(within(section).getByText('shop-staging')).toBeInTheDocument()
  expect(within(section).getByText('Removed for good on Nov 24')).toBeInTheDocument()

  await act(async () => { fireEvent.click(within(section).getByRole('button', { name: 'Restore' })) })
  await settle()

  expect(posted).toEqual(['/api/projects/p2/undelete'])
  expect(screen.queryByRole('region', { name: 'Recently deleted' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Actions for shop-staging' })).toBeInTheDocument()
})

it('says why a restore was refused, and keeps the project listed as deleted', async () => {
  undeleteAnswer = {
    status: 403,
    body: { success: false, code: 'PLAN_LIMIT_EXCEEDED', error: "shop-staging cannot be restored: the plan's project limit is reached. Delete another project or upgrade, then restore it." },
  }
  await renderPage()
  const section = screen.getByRole('region', { name: 'Recently deleted' })

  await act(async () => { fireEvent.click(within(section).getByRole('button', { name: 'Restore' })) })
  await settle()

  expect(within(section).getByText(/the plan's project limit is reached/)).toBeInTheDocument()
  expect(within(section).getByText('shop-staging')).toBeInTheDocument()
})

it('shows nothing when no project was deleted', async () => {
  deleted = []
  await renderPage()
  expect(screen.queryByRole('region', { name: 'Recently deleted' })).toBeNull()
})
