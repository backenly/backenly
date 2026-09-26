/**
 * The Getting Started guide's rules, held to the evidence each step names.
 *
 * Pure: these exercise lib/onboarding/guide.ts on constructed facts. What the
 * facts are read FROM (keys, recorded calls, tables, publishes, autonomy
 * passes) is proven against a real database in
 * tests/integration/onboarding-guide.spec.ts.
 */

import {
  deriveGuide,
  GUIDE_INTRODUCED_AT,
  guideAudience,
  isGuideVisible,
  selectFocusProject,
  STEP_IDS,
  unreportedCompletions,
  type GuideFacts,
  type GuideProgress,
  type McpCallFact,
  type ProjectFact,
  type StepId,
} from '@/lib/onboarding/guide'
import { guidePollMs } from '@/components/onboarding/poll'
import { ago } from '@/components/onboarding/time'

const T0 = '2026-10-01T10:00:00.000Z'

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

function facts(projects: ProjectFact[], lastCall: McpCallFact | null = null): GuideFacts {
  return { projects, lastCall }
}

const status = (g: GuideProgress, id: StepId) => g.steps.find((s) => s.id === id)!.status

const call = (over: Partial<McpCallFact> = {}): McpCallFact => ({
  tool: 'read_backend_state',
  endpoint: '/api/mcp/tool',
  statusCode: 200,
  at: T0,
  error: null,
  ...over,
})

describe('deriveGuide', () => {
  it('a brand-new account has only its account done, and starts at creating a project', () => {
    const g = deriveGuide(facts([]))
    expect(g.steps.map((s) => s.id)).toEqual([...STEP_IDS])
    expect(status(g, 'account')).toBe('done')
    expect(g.steps.filter((s) => s.id !== 'account').every((s) => s.status === 'todo')).toBe(true)
    expect(g.completed).toBe(1)
    expect(g.total).toBe(7)
    expect(g.currentStepId).toBe('project')
    expect(g.focus).toBeNull()
    expect(g.allDone).toBe(false)
  })

  it('an existing project completes the project step and moves on to the MCP key', () => {
    const g = deriveGuide(facts([project()]))
    expect(status(g, 'project')).toBe('done')
    expect(g.currentStepId).toBe('mcp_key')
    expect(g.focus?.id).toBe('p1')
  })

  it('a minted key with no recorded call is waiting, not connected', () => {
    const g = deriveGuide(facts([project({ mcpKeys: 1 })]))
    expect(status(g, 'mcp_key')).toBe('done')
    expect(status(g, 'agent')).toBe('waiting')
    expect(g.currentStepId).toBe('agent')
    expect(g.failingCall).toBeNull()
  })

  it('an OAuth connection counts as the way in, with no key', () => {
    const g = deriveGuide(facts([project({ oauthConnections: 1 })]))
    expect(status(g, 'mcp_key')).toBe('done')
    expect(status(g, 'agent')).toBe('waiting')
  })

  it('connection is complete only on a recorded successful call', () => {
    const g = deriveGuide(facts([project({ mcpKeys: 1, lastAgentCallAt: T0 })], call()))
    expect(status(g, 'agent')).toBe('done')
    expect(g.currentStepId).toBe('backend')
  })

  it('an agent whose calls all fail is flagged, with the call that failed', () => {
    const failed = call({ statusCode: 403, error: 'This key is read-only' })
    const g = deriveGuide(facts([project({ mcpKeys: 1 })], failed))
    expect(status(g, 'agent')).toBe('failed')
    expect(g.failingCall).toEqual(failed)
  })

  it('one failed call after a working one is not a broken connection', () => {
    const g = deriveGuide(facts([project({ mcpKeys: 1, lastAgentCallAt: T0 })], call({ statusCode: 500 })))
    expect(status(g, 'agent')).toBe('done')
    expect(g.failingCall).toBeNull()
  })

  it('a key revoked after connecting takes the steps back: the evidence is gone', () => {
    // Revoking deletes the key row, and its usage rows cascade with it, so the
    // facts for a revoked key look exactly like never having had one.
    const g = deriveGuide(facts([project({ built: true })]))
    expect(status(g, 'mcp_key')).toBe('todo')
    expect(status(g, 'agent')).toBe('todo')
    expect(g.currentStepId).toBe('mcp_key')
  })

  it('a later step done first is shown as done, without faking the earlier ones', () => {
    // Tables built in the Database section, before any agent was connected.
    const g = deriveGuide(facts([project({ built: true, lastCheckedAt: T0 })]))
    expect(status(g, 'backend')).toBe('done')
    expect(status(g, 'watching')).toBe('done')
    expect(status(g, 'mcp_key')).toBe('todo')
    expect(status(g, 'agent')).toBe('todo')
    expect(g.currentStepId).toBe('mcp_key')
    expect(g.completed).toBe(4)
  })

  describe('publish', () => {
    const built = { mcpKeys: 1, lastAgentCallAt: T0, built: true }

    it('is in progress while the project is deploying', () => {
      expect(status(deriveGuide(facts([project({ ...built, status: 'DEPLOYING' })])), 'publish')).toBe('in_progress')
    })

    it('failed is reported as failed, never as done', () => {
      const g = deriveGuide(facts([project({ ...built, status: 'FAILED', deploymentError: 'Readiness check failed' })]))
      expect(status(g, 'publish')).toBe('failed')
      expect(g.focus?.deploymentError).toBe('Readiness check failed')
      expect(g.allDone).toBe(false)
    })

    it('is done once a project is LIVE', () => {
      expect(status(deriveGuide(facts([project({ ...built, status: 'LIVE', deployedAt: T0 })])), 'publish')).toBe('done')
    })
  })

  describe('watching', () => {
    it('waits for the first autonomy pass once something is built', () => {
      expect(status(deriveGuide(facts([project({ built: true })])), 'watching')).toBe('waiting')
    })

    it('does not count a check on a project with nothing built', () => {
      expect(status(deriveGuide(facts([project({ lastCheckedAt: T0 })])), 'watching')).toBe('todo')
    })
  })

  it('everything done is all done, with no current step', () => {
    const g = deriveGuide(
      facts(
        [project({ status: 'LIVE', deployedAt: T0, mcpKeys: 1, lastAgentCallAt: T0, built: true, lastCheckedAt: T0 })],
        call(),
      ),
    )
    expect(g.allDone).toBe(true)
    expect(g.currentStepId).toBeNull()
    expect(g.completed).toBe(g.total)
  })

  it('steps are complete when ANY visible project proves them', () => {
    const g = deriveGuide(
      facts([
        project({ id: 'a', createdAt: '2026-10-02T00:00:00.000Z' }),
        project({ id: 'b', mcpKeys: 1, lastAgentCallAt: T0 }),
      ]),
    )
    expect(status(g, 'agent')).toBe('done')
    expect(g.focus?.id).toBe('b')
  })
})

describe('selectFocusProject', () => {
  it('points at the project furthest along, not the newest empty one', () => {
    const empty = project({ id: 'new', createdAt: '2026-10-05T00:00:00.000Z' })
    const working = project({ id: 'old', createdAt: '2026-10-01T00:00:00.000Z', built: true })
    expect(selectFocusProject([empty, working])?.id).toBe('old')
  })

  it('prefers a live, built project over one only built', () => {
    const built = project({ id: 'built', built: true, createdAt: '2026-10-05T00:00:00.000Z' })
    const live = project({ id: 'live', built: true, status: 'LIVE' })
    expect(selectFocusProject([built, live])?.id).toBe('live')
  })

  it('breaks a tie by recency', () => {
    const older = project({ id: 'older', createdAt: '2026-10-01T00:00:00.000Z' })
    const newer = project({ id: 'newer', createdAt: '2026-10-03T00:00:00.000Z' })
    expect(selectFocusProject([older, newer])?.id).toBe('newer')
  })

  it('is null with no projects', () => {
    expect(selectFocusProject([])).toBeNull()
  })
})

describe('who sees the guide', () => {
  const before = '2026-01-01T00:00:00.000Z'
  const after = new Date(Date.parse(GUIDE_INTRODUCED_AT) + 86_400_000).toISOString()

  it('an account that had a project before the guide existed is an existing user', () => {
    expect(guideAudience(before, [before])).toBe('existing')
  })

  it('an older account that never made a project is new', () => {
    expect(guideAudience(before, [])).toBe('new')
  })

  it('an older account whose first project came after the guide is new, and stays new', () => {
    // Its own first project must not flip it to "existing" halfway through.
    expect(guideAudience(before, [after])).toBe('new')
  })

  it('an account created after the guide is new, even with a teammate’s older project', () => {
    expect(guideAudience(after, [before])).toBe('new')
  })

  const none = { startedAt: null, dismissedAt: null, reopenedAt: null }

  it('shows to new accounts and not to existing ones', () => {
    expect(isGuideVisible(none, 'new')).toBe(true)
    expect(isGuideVisible(none, 'existing')).toBe(false)
  })

  it('hiding wins, for everyone', () => {
    expect(isGuideVisible({ ...none, dismissedAt: T0 }, 'new')).toBe(false)
    expect(isGuideVisible({ ...none, dismissedAt: T0, reopenedAt: T0 }, 'existing')).toBe(false)
  })

  it('reopening shows it, even to an existing account', () => {
    expect(isGuideVisible({ ...none, reopenedAt: T0 }, 'existing')).toBe(true)
  })
})

describe('unreportedCompletions', () => {
  it('reports each finished step once, and never the account step', () => {
    const g = deriveGuide(facts([project({ mcpKeys: 1 })]))
    expect(unreportedCompletions(g, [])).toEqual(['project', 'mcp_key'])
    expect(unreportedCompletions(g, ['project'])).toEqual(['mcp_key'])
    expect(unreportedCompletions(g, ['project', 'mcp_key'])).toEqual([])
  })
})

describe('guidePollMs', () => {
  it('polls fast only while a step on screen is waiting on evidence', () => {
    const waiting = deriveGuide(facts([project({ mcpKeys: 1 })]))
    expect(guidePollMs(waiting, true)).toBe(5_000)
    expect(guidePollMs(waiting, false)).toBe(30_000)
  })

  it('does not poll fast for a step only the user can do', () => {
    expect(guidePollMs(deriveGuide(facts([project()])), true)).toBe(30_000)
  })

  it('slows right down once everything is done', () => {
    const done = deriveGuide(
      facts([project({ status: 'LIVE', mcpKeys: 1, lastAgentCallAt: T0, built: true, lastCheckedAt: T0 })]),
    )
    expect(guidePollMs(done, true)).toBe(60_000)
    expect(guidePollMs(null, true)).toBe(60_000)
  })
})

describe('ago', () => {
  const now = Date.parse(T0)
  it('reads like a person would say it', () => {
    expect(ago(T0, now + 10_000)).toBe('just now')
    expect(ago(T0, now + 5 * 60_000)).toBe('5m ago')
    expect(ago(T0, now + 3 * 3_600_000)).toBe('3h ago')
    expect(ago(T0, now + 2 * 86_400_000)).toBe('2d ago')
    expect(ago(null, now)).toBe('')
  })
})
