/**
 * @jest-environment jsdom
 */

/**
 * The Getting Started guide as a user sees it: each step state renders what
 * the evidence says, finishing is explicit, and hiding survives a server that
 * cannot save it yet.
 *
 * Progress is built with the real deriveGuide, so a state rendered here is a
 * state the server can actually produce. Only the router and fetch are stood
 * in for; there is no database in this file.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { deriveGuide, type GuideState, type McpCallFact, type ProjectFact } from '@/lib/onboarding/guide'
import { useGuideStore } from '@/lib/stores/use-guide-store'
import { GuidePanel } from '@/components/onboarding/GuidePanel'
import { AgentConnectionStatus } from '@/components/onboarding/AgentConnectionStatus'
import { GettingStartedWelcome } from '@/components/onboarding/GettingStartedCard'

const push = jest.fn()
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const T0 = new Date(Date.now() - 5 * 60_000).toISOString()

function project(over: Partial<ProjectFact> = {}): ProjectFact {
  return {
    id: 'p1',
    name: 'Notes',
    createdAt: T0,
    status: 'PRIVATE',
    deployedAt: null,
    deploymentError: null,
    mcpKeys: 0,
    oauthConnections: 0,
    lastAgentCallAt: null,
    built: false,
    lastCheckedAt: null,
    ...over,
  }
}

const guide = (projects: ProjectFact[], lastCall: McpCallFact | null = null) => deriveGuide({ projects, lastCall })

function stateOf(progress: ReturnType<typeof guide> | null, over: Partial<GuideState> = {}): GuideState {
  return { visible: !!progress, audience: 'new', savable: true, progress, ...over }
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  push.mockReset()
  global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
  useGuideStore.setState({
    state: null,
    status: 'idle',
    actionError: null,
    hiddenLocally: false,
    panelOpen: false,
    busy: false,
    fetchedAt: Date.now(),
    newProjectRequested: false,
  })
})

describe('GuidePanel', () => {
  it('a new account sees 1 of 7, and the project step first', () => {
    render(<GuidePanel progress={guide([])} variant="card" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
    expect(screen.getByRole('heading', { name: 'Create a project' })).toBeInTheDocument()
    // This build has no Cloud control plane: the one project comes from bootstrap.
    expect(screen.getByText('npm run bootstrap')).toBeInTheDocument()
    const current = screen.getAllByRole('listitem').find((li) => li.getAttribute('aria-current') === 'step')
    expect(current).toHaveTextContent('Create a project')
  })

  it('waiting on the agent says so, and offers the troubleshooting', () => {
    render(<GuidePanel progress={guide([project({ mcpKeys: 1 })])} variant="card" />)
    expect(screen.getByRole('heading', { name: 'Connect your coding agent' })).toBeInTheDocument()
    expect(screen.getByText(/Listening for your agent/)).toBeInTheDocument()
    expect(screen.getByText('Not connecting?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Open setup instructions/ }))
    expect(push).toHaveBeenCalledWith('/app/projects/p1/connect')
  })

  it('a failing agent shows the call that failed and why', () => {
    const failed: McpCallFact = { tool: 'apply_migration', endpoint: '/api/mcp/tool', statusCode: 403, at: T0, error: 'This key is read-only' }
    render(<GuidePanel progress={guide([project({ mcpKeys: 1 })], failed)} variant="card" />)
    expect(screen.getByText(/apply_migration returned HTTP 403/)).toBeInTheDocument()
    expect(screen.getByText('This key is read-only')).toBeInTheDocument()
  })

  it('once connected, the next step is the starter prompt, to paste into the agent', () => {
    render(<GuidePanel progress={guide([project({ mcpKeys: 1, lastAgentCallAt: T0 })])} variant="card" />)
    expect(screen.getByRole('heading', { name: 'Build your first backend' })).toBeInTheDocument()
    expect(screen.getByText('paste into your coding agent')).toBeInTheDocument()
    expect(screen.getByText(/Run it in the agent you connected, not here/)).toBeInTheDocument()
  })

  it('a failed publish shows the stored error and sends the user to Deploy', () => {
    const p = project({ mcpKeys: 1, lastAgentCallAt: T0, built: true, lastCheckedAt: T0, status: 'FAILED', deploymentError: 'Readiness check failed' })
    render(<GuidePanel progress={guide([p])} variant="card" />)
    expect(screen.getByText('Publish failed. Production is unchanged.')).toBeInTheDocument()
    expect(screen.getByText('Readiness check failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /See what failed/ }))
    expect(push).toHaveBeenCalledWith('/app/projects/p1/deploy')
  })

  it('a step can be opened out of order without being marked done', () => {
    render(<GuidePanel progress={guide([project()])} variant="card" />)
    fireEvent.click(screen.getByRole('button', { name: /See Backenly watching/ }))
    expect(screen.getByRole('heading', { name: 'See Backenly watching' })).toBeInTheDocument()
    expect(screen.getByText(/Backenly repairs the conditions it has a verified fix for/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
  })

  it('finishing is explicit, and closing it is the user’s choice', async () => {
    const done = project({ status: 'LIVE', deployedAt: T0, mcpKeys: 1, lastAgentCallAt: T0, built: true, lastCheckedAt: T0 })
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, stateOf(null, { visible: false })))
    render(<GuidePanel progress={guide([done])} variant="card" />)
    expect(screen.getByRole('heading', { name: /You.re set up\./ })).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close the guide' }))
    })
    expect(global.fetch).toHaveBeenCalledWith('/api/onboarding', expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'dismiss' }) }))
    expect(useGuideStore.getState().state?.visible).toBe(false)
  })

  it('announces a step completing to screen readers', () => {
    const { rerender } = render(<GuidePanel progress={guide([project({ mcpKeys: 1 })])} variant="card" />)
    rerender(<GuidePanel progress={guide([project({ mcpKeys: 1, lastAgentCallAt: T0 })])} variant="card" />)
    expect(screen.getByText('Coding agent connected.')).toBeInTheDocument()
  })
})

describe('hiding and reopening', () => {
  it('a hide the server cannot save yet still hides, for this session', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(503, { error: 'not yet', code: 'PREFERENCE_UNAVAILABLE' }),
    )
    useGuideStore.setState({ state: stateOf(guide([])) })
    await act(() => useGuideStore.getState().hide())
    expect(useGuideStore.getState()).toMatchObject({ hiddenLocally: true, actionError: null })
  })

  it('reopening a hidden guide asks the server, then opens it', async () => {
    const reopened = stateOf(guide([project()]))
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, reopened))
    useGuideStore.setState({ state: stateOf(null, { visible: false }), hiddenLocally: true })
    await act(() => useGuideStore.getState().open())
    expect(global.fetch).toHaveBeenCalledWith('/api/onboarding', expect.objectContaining({ body: JSON.stringify({ action: 'reopen' }) }))
    expect(useGuideStore.getState()).toMatchObject({ panelOpen: true, hiddenLocally: false, collapsed: false })
    expect(useGuideStore.getState().state?.visible).toBe(true)
  })

  it('a failed load keeps the last answer on screen', async () => {
    const shown = stateOf(guide([project()]))
    useGuideStore.setState({ state: shown, status: 'ready' })
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'))
    await act(() => useGuideStore.getState().refresh())
    expect(useGuideStore.getState()).toMatchObject({ state: shown, status: 'ready' })
  })

  it('a first load that fails is an error, not an empty guide', async () => {
    useGuideStore.setState({ status: 'idle', fetchedAt: 0 })
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'))
    await act(() => useGuideStore.getState().refresh())
    expect(useGuideStore.getState()).toMatchObject({ state: null, status: 'error' })
  })
})

describe('AgentConnectionStatus', () => {
  it('waits for the first call, then says Connected only when one was recorded', () => {
    useGuideStore.setState({ state: stateOf(guide([project({ mcpKeys: 1 })])) })
    const { rerender } = render(<AgentConnectionStatus projectId="p1" />)
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for your agent’s first call')

    act(() => useGuideStore.setState({ state: stateOf(guide([project({ mcpKeys: 1, lastAgentCallAt: T0 })])) }))
    rerender(<AgentConnectionStatus projectId="p1" />)
    expect(screen.getByRole('status')).toHaveTextContent('Your agent is connected')
    expect(screen.getByText('paste into your coding agent')).toBeInTheDocument()
  })

  it('stays out of the way on a project the guide is not about', () => {
    useGuideStore.setState({ state: stateOf(guide([project({ mcpKeys: 1 })])) })
    const { container } = render(<AgentConnectionStatus projectId="some-other-project" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('stays out of the way once the guide is hidden', () => {
    useGuideStore.setState({ state: stateOf(guide([project({ mcpKeys: 1 })])), hiddenLocally: true })
    const { container } = render(<AgentConnectionStatus projectId="p1" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('GettingStartedWelcome', () => {
  it('teaches the workflow before asking for anything', () => {
    render(<GettingStartedWelcome progress={guide([])} onCreateProject={jest.fn()} />)
    const diagram = screen.getByRole('group', { name: 'How Backenly fits into your workflow' })
    for (const node of ['Your coding agent', 'Backenly MCP', 'Your backend', 'Publish', 'Backenly watches']) {
      expect(within(diagram).getByText(node)).toBeInTheDocument()
    }
    expect(screen.getByText(/not to this dashboard/)).toBeInTheDocument()
  })
})

describe('GuidePanel, once finished', () => {
  it('a finished step can be looked at, and a second click returns to the summary', () => {
    const done = project({ status: 'LIVE', deployedAt: T0, mcpKeys: 1, lastAgentCallAt: T0, built: true, lastCheckedAt: T0 })
    render(<GuidePanel progress={guide([done])} variant="card" />)
    fireEvent.click(screen.getByRole('button', { name: /Backend published/ }))
    expect(screen.getByRole('heading', { name: 'Backend published' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Backend published/ }))
    expect(screen.getByRole('heading', { name: /You.re set up\./ })).toBeInTheDocument()
  })
})
