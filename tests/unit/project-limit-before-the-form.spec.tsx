/**
 * @jest-environment jsdom
 */
/**
 * A plan limit is said when "New project" is clicked, before the form.
 * Production QA (2026-11-09): on Free the form opened, and "Free includes 1
 * project across the organizations you own or administer" came back only
 * after the name and region were filled in.
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

function stub(canCreate: { allowed: boolean; error?: string; code?: string }) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    const body =
      path === '/api/auth/me' ? { user: { id: 'u1', email: 'owner@example.test', name: 'Owner' } }
      : path === '/api/projects/can-create' ? canCreate
      : path === '/api/projects' ? { success: true, data: [], count: 0 }
      : {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
}

async function renderAndClickNew() {
  render(<ProjectsHome />)
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  })
}

it('on a full plan, says the limit and opens no form', async () => {
  stub({ allowed: false, code: 'PLAN_LIMIT_EXCEEDED', error: LIMIT })
  await renderAndClickNew()
  expect(screen.getByText('Project limit reached')).toBeInTheDocument()
  expect(screen.getByText(LIMIT)).toBeInTheDocument()
  expect(screen.queryByText('Create a new project')).toBeNull()
  expect(screen.queryByLabelText('Project name')).toBeNull()
})

it('CONTROL: with room on the plan, opens the form', async () => {
  stub({ allowed: true })
  await renderAndClickNew()
  expect(screen.getByText('Create a new project')).toBeInTheDocument()
  expect(screen.getByLabelText('Project name')).toBeInTheDocument()
  expect(screen.queryByText('Project limit reached')).toBeNull()
})

it('CONTROL: a refusal that is not a plan limit is still said by creating, in the form', async () => {
  stub({ allowed: false, code: 'ORGANIZATION_ROLE_REQUIRED', error: 'Only owners and admins create projects here.' })
  await renderAndClickNew()
  expect(screen.getByText('Create a new project')).toBeInTheDocument()
  expect(screen.queryByText('Project limit reached')).toBeNull()
})
