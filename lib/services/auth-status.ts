import { prisma } from '@/lib/db/prisma'
import { loadGraph } from '@/lib/orchestration/backend-state-graph'

export type AuthProviderId = 'email' | 'google' | 'github'

export interface AuthProviderStatus {
  id: AuthProviderId
  enabled: boolean
  type: 'email' | 'oauth'
}

export type AuthOverallStatus = 'none' | 'partial' | 'ready'

export interface ProjectAuthStatus {
  jwtEnabled: boolean
  emailPasswordEnabled: boolean
  oauthProviders: AuthProviderId[]
  providers: AuthProviderStatus[]
  status: AuthOverallStatus
}

const KNOWN_OAUTH_PROVIDERS: AuthProviderId[] = ['google', 'github']

/**
 * Single source of truth for a project's auth status.
 *
 * Reads the BackendStateGraph (set by build runtime), the project's jwtSecret
 * (set when JWT auth is provisioned), and workspaceOAuthConfig (set when an
 * OAuth credential is saved). Merges the three so dashboard, inspector,
 * /status, and proof always agree.
 */
export async function getProjectAuthStatus(projectId: string): Promise<ProjectAuthStatus> {
  const [graph, projectRow, oauthConfigs] = await Promise.all([
    loadGraph(projectId).catch(() => null),
    prisma.project
      .findUnique({ where: { id: projectId }, select: { jwtSecret: true } })
      .catch(() => null),
    prisma.workspaceOAuthConfig
      .findMany({
        where: { projectId, enabled: true },
        select: { provider: true },
      })
      .catch(() => [] as { provider: string }[]),
  ])

  const graphProviders = graph?.auth?.providers ?? {}
  const oauthEnabledSet = new Set(oauthConfigs.map(c => c.provider.toLowerCase()))

  const jwtEnabled = !!projectRow?.jwtSecret
  // Email/password is "active" only when the agent genuinely wired auth — the
  // BackendStateGraph carries an enabled email provider. The bare jwtSecret is
  // infrastructure (a signing key seeded at project creation so auth works from
  // day zero); it is NOT evidence that anyone has built or enabled auth. Keying
  // "active" off jwtSecret made every freshly-named, never-built project report
  // auth as ready — the exact "faked before you built anything" surface we are
  // removing now that Backenly is agent-native. jwtEnabled is still reported
  // (the security-posture panel uses it), it just no longer implies activation.
  const emailPasswordEnabled = !!graphProviders.email?.enabled

  const oauthProviders = KNOWN_OAUTH_PROVIDERS.filter(
    p => !!graphProviders[p]?.enabled || oauthEnabledSet.has(p),
  )

  const providers: AuthProviderStatus[] = [
    { id: 'email', enabled: emailPasswordEnabled, type: 'email' },
    ...KNOWN_OAUTH_PROVIDERS.map<AuthProviderStatus>(p => ({
      id: p,
      enabled: oauthProviders.includes(p),
      type: 'oauth',
    })),
  ]

  const enabledCount = providers.filter(p => p.enabled).length
  const status: AuthOverallStatus =
    enabledCount === 0 ? 'none' : emailPasswordEnabled ? 'ready' : 'partial'

  return {
    jwtEnabled,
    emailPasswordEnabled,
    oauthProviders,
    providers,
    status,
  }
}

// ─── Usage evidence ──────────────────────────────────────────────────────────

export interface EndUserAuthUsage {
  /**
   * The workspace `users` table exists. NOTE: this is TRUE on essentially every
   * project, including never-built ones — it is platform scaffolding, not
   * evidence. Reported for callers that genuinely need the physical fact (e.g.
   * deciding whether a query can run at all); never use it to decide whether
   * auth is in use. See `inUse`.
   */
  usersTableExists: boolean
  /** At least one real end-user identity exists — somebody actually signed up. */
  hasIdentities: boolean
  /** The developer explicitly configured auth surface beyond the
   *  platform-provisioned defaults: an enabled OAuth provider or an enabled
   *  permission policy on the users table. */
  configuredEvidence: boolean
  /** End-user auth is demonstrably in use for this project. */
  inUse: boolean
}

/**
 * Evidence check used by health detectors and verification scenarios.
 *
 * WHAT COUNTS AS EVIDENCE, AND WHY IT IS NOT THE TABLE
 * ----------------------------------------------------
 * This helper used to treat "the workspace `users` table exists" as proof that
 * end-user auth was in use, on the stated assumption that the table is created
 * lazily by the first real signup. That assumption is false: `users` is part of
 * the scaffolding a freshly-named project ships with, which is why
 * /api/projects/[id]/state must explicitly filter it out of `hasContent`.
 *
 * The cost of the stale assumption was concrete. Every brand-new project — no
 * agent connected, nothing built, zero identities — satisfied the anchor, so
 * `verifyUserAuthFlow` treated the auth workflow as live, found no RLS policy
 * on `users`, and raised a `workflow_broken` finding that sat in "Waiting on
 * you" before the owner had done anything at all. That is exactly the class of
 * finding the evidence policy exists to forbid: findings need RUNTIME evidence.
 *
 * So evidence is now what a user actually did:
 *   • a real identity exists (somebody signed up), or
 *   • the developer configured auth (OAuth provider or a users RLS policy), or
 *   • auth is genuinely enabled in the backend state graph.
 *
 * Table existence and the bare jwtSecret are BOTH provisioning state and prove
 * nothing. Detectors call this first and stay silent when auth is not in use.
 */
export async function getEndUserAuthUsage(projectId: string): Promise<EndUserAuthUsage> {
  const { queryWorkspaceSchema } = await import('@/lib/services/workspaceDatabase')
  const schema = `workspace_${projectId}`

  const [usersRows, identityRows, oauthCount, usersPolicyCount, authStatus] = await Promise.all([
    queryWorkspaceSchema(
      projectId,
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'users' LIMIT 1`,
      schema,
    ).catch(() => ({ rows: [] as unknown[] })),
    // One real signup is the strongest evidence there is. Fails soft: if the
    // table does not exist yet the query errors and we read it as "no
    // identities", which is the correct conclusion anyway.
    queryWorkspaceSchema(
      projectId,
      `SELECT 1 FROM "${schema}"."users" LIMIT 1`,
      schema,
    ).catch(() => ({ rows: [] as unknown[] })),
    prisma.workspaceOAuthConfig
      .count({ where: { projectId, enabled: true } })
      .catch(() => 0),
    prisma.permissionPolicy
      .count({ where: { projectId, tableName: 'users', enabled: true } })
      .catch(() => 0),
    getProjectAuthStatus(projectId).catch(() => null),
  ])

  const rows: unknown[] = (usersRows as any)?.rows ?? usersRows ?? []
  const idRows: unknown[] = (identityRows as any)?.rows ?? identityRows ?? []

  const usersTableExists = rows.length > 0
  const hasIdentities = idRows.length > 0
  const configuredEvidence =
    oauthCount > 0 || usersPolicyCount > 0 || (authStatus?.status ?? 'none') !== 'none'

  return {
    usersTableExists,
    hasIdentities,
    configuredEvidence,
    inUse: hasIdentities || configuredEvidence,
  }
}

const PROVIDER_LABEL: Record<AuthProviderId, string> = {
  email: 'Email / Password',
  google: 'Google',
  github: 'GitHub',
}

/** Renders a status into the chip label shown on the dashboard, e.g.
 *  "JWT · Email / Password · Google". */
export function formatAuthStatusLabel(status: ProjectAuthStatus): string {
  const parts: string[] = []
  if (status.jwtEnabled) parts.push('JWT')
  if (status.emailPasswordEnabled) parts.push(PROVIDER_LABEL.email)
  for (const p of status.oauthProviders) parts.push(PROVIDER_LABEL[p])
  return parts.join(' · ')
}
