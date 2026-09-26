/**
 * THE GETTING STARTED GUIDE — what is true, and what comes next
 * ==============================================================
 *
 * The guide teaches one workflow:
 *
 *   coding agent ──MCP──▶ Backenly builds the backend ──▶ publish ──▶ Backenly keeps watching it
 *
 * and every step in it is DERIVED from the product state that proves it. None
 * is ticked because someone pressed Next. A checklist that can say "Connected"
 * before an agent has ever called Backenly teaches the user to distrust the
 * rest of the console, so each rule below names its evidence:
 *
 *   account   the session exists
 *   project   a project the caller can see (the MCP key is bound to one, so it
 *             has to come first; an agent cannot create a project)
 *   mcp_key   an MCP key this user minted, or an OAuth connection they approved
 *   agent     a RECORDED successful call from one of those credentials. Only
 *             agent traffic writes ApiKeyUsage (lib/mcp/guard.ts recordMcpCall);
 *             the dashboard's own "Test connection" hits /api/mcp/health, which
 *             records nothing, so it cannot complete this step
 *   backend   something genuinely built, by the same rule every autonomy entry
 *             point uses (lib/projects/backend-presence.ts builtEvidenceWhere)
 *   publish   a project that is LIVE
 *   watching  an autonomy pass over a built project: a reconciler tick or an
 *             observer scan (lib/autonomy/loop-tick.ts, Project.lastObservedAt)
 *
 * Steps are not gated on each other. A user who built tables in the Database
 * section before connecting an agent sees "backend" done and "agent" still
 * open, because that is what happened.
 *
 * Pure and dependency-free, so the server route, the client and the tests all
 * read the same rules.
 */

export const STEP_IDS = ['account', 'project', 'mcp_key', 'agent', 'backend', 'publish', 'watching'] as const
export type StepId = (typeof STEP_IDS)[number]

export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && (STEP_IDS as readonly string[]).includes(value)
}

/**
 * How an unfinished step reads.
 *   todo         nothing has happened yet
 *   waiting      the user did their part; Backenly is waiting on evidence
 *                (a key exists but no agent has called; something is built but
 *                no autonomy pass has run yet)
 *   in_progress  a publish is running
 *   failed       the evidence says it went wrong (agent calls failing, publish failed)
 */
export type StepStatus = 'done' | 'todo' | 'waiting' | 'in_progress' | 'failed'

/** One recorded MCP call. `error` is the stored, secret-withheld summary. */
export interface McpCallFact {
  tool: string | null
  endpoint: string
  statusCode: number
  at: string
  error: string | null
}

/** What the server read about one project the caller can see. */
export interface ProjectFact {
  id: string
  name: string
  createdAt: string
  /** PRIVATE | DEPLOYING | LIVE | FAILED */
  status: string
  deployedAt: string | null
  /** Sanitized by go-live before it is stored. */
  deploymentError: string | null
  /** MCP keys this user minted on this project. */
  mcpKeys: number
  /** OAuth connections this user approved on this project. */
  oauthConnections: number
  /** Latest successful recorded call from this user's credentials on this project. */
  lastAgentCallAt: string | null
  built: boolean
  /** Latest autonomy pass (reconciler tick or observer scan) over this project. */
  lastCheckedAt: string | null
}

export interface GuideFacts {
  /** Visible projects, newest first. */
  projects: ProjectFact[]
  /** The most recent recorded call from any of this user's MCP credentials, successful or not. */
  lastCall: McpCallFact | null
}

export interface GuideStep {
  id: StepId
  status: StepStatus
}

export interface GuideProgress {
  steps: GuideStep[]
  completed: number
  total: number
  /** The first unfinished step, in teaching order. Null once everything is done. */
  currentStepId: StepId | null
  allDone: boolean
  /**
   * The project the guide's actions point at: the one furthest along, so a
   * user with a half-built project is not sent to an empty one.
   */
  focus: ProjectFact | null
  /** Set when an agent has reached Backenly but its calls are failing. */
  failingCall: McpCallFact | null
}

const isLive = (p: ProjectFact) => p.status === 'LIVE'
const hasCredential = (p: ProjectFact) => p.mcpKeys + p.oauthConnections > 0

/**
 * The project furthest along the workflow, newest first on a tie. Ranking by
 * progress rather than recency keeps every CTA on the backend the user is
 * actually working on.
 */
export function selectFocusProject(projects: ProjectFact[]): ProjectFact | null {
  if (projects.length === 0) return null
  const rank = (p: ProjectFact) =>
    (isLive(p) && p.built ? 16 : 0) +
    (p.built ? 8 : 0) +
    (p.lastAgentCallAt ? 4 : 0) +
    (hasCredential(p) ? 2 : 0) +
    (p.status === 'DEPLOYING' || p.status === 'FAILED' ? 1 : 0)
  return projects.reduce((best, p) => {
    const d = rank(p) - rank(best)
    if (d !== 0) return d > 0 ? p : best
    return Date.parse(p.createdAt) > Date.parse(best.createdAt) ? p : best
  })
}

export function deriveGuide(facts: GuideFacts): GuideProgress {
  const { projects } = facts
  const focus = selectFocusProject(projects)

  const anyProject = projects.length > 0
  const anyCredential = projects.some(hasCredential)
  const anyAgentCall = projects.some((p) => p.lastAgentCallAt !== null)
  const anyBuilt = projects.some((p) => p.built)
  const anyLive = projects.some(isLive)
  const anyChecked = projects.some((p) => p.built && p.lastCheckedAt !== null)

  // Failing only while nothing has succeeded: one bad call after a working
  // session is not a broken connection, and the Connect page shows the call.
  const failingCall =
    !anyAgentCall && facts.lastCall && facts.lastCall.statusCode >= 400 ? facts.lastCall : null

  const agentStatus: StepStatus = anyAgentCall
    ? 'done'
    : failingCall
      ? 'failed'
      : anyCredential
        ? 'waiting'
        : 'todo'

  const publishStatus: StepStatus = anyLive
    ? 'done'
    : focus?.status === 'DEPLOYING'
      ? 'in_progress'
      : focus?.status === 'FAILED'
        ? 'failed'
        : 'todo'

  const statuses: Record<StepId, StepStatus> = {
    account: 'done',
    project: anyProject ? 'done' : 'todo',
    mcp_key: anyCredential ? 'done' : 'todo',
    agent: agentStatus,
    backend: anyBuilt ? 'done' : 'todo',
    publish: publishStatus,
    watching: anyChecked ? 'done' : anyBuilt ? 'waiting' : 'todo',
  }

  const steps = STEP_IDS.map((id) => ({ id, status: statuses[id] }))
  const completed = steps.filter((s) => s.status === 'done').length
  const current = steps.find((s) => s.status !== 'done')

  return {
    steps,
    completed,
    total: steps.length,
    currentStepId: current?.id ?? null,
    allDone: !current,
    focus,
    failingCall,
  }
}

// ── Who sees the guide ────────────────────────────────────────────────────────

/**
 * The day the guide shipped. An account created before it that already had a
 * project is an existing user, and is never shown a beginner checklist it did
 * not ask for; it can still open the guide from the account menu.
 *
 * Both halves are needed. An account that signed up earlier but never made a
 * project is, for every purpose here, new. And checking project AGE rather than
 * project count is what keeps a new user's own first project from flipping them
 * to "existing" halfway through the guide.
 */
export const GUIDE_INTRODUCED_AT = '2026-09-26T00:00:00.000Z'

export type GuideAudience = 'new' | 'existing'

export function guideAudience(
  userCreatedAt: string | Date,
  projectCreatedAts: ReadonlyArray<string | Date>,
): GuideAudience {
  const introduced = Date.parse(GUIDE_INTRODUCED_AT)
  const before = (d: string | Date) => new Date(d).getTime() < introduced
  return before(userCreatedAt) && projectCreatedAts.some(before) ? 'existing' : 'new'
}

export interface GuidePreference {
  startedAt: string | null
  dismissedAt: string | null
  reopenedAt: string | null
}

/**
 * Whether the guide shows itself. Hiding always wins; reopening shows it to
 * anyone; otherwise it is for new accounts only. A new user who finishes keeps
 * seeing the completed guide until they close it, which is the only moment
 * "you're set up" can be said without being a surprise.
 */
export function isGuideVisible(pref: GuidePreference, audience: GuideAudience): boolean {
  if (pref.dismissedAt) return false
  if (pref.reopenedAt) return true
  return audience === 'new'
}

/** Interactions the client may report. Anything else is refused, not stored. */
export const GUIDE_ACTIONS = ['setup_copied', 'starter_prompt_copied', 'cta_clicked'] as const
export type GuideAction = (typeof GUIDE_ACTIONS)[number]

/** What GET /api/onboarding returns. */
export interface GuideState {
  visible: boolean
  audience: GuideAudience
  /** False until the user_onboarding migration has run: hiding cannot be saved yet. */
  savable: boolean
  /** Null while the guide is hidden: nothing is collected for a guide nobody sees. */
  progress: GuideProgress | null
}

/** Steps whose completion has not yet been reported to the funnel. */
export function unreportedCompletions(progress: GuideProgress, reported: readonly string[]): StepId[] {
  return progress.steps
    .filter((s) => s.status === 'done' && s.id !== 'account' && !reported.includes(s.id))
    .map((s) => s.id)
}
