/**
 * @jest-environment jsdom
 */
/**
 * A project that has not loaded, or could not load, is never shown as a
 * project with nothing in it.
 *
 * Production QA (2026-11-09): Connect → Direct said "API base URL: —" while
 * Settings showed https://backenly.com/api/v1/<id>. Both read the same field
 * from the same route; Connect showed "—" while the project was still loading,
 * and kept it for good when the request failed, which is what the server's
 * "this region has no API address" looks like. Settings had the same gap one
 * step further on: after a failed load it drew the form for an empty project,
 * and "Delete project" matched the empty confirmation box against the missing
 * name, so it was enabled before anything was typed.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import ProjectConnectPage from '@/app/app/projects/[id]/connect/page'
import ProjectSettingsPage from '@/app/app/projects/[id]/settings/page'

let projectId = ''
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: projectId }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))
// The tabs' other panels load their own data; this file is about the project.
jest.mock('@/lib/hooks/useAgentConnection', () => ({ useAgentConnection: () => ({ status: 'ready', connected: false }) }))
jest.mock('@/components/connect/AgentInstallGuide', () => ({ AgentInstallGuide: () => null, AgentCapabilitiesCard: () => null }))
jest.mock('@/components/connect/AgentKeysPanel', () => ({ AgentKeysPanel: () => null }))
jest.mock('@/components/connect/FrontendRuntimePanel', () => ({ FrontendRuntimeCards: () => null }))
jest.mock('@/components/connect/DirectDatabasePanel', () => ({ DirectDatabasePanel: () => null }))
jest.mock('@/components/hub/ClientKeysPanel', () => ({ ClientKeysPanel: () => null }))

type Answer = 'pending' | 'fail' | { apiBaseUrl: string | null }
let answers: Answer[] = []
let projectRequests = 0

const project = (apiBaseUrl: string | null) => ({
  id: projectId,
  name: 'shopqa',
  description: null,
  userId: 'u1',
  environment: 'production',
  region: null,
  apiBaseUrl,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

beforeEach(() => {
  answers = []
  projectRequests = 0
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    if (path === `/api/projects/${projectId}`) {
      projectRequests++
      const answer = answers.shift() ?? 'pending'
      if (answer === 'pending') return new Promise<Response>(() => {})
      if (answer === 'fail') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ success: false, error: 'Failed to fetch project' }) } as Response)
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: project(answer.apiBaseUrl) }) } as Response)
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ success: false }) } as Response)
  }) as unknown as typeof fetch
})

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

/** The "API base URL" row's value. */
function baseUrlRow() {
  const label = screen.getByText('API base URL')
  return label.parentElement!.querySelector('dd') as HTMLElement
}

async function openDirect(id: string) {
  projectId = id
  window.history.replaceState(null, '', `/app/projects/${id}/connect?tab=direct`)
  render(<ProjectConnectPage />)
  await settle()
}

describe('Connect → Direct', () => {
  it('does not say there is no address while the project is still loading', async () => {
    answers = ['pending']
    await openDirect('p-loading')
    const row = baseUrlRow()
    expect(within(row).queryByText('—')).toBeNull()
    expect(row.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  it('says the address could not be loaded, and loads it again on request', async () => {
    const url = 'https://backenly.com/api/v1/p-failed'
    answers = ['fail', { apiBaseUrl: url }]
    await openDirect('p-failed')
    const row = baseUrlRow()
    expect(within(row).queryByText('—')).toBeNull()
    expect(within(row).getByRole('alert')).toHaveTextContent('Couldn’t load the URL.')

    fireEvent.click(within(row).getByRole('button', { name: 'Try again' }))
    await settle()
    expect(projectRequests).toBe(2)
    expect(within(baseUrlRow()).getByText(url)).toBeInTheDocument()
  })

  it('shows "—" only when the server says the project has no address', async () => {
    answers = [{ apiBaseUrl: null }]
    await openDirect('p-none')
    expect(within(baseUrlRow()).getByText('—')).toBeInTheDocument()
  })
})

describe('Settings → General', () => {
  it('does not draw an empty project, or offer to delete it, when the project could not be loaded', async () => {
    projectId = 'p-settings'
    window.history.replaceState(null, '', `/app/projects/${projectId}/settings`)
    answers = ['fail', { apiBaseUrl: 'https://backenly.com/api/v1/p-settings' }]
    render(<ProjectSettingsPage />)
    await settle()

    expect(screen.queryByRole('button', { name: /Delete project/ })).toBeNull()
    expect(screen.queryByText('API base URL')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load this project’s settings.')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(projectRequests).toBe(2)
    // Loaded, the danger zone asks for the name again.
    expect(screen.getByRole('button', { name: /Delete project/ })).toBeDisabled()
    expect(within(baseUrlRow()).getByText('https://backenly.com/api/v1/p-settings')).toBeInTheDocument()
  })
})
