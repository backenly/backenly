/**
 * @jest-environment jsdom
 */
/**
 * Deleting from the Projects list asks for the project's name, as project
 * Settings does, and the name goes to the server, which deletes with nothing
 * else. When the server asks for a sign-in from the last ten minutes, the
 * dialog asks for the password in place and then deletes (production QA
 * re-test 2026-11-16, report #106: the list deleted in one click).
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

const TODO = {
  id: 'p1', name: 'todo-list', description: null, userId: 'u1', projectStatus: 'PRIVATE', environment: 'production',
  region: 'ap-south-1', lastActivityAt: null, createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
  metrics: { totalFunctions: 0, totalTables: 0, totalWorkspaces: 1, apiRequests: 0, avgLatency: 0, errorCount: 0, storageUsed: '0', activeUsers: 0 },
}

type Sent = { path: string; method: string; body: any }
let sent: Sent[] = []
let deleteAnswers: Array<{ status: number; body: unknown }> = []

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  sent = []
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]
    const method = init?.method ?? 'GET'
    sent.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (path === '/api/projects/p1' && method === 'DELETE') {
      const next = deleteAnswers.shift() ?? { status: 200, body: { success: true } }
      return json(next.status, next.body)
    }
    if (path === '/api/auth/login' && method === 'POST') return json(200, { token: 'fresh', user: { id: 'u1', email: 'owner@example.test' } })
    const body =
      path === '/api/auth/me' ? { user: { id: 'u1', email: 'owner@example.test', name: 'Owner' } }
      : path === '/api/projects/can-create' ? { allowed: true }
      : path === '/api/projects' ? { success: true, data: [TODO], count: 1 }
      : path === '/api/billing/usage' ? { projectsUsed: 1, maxProjects: null }
      : path === '/api/projects/status' ? { success: true, data: [] }
      : path === '/api/import' ? { jobs: [] }
      : {}
    return json(200, body)
  }) as unknown as typeof fetch
})

let orgs = 0
async function openDelete() {
  render(<ProjectsHome org={{ id: `org-del-${++orgs}`, name: 'Acme', role: 'OWNER' }} />)
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Actions for todo-list' })) })
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' })) })
  return screen.getByRole('dialog', { name: 'Delete todo-list?' })
}

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })

it('asks for the name before deleting, and sends it', async () => {
  deleteAnswers = []
  const dialog = await openDelete()
  const button = within(dialog).getByRole('button', { name: 'Delete project' })
  expect(button).toBeDisabled()

  fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'todo-list' } })
  expect(button).toBeEnabled()
  await act(async () => { fireEvent.click(button) })
  await settle()

  expect(sent.filter((s) => s.method === 'DELETE')).toEqual([{ path: '/api/projects/p1', method: 'DELETE', body: { confirm: 'todo-list' } }])
  // Deleted: the card is gone (the dialog animates out).
  expect(screen.queryByRole('button', { name: 'Actions for todo-list' })).toBeNull()
})

it('asks for the password when the sign-in is too old, then deletes', async () => {
  deleteAnswers = [
    {
      status: 403,
      body: {
        success: false,
        code: 'REAUTH_REQUIRED',
        error: 'Deleting this project needs a sign-in from the last 10 minutes. Sign in again, then delete it.',
        reauth: { email: 'owner@example.test', password: true, provider: null },
      },
    },
    { status: 200, body: { success: true } },
  ]
  const dialog = await openDelete()
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'todo-list' } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' })) })
  await settle()

  expect(within(dialog).getByText('Deleting needs a sign-in from the last 10 minutes.')).toBeInTheDocument()
  fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'correct horse' } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm password' })) })
  await settle()

  const login = sent.find((s) => s.path === '/api/auth/login')
  expect(login?.body).toEqual({ email: 'owner@example.test', password: 'correct horse' })
  expect(sent.filter((s) => s.method === 'DELETE')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Actions for todo-list' })).toBeNull()
})
