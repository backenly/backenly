/**
 * @jest-environment jsdom
 */
/**
 * A plan limit is said before the click, and again when "New project" is
 * clicked, before the form. Production QA (2026-11-09): on Free the form
 * opened, and "Free includes 1 project across the organizations you own or
 * administer" came back only after the name and region were filled in.
 *
 * Console team pages (2026-11-16): the header says "1 of 1" at the limit, the
 * dialog says what Pro changes, and a list that fails to load says so instead
 * of turning into the first-project screen.
 *
 * Import (2026-11-16, second round): New project is the form itself, Backenly
 * first; importing from Supabase, Firebase or Postgres is one quiet link in
 * its footer. The plan limit is still said before the dialog.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
// One router for every render, as Next gives: the page's list effect depends on it.
const mockRouter = { push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useParams: () => ({}),
  usePathname: () => '/app',
  useSearchParams: () => new URLSearchParams(),
}))
// The account frame fetches its own data; this test is about the page inside it.
jest.mock('@/components/shell/OrgShell', () => ({
  OrgShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { ProjectsHome } from '@/components/projects/ProjectsHome'

const LIMIT = 'Free includes 1 project across the organizations you own or administer.'
const TODO = {
  id: 'p1', name: 'todo-list', description: null, userId: 'u1', projectStatus: 'PRIVATE', environment: 'production',
  region: 'ap-south-1', lastActivityAt: null, createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
  metrics: { totalFunctions: 0, totalTables: 0, totalWorkspaces: 1, apiRequests: 0, avgLatency: 0, errorCount: 0, storageUsed: '0', activeUsers: 0 },
}

function stub(
  canCreate: { allowed: boolean; error?: string; code?: string },
  { projects = [TODO], listFails = false }: { projects?: unknown[]; listFails?: boolean } = {},
) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    if (path === '/api/projects' && listFails) {
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ success: false, error: 'Failed to fetch projects' }) } as Response)
    }
    const body =
      path === '/api/auth/me' ? { user: { id: 'u1', email: 'owner@example.test', name: 'Owner' } }
      : path === '/api/projects/can-create' ? canCreate
      : path === '/api/projects' ? { success: true, data: projects, count: projects.length }
      : path === '/api/billing/usage' ? { projectsUsed: projects.length, maxProjects: 1 }
      : path === '/api/projects/status' ? { success: true, data: [] }
      : path === '/api/import' ? { jobs: [] }
      : {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
}

// Each test its own organization: the page keeps the last list per organization.
let orgs = 0
async function renderPage() {
  const id = `org-${++orgs}`
  render(<ProjectsHome org={{ id, name: 'Acme', role: 'OWNER' }} />)
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
  return id
}

async function clickNew() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  })
}

it('on a full plan, says "1 of 1" before the click, then the limit and no form', async () => {
  stub({ allowed: false, code: 'PLAN_LIMIT_EXCEEDED', error: LIMIT })
  const org = await renderPage()
  expect(screen.getByText('1 of 1')).toBeInTheDocument()
  await clickNew()
  expect(screen.getByRole('dialog', { name: 'Free includes 1 project' })).toBeInTheDocument()
  expect(screen.getByText('Pro has no project limit, for $25 a month.')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Upgrade to Pro' })).toHaveAttribute('href', `/app/org/${org}/billing`)
  expect(screen.queryByLabelText('Project name')).toBeNull()
})

it('CONTROL: with room on the plan, opens the form, with importing as one quiet link', async () => {
  stub({ allowed: true })
  const org = await renderPage()
  expect(screen.queryByText('1 of 1')).toBeNull()
  await clickNew()
  expect(screen.getByRole('dialog', { name: 'New project' })).toBeInTheDocument()
  expect(screen.getByText('In Acme')).toBeInTheDocument()
  expect(screen.getByLabelText('Project name')).toBeInTheDocument()
  expect(screen.queryByRole('radio', { name: /Start from scratch/ })).toBeNull()
  expect(screen.queryByRole('dialog', { name: 'Free includes 1 project' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Import from Supabase, Firebase or Postgres' })).toHaveAttribute('href', `/app/org/${org}/import`)
})

it('CONTROL: a refusal that is not a plan limit is still said by creating, in the form', async () => {
  stub({ allowed: false, code: 'ORGANIZATION_ROLE_REQUIRED', error: 'Only owners and admins create projects here.' })
  await renderPage()
  await clickNew()
  expect(screen.getByRole('dialog', { name: 'New project' })).toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Free includes 1 project' })).toBeNull()
})

it('a list that fails to load says so, with Retry, and never shows the first-project row', async () => {
  stub({ allowed: true }, { listFails: true })
  await renderPage()
  expect(screen.getByText('Could not load projects. Try again.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  expect(screen.queryByText(/Create your first project/)).toBeNull()
})

it('CONTROL: an account with no projects is offered its first', async () => {
  stub({ allowed: true }, { projects: [] })
  await renderPage()
  expect(screen.getByText(/Create your first project/)).toBeInTheDocument()
  expect(screen.queryByText('Could not load projects. Try again.')).toBeNull()
})
