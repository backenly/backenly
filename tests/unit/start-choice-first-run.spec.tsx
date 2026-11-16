/**
 * @jest-environment jsdom
 */
/**
 * The first run: "Create your first project" (onboarding, 2026-11-16, the
 * founder's second round: Backenly first, importing small).
 *
 * Asked once, in a large dialog, of an owner or admin whose organization has
 * no projects: the project's name and region, and one Create project button.
 * Importing from Supabase, Firebase or Postgres is one quiet link at the
 * bottom, shown only where the import API answers. Creating, or closing it,
 * records the answer (tours id `start-choice`) and it is never asked again.
 * Nobody is asked who cannot create here or where the plan has no room.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

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

const QUESTION = 'Create your first project'
const TODO = {
  id: 'p1', name: 'todo-list', description: null, userId: 'u1', projectStatus: 'PRIVATE', environment: 'production',
  region: 'ap-south-1', lastActivityAt: null, createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
  metrics: { totalFunctions: 0, totalTables: 0, totalWorkspaces: 1, apiRequests: 0, avgLatency: 0, errorCount: 0, storageUsed: '0', activeUsers: 0 },
}

let posted: unknown[] = []
let toursRead = 0

const answer = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body } as Response)

function stub({
  seen = ['console'],
  available = true,
  importApi = true,
  canCreate = { allowed: true } as { allowed: boolean; code?: string; error?: string },
  projects = [] as unknown[],
} = {}) {
  posted = []
  toursRead = 0
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]
    if (path === '/api/tours' && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)))
      return answer({ saved: true })
    }
    if (path === '/api/tours') toursRead += 1
    if (path === '/api/import' && !importApi) return answer({ error: 'Not found' }, 404)
    const body =
      path === '/api/auth/me' ? { user: { id: 'u1', email: 'owner@example.test', name: 'Owner' } }
      : path === '/api/tours' ? { available, seen }
      : path === '/api/projects/can-create' ? canCreate
      : path === '/api/projects' ? { success: true, data: projects, count: projects.length }
      : path === '/api/billing/usage' ? { projectsUsed: projects.length, maxProjects: 1 }
      : path === '/api/projects/status' ? { success: true, data: [] }
      : path === '/api/import' ? { jobs: [] }
      : {}
    return answer(body)
  }) as unknown as typeof fetch
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 60; i++) await Promise.resolve()
  })

// Each test its own organization: the page keeps the last list per organization.
let orgs = 0
async function renderPage(role = 'OWNER', id = `org-start-${++orgs}`) {
  const view = render(<ProjectsHome org={{ id, name: 'Acme', role }} />)
  await settle()
  return { id, ...view }
}

beforeEach(() => {
  localStorage.clear()
  mockRouter.push.mockClear()
})

it('asks an owner of an empty organization once: create the project, importing as one quiet link', async () => {
  stub()
  const { id } = await renderPage()
  const dialog = screen.getByRole('dialog', { name: QUESTION })
  expect(dialog).toBeInTheDocument()
  // Backenly first: a name and Create project; no choice between importing and starting fresh.
  expect(screen.getByLabelText('Project name')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled()
  expect(screen.queryByRole('radio', { name: /Bring your backend/ })).toBeNull()
  expect(screen.queryByRole('radio', { name: 'Supabase' })).toBeNull()
  // Importing is a link, not an option.
  expect(screen.getByRole('link', { name: 'Import it' })).toHaveAttribute('href', `/app/org/${id}/import`)
})

it('creating the project records the answer and opens the new project', async () => {
  stub()
  const created: unknown[] = []
  const base = global.fetch as jest.Mock
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]
    if (path === '/api/projects' && init?.method === 'POST') {
      created.push(JSON.parse(String(init.body)))
      return answer({ success: true, data: { id: 'p-new' } })
    }
    return base(input, init)
  }) as unknown as typeof fetch
  await renderPage()
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'task-tracker' } })
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
  })
  await settle()
  expect(created).toEqual([expect.objectContaining({ name: 'task-tracker' })])
  expect(posted).toEqual([{ tourId: 'start-choice' }])
  expect(mockRouter.push).toHaveBeenCalledWith('/app/projects/p-new')
})

it('closing it is an answer: recorded, and not asked again on the next visit', async () => {
  stub()
  const { id, unmount } = await renderPage()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  })
  await settle()
  expect(posted).toEqual([{ tourId: 'start-choice' }])
  await waitFor(() => expect(screen.queryByRole('dialog', { name: QUESTION })).toBeNull())
  unmount()

  // Even before the server's record is read back, this browser remembers.
  await renderPage('OWNER', id)
  expect(screen.queryByRole('dialog', { name: QUESTION })).toBeNull()
})

it.each([
  ['it was answered before', {}, { seen: ['console', 'start-choice'] }],
  ['the tours record is not available', {}, { available: false }],
  ['the organization has projects', {}, { projects: [TODO] }],
  ['the plan has no room', {}, { canCreate: { allowed: false, code: 'PLAN_LIMIT_EXCEEDED', error: 'Free includes 1 project.' } }],
  ['the person cannot create projects here', { role: 'DEVELOPER' }, {}],
])('CONTROL: never asks when %s', async (_why, who: { role?: string }, setup) => {
  stub(setup)
  await renderPage(who.role ?? 'OWNER')
  expect(screen.queryByRole('dialog', { name: QUESTION })).toBeNull()
})

it('without the import API, the first run still asks, with no import link', async () => {
  stub({ importApi: false })
  await renderPage()
  expect(screen.getByRole('dialog', { name: QUESTION })).toBeInTheDocument()
  expect(screen.getByLabelText('Project name')).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Import it' })).toBeNull()
})
