/**
 * @jest-environment jsdom
 */

/**
 * The project console's shell (project console decisions, 2026-11-16).
 *
 * - The project switcher lists only the open project's team, glyph first,
 *   with words only for Paused, Deploying and Failed, a search field from six
 *   projects, and "New project" into the team's create flow.
 * - The team crumb and plan are the project's own team, not the one the
 *   browser last remembered.
 * - The sidebar: Overview, Connect, Build, Operate, Settings at the foot; no
 *   MCP tag, no Functions count, no "Frontend · Not connected" row.
 * - The welcome-back row: one sentence that never calls an unconfirmed change
 *   a fix, hidden on Overview.
 * - The assistant's header, and Escape.
 * - useProjectRole and useWaitingCount: one request and one poll however many
 *   surfaces ask, and a failure never reads as "nothing" or as permission.
 *
 * These render the real components against answers shaped like the routes'.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { forgetSharedReads } from '@/lib/client/shared-read'
import { forgetProjectReads, getProject } from '@/lib/api/projects'
import { clearAgentConnectionCache } from '@/lib/hooks/useAgentConnection'
import { clearProjectRoleCache, parseProjectRole, useProjectRole } from '@/lib/hooks/useProjectRole'
import { clearWaitingCountCache, useWaitingCount, waitingFromHealth, WAITING_POLL_MS } from '@/lib/hooks/useWaitingCount'
import { TopBar } from '@/components/shell/TopBar'
import { useScopedOrgId } from '@/components/shell/ConsoleChrome'
import { ProjectSidebar } from '@/components/shell/ProjectSidebar'
import AutonomyWelcomeBackBanner, { welcomeBackLine } from '@/components/autonomy/AutonomyWelcomeBackBanner'
import { AssistantPanel } from '@/components/assistant/AssistantPanel'
import { useAssistantStore } from '@/lib/stores/use-assistant-store'

// Organizations are Backenly Cloud's: the switcher's "New project" and the
// team scope only exist there.
jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
// ESM-only packages jest does not transform; the assistant's answers are not under test.
jest.mock('react-markdown', () => ({ __esModule: true, default: ({ children }: { children: string }) => children }))
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }))

const push = jest.fn()
let pathname = '/app/projects/p1/database'
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ id: 'p1' }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}))

const project = (id: string, name: string, organizationId: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  organizationId,
  projectStatus: 'LIVE',
  pausedAt: null,
  ...extra,
})

const TEAM = [
  project('p1', 'shop', 'org_team'),
  project('p2', 'blog', 'org_team', { projectStatus: 'PRIVATE' }),
  project('p3', 'archive', 'org_team', { pausedAt: '2026-11-01T00:00:00.000Z' }),
  project('p4', 'release', 'org_team', { projectStatus: 'DEPLOYING' }),
  project('p5', 'broken', 'org_team', { projectStatus: 'FAILED' }),
]
const ELSEWHERE = project('x1', 'another team’s app', 'org_other')

let list: unknown[] = [...TEAM, ELSEWHERE]
let health: Record<string, unknown> | null = { needsAttention: 0, agentApprovalsPending: 0, architectureRequestsPending: 0, findings: [] }
let projectAnswer: Record<string, unknown> | null = { ...TEAM[0], role: 'OWNER', canWrite: true, canAdminister: true }
let sinceLastVisit: Record<string, unknown> = { autonomousFixes: 0, unverifiedChanges: 0, escalations: 0, total: 0, shouldShow: false }

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function answer(url: string): Response {
  const path = url.split('?')[0]
  if (path === '/api/projects') return json(200, { success: true, data: list })
  if (path === '/api/projects/p1') {
    return projectAnswer ? json(200, { success: true, data: projectAnswer }) : json(404, { success: false, error: 'Project not found or access denied' })
  }
  if (path === '/api/projects/p1/health') return health ? json(200, { success: true, data: health }) : json(500, { error: 'down' })
  if (path === '/api/projects/p1/mcp/status') return json(200, { connected: true, active: true, lastSeenAt: new Date().toISOString(), client: 'Claude Code' })
  if (path === '/api/projects/p1/autonomy/since-last-visit') return json(200, sinceLastVisit)
  if (path === '/api/auth/me') return json(200, { user: { name: 'Ada Lovelace', email: 'ada@example.com' } })
  if (path === '/api/org/list') {
    return json(200, {
      success: true,
      orgs: [
        { id: 'org_mine', name: 'Ada’s team', role: 'OWNER', personal: true, owned: true, projectCount: 1, memberCount: 1 },
        { id: 'org_team', name: 'Northwind', role: 'ADMIN', personal: false, owned: false, projectCount: 5, memberCount: 4 },
      ],
    })
  }
  if (path === '/api/org/invites/mine') return json(200, { success: true, data: { invites: [] } })
  if (path === '/api/billing/current') return json(200, { displayName: 'Pro', subscriptionStatus: 'ACTIVE' })
  return json(404, {})
}

const fetchMock = jest.fn((input: RequestInfo | URL) => Promise.resolve(answer(String(input))))
const calls = (path: string) => fetchMock.mock.calls.filter(([u]) => String(u).split('?')[0] === path).length

async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

/** Lets a requestAnimationFrame step run (focus moves on the next frame). */
async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

/** What a sighted person reads: the text without what is there for screen readers only. */
function visibleText(el: Element): string {
  const copy = el.cloneNode(true) as Element
  copy.querySelectorAll('.sr-only').forEach((n) => n.remove())
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}

beforeAll(() => {
  // jsdom lays nothing out: no scrolling to call.
  Element.prototype.scrollTo = jest.fn() as unknown as typeof Element.prototype.scrollTo
})

beforeEach(() => {
  push.mockReset()
  fetchMock.mockClear()
  global.fetch = fetchMock as unknown as typeof fetch
  forgetSharedReads()
  forgetProjectReads()
  clearAgentConnectionCache()
  clearProjectRoleCache()
  clearWaitingCountCache()
  localStorage.clear()
  pathname = '/app/projects/p1/database'
  list = [...TEAM, ELSEWHERE]
  health = { needsAttention: 0, agentApprovalsPending: 0, architectureRequestsPending: 0, findings: [] }
  projectAnswer = { ...TEAM[0], role: 'OWNER', canWrite: true, canAdminister: true }
  sinceLastVisit = { autonomousFixes: 0, unverifiedChanges: 0, escalations: 0, total: 0, shouldShow: false }
})

// ── The project switcher ─────────────────────────────────────────────────────

describe('the project switcher', () => {
  async function openSwitcher() {
    render(<TopBar />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }))
    await settle()
    return screen.getByRole('menu', { name: 'Projects' })
  }
  const item = (menu: HTMLElement, name: string) =>
    within(menu).getAllByRole('menuitem').find((el) => visibleText(el).startsWith(name))!

  it('names the open project in the bar, led by its glyph', async () => {
    render(<TopBar />)
    await settle()
    expect(screen.getByRole('button', { name: /Switch project/ })).toHaveAccessibleName('Project: shop, live. Switch project')
  })

  it("lists only this team's projects", async () => {
    const menu = await openSwitcher()
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((el) => visibleText(el))
      .filter((t) => !['All projects', 'New project'].includes(t))
    expect(names.map((t) => t.replace(/(Paused|Deploying|Failed)$/, ''))).toEqual(['shop', 'blog', 'archive', 'release', 'broken'])
    expect(within(menu).queryByText('another team’s app')).toBeNull()
  })

  it('writes words only for Paused, Deploying and Failed', async () => {
    const menu = await openSwitcher()
    expect(visibleText(item(menu, 'shop'))).toBe('shop')
    expect(visibleText(item(menu, 'blog'))).toBe('blog')
    expect(visibleText(item(menu, 'archive'))).toBe('archivePaused')
    expect(visibleText(item(menu, 'release'))).toBe('releaseDeploying')
    expect(visibleText(item(menu, 'broken'))).toBe('brokenFailed')
    // The glyph still tells a screen reader what the words leave out.
    expect(item(menu, 'blog')).toHaveTextContent('Not published')
  })

  it('has no search field under six projects', async () => {
    const menu = await openSwitcher()
    expect(within(menu.parentElement!).queryByRole('searchbox')).toBeNull()
  })

  it('offers a search field from six projects, and Enter opens the first match', async () => {
    list = [...TEAM, project('p6', 'analytics', 'org_team'), ELSEWHERE]
    const menu = await openSwitcher()
    await nextFrame()
    const field = screen.getByRole('searchbox', { name: 'Find a project' })
    expect(field).toHaveFocus()
    fireEvent.change(field, { target: { value: 'arch' } })
    const shown = within(menu).getAllByRole('menuitem').map((el) => visibleText(el))
    expect(shown).toEqual(['archivePaused', 'All projects', 'New project'])
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(push).toHaveBeenCalledWith('/app/projects/p3')
  })

  it("opens the team's own Projects page, and its create flow for New project", async () => {
    let menu = await openSwitcher()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New project' }))
    expect(push).toHaveBeenLastCalledWith('/app/org/org_team?new=1')

    fireEvent.click(screen.getByRole('button', { name: /Switch project/ }))
    await settle()
    menu = screen.getByRole('menu', { name: 'Projects' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'All projects' }))
    expect(push).toHaveBeenLastCalledWith('/app/org/org_team')
  })
})

// ── The team in scope ────────────────────────────────────────────────────────

describe("the bar's team", () => {
  function Scope() {
    const orgId = useScopedOrgId()
    return <p data-testid="scope">{orgId === undefined ? 'waiting' : String(orgId)}</p>
  }

  it("is the project's own team, not the one the browser remembered", async () => {
    localStorage.setItem('backenly.activeOrgId', 'org_mine')
    render(<Scope />)
    // Nothing is asked for a team until the project's own is known.
    expect(screen.getByTestId('scope')).toHaveTextContent('waiting')
    await settle()
    expect(screen.getByTestId('scope')).toHaveTextContent('org_team')
  })

  it('becomes the remembered team, so the switcher and /app follow it, and the plan is its own', async () => {
    localStorage.setItem('backenly.activeOrgId', 'org_mine')
    render(<TopBar />)
    await settle()
    await settle()
    expect(localStorage.getItem('backenly.activeOrgId')).toBe('org_team')
    // Never the remembered team's plan, nor the person's own.
    const plans = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/billing/current'))
    expect(plans.every((u) => u === '/api/billing/current?orgId=org_team')).toBe(true)
  })

  it('leaves the remembered team alone when the project has none', async () => {
    projectAnswer = { ...TEAM[0], organizationId: null, role: 'OWNER', canWrite: true, canAdminister: true }
    localStorage.setItem('backenly.activeOrgId', 'org_mine')
    render(<TopBar />)
    await settle()
    expect(localStorage.getItem('backenly.activeOrgId')).toBe('org_mine')
  })
})

// ── The sidebar ──────────────────────────────────────────────────────────────

describe('the sidebar', () => {
  it('lists Overview and Connect, then Build and Operate, with Settings at the foot', async () => {
    render(<ProjectSidebar />)
    await settle()
    const order = Array.from(document.querySelectorAll('[data-tour^="nav-"]'))
      .map((el) => el.getAttribute('data-tour'))
      // Branches is Cloud's, and present only in a composed build.
      .filter((id) => id !== 'nav-branches')
    expect(order).toEqual([
      'nav-overview',
      'nav-connect',
      'nav-database',
      'nav-auth',
      'nav-storage',
      'nav-functions',
      'nav-realtime',
      'nav-webhooks',
      'nav-integrations',
      'nav-autonomy',
      'nav-monitoring',
      'nav-history',
      'nav-deploy',
      'nav-settings',
    ])
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(screen.getByText('Operate')).toBeInTheDocument()
  })

  it('carries no MCP tag, no counts and no frontend row, and polls for neither', async () => {
    render(<ProjectSidebar />)
    await settle()
    expect(screen.queryByText('MCP')).toBeNull()
    expect(screen.queryByText('Frontend')).toBeNull()
    expect(document.querySelector('nav')?.textContent).not.toMatch(/\d/)
    expect(calls('/api/projects/p1/ai-functions')).toBe(0)
    expect(calls('/api/projects/p1/connection-health')).toBe(0)
  })
})

// ── The welcome-back row ─────────────────────────────────────────────────────

describe('the welcome-back row', () => {
  it.each([
    [{ autonomousFixes: 3, unverifiedChanges: 0, escalations: 0 }, 'While you were away Backenly made 3 fixes, all verified.'],
    [{ autonomousFixes: 1, unverifiedChanges: 0, escalations: 0 }, 'While you were away Backenly made 1 fix, verified.'],
    [
      { autonomousFixes: 2, unverifiedChanges: 1, escalations: 0 },
      'While you were away Backenly made 2 fixes it verified and 1 change it could not confirm.',
    ],
    [{ autonomousFixes: 0, unverifiedChanges: 2, escalations: 0 }, 'While you were away Backenly made 2 changes it could not confirm.'],
    [
      { autonomousFixes: 3, unverifiedChanges: 0, escalations: 1 },
      'While you were away Backenly made 3 fixes, all verified, and flagged 1 problem for your review.',
    ],
    [{ autonomousFixes: 0, unverifiedChanges: 0, escalations: 0 }, null],
  ])('says %j as %j', (counts, line) => {
    expect(welcomeBackLine(counts)).toBe(line)
  })

  it('is one row with a Review link to Autonomy and a way to dismiss it', async () => {
    sinceLastVisit = { autonomousFixes: 3, unverifiedChanges: 0, escalations: 0, total: 3, shouldShow: true }
    render(<AutonomyWelcomeBackBanner />)
    await settle()
    const row = screen.getByRole('status')
    expect(visibleText(row)).toBe('While you were away Backenly made 3 fixes, all verified. Review')
    expect(within(row).getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/app/projects/p1/autonomy')
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(localStorage.getItem('backenly:autonomy:lastseen:p1')).not.toBeNull()
  })

  it.each([
    ['Overview', '/app/projects/p1'],
    ['Autonomy', '/app/projects/p1/autonomy'],
  ])('is not shown on %s, which lists those changes itself', async (_page, path) => {
    pathname = path
    sinceLastVisit = { autonomousFixes: 3, unverifiedChanges: 0, escalations: 0, total: 3, shouldShow: true }
    render(<AutonomyWelcomeBackBanner />)
    await settle()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

// ── The assistant ────────────────────────────────────────────────────────────

describe('the assistant', () => {
  afterEach(() => {
    act(() => useAssistantStore.setState({ open: false }))
  })

  it('is headed "Assistant" with Backenly’s own mark (no sparkle) and no machine label, and Escape closes it', async () => {
    act(() => useAssistantStore.setState({ projectId: 'p1', open: true }))
    render(<AssistantPanel />)
    const panel = screen.getByRole('complementary', { name: 'Assistant' })
    expect(within(panel).getByRole('heading', { name: 'Assistant' })).toBeInTheDocument()
    expect(within(panel).queryByText('answers only')).toBeNull()
    expect(panel.querySelector('.font-mono')).toBeNull()
    // The founder's call (2026-11-16): the ✦ sparkle read as a generic "AI" symbol; the header carries Backenly's tile.
    expect(panel.querySelector('img[src="/backenly-icon-hd.svg"]')).not.toBeNull()
    expect(panel.querySelector('svg.text-violet-300')).toBeNull()
    fireEvent.keyDown(within(panel).getByRole('textbox', { name: 'Ask the assistant' }), { key: 'Escape' })
    expect(useAssistantStore.getState().open).toBe(false)
  })
})

// ── The hooks ────────────────────────────────────────────────────────────────

describe('useProjectRole', () => {
  function Role({ label }: { label: string }) {
    const role = useProjectRole('p1')
    return <p data-testid={label}>{role.loading ? 'loading' : `${role.role ?? 'none'} write:${role.canWrite} admin:${role.canAdminister} team:${role.organizationId}`}</p>
  }

  it("reads the server's answer once, shared with the page's own read of the project", async () => {
    projectAnswer = { ...TEAM[0], role: 'DEVELOPER', canWrite: true, canAdminister: false }
    render(
      <>
        <Role label="a" />
        <Role label="b" />
      </>,
    )
    await act(async () => {
      await getProject('p1')
    })
    await settle()
    expect(screen.getByTestId('a')).toHaveTextContent('DEVELOPER write:true admin:false team:org_team')
    expect(screen.getByTestId('b')).toHaveTextContent('DEVELOPER write:true admin:false team:org_team')
    expect(calls('/api/projects/p1')).toBe(1)
  })

  it('grants nothing when the project cannot be read', async () => {
    projectAnswer = null
    render(<Role label="a" />)
    await settle()
    expect(screen.getByTestId('a')).toHaveTextContent('none write:false admin:false team:null')
  })

  it('takes the floors from the server, and grants nothing to an answer with no role', () => {
    expect(parseProjectRole({ role: 'VIEWER', canWrite: false, canAdminister: false, organizationId: 'org_1' })).toMatchObject({
      role: 'VIEWER',
      canWrite: false,
      canAdminister: false,
      organizationId: 'org_1',
      error: false,
    })
    expect(parseProjectRole({ canWrite: true, canAdminister: true } as never)).toMatchObject({
      role: null,
      canWrite: false,
      canAdminister: false,
      error: true,
    })
  })
})

describe('useWaitingCount', () => {
  function Waiting({ label }: { label: string }) {
    const w = useWaitingCount('p1')
    return <p data-testid={label}>{w.total === null ? (w.error ? 'unknown' : 'loading') : `${w.total} (${w.held}/${w.agentCalls}/${w.architecture})${w.error ? ' stale' : ''}`}</p>
  }

  it('adds the three queues, counting held findings from the uncapped total', () => {
    expect(waitingFromHealth({ needsAttention: 60, findings: [], agentApprovalsPending: 2, architectureRequestsPending: 1 })).toEqual({
      held: 60,
      agentCalls: 2,
      architecture: 1,
      total: 63,
    })
    // A server from before needsAttention: the preview's held rows.
    expect(waitingFromHealth({ findings: [{ status: 'pending_approval' }, { status: 'open' }] })).toEqual({
      held: 1,
      agentCalls: 0,
      architecture: 0,
      total: 1,
    })
    expect(waitingFromHealth(null)).toBeNull()
  })

  describe('over time', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('reads once and polls once every 30 s for every surface that asks', async () => {
      health = { needsAttention: 1, agentApprovalsPending: 1, architectureRequestsPending: 0 }
      render(
        <>
          <Waiting label="inbox" />
          <Waiting label="overview" />
        </>,
      )
      await settle()
      expect(calls('/api/projects/p1/health')).toBe(1)
      expect(screen.getByTestId('inbox')).toHaveTextContent('2 (1/1/0)')
      expect(screen.getByTestId('overview')).toHaveTextContent('2 (1/1/0)')

      await act(async () => {
        jest.advanceTimersByTime(WAITING_POLL_MS)
      })
      await settle()
      expect(calls('/api/projects/p1/health')).toBe(2)
    })

    it('keeps the last count when a read fails, rather than reading as nothing waiting', async () => {
      health = { needsAttention: 0, agentApprovalsPending: 3, architectureRequestsPending: 0 }
      render(<Waiting label="inbox" />)
      await settle()
      expect(screen.getByTestId('inbox')).toHaveTextContent('3 (0/3/0)')

      health = null
      await act(async () => {
        jest.advanceTimersByTime(WAITING_POLL_MS)
      })
      await settle()
      expect(screen.getByTestId('inbox')).toHaveTextContent('3 (0/3/0) stale')
    })

    it('says it does not know, before any count, when the first read fails', async () => {
      health = null
      render(<Waiting label="inbox" />)
      await settle()
      expect(screen.getByTestId('inbox')).toHaveTextContent('unknown')
    })

    it('stops polling when the last surface leaves', async () => {
      const { unmount } = render(<Waiting label="inbox" />)
      await settle()
      unmount()
      await act(async () => {
        jest.advanceTimersByTime(WAITING_POLL_MS * 3)
      })
      expect(calls('/api/projects/p1/health')).toBe(1)
    })
  })
})
