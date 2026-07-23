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
  /** The workspace `users` table exists (created lazily by the first signup
   *  or by an AI build that included auth). */
  usersTableExists: boolean
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
 * End-user auth infrastructure is provisioned lazily: the jwtSecret and the
 * workspace `users` table are both created on the first real signup. Their
 * absence on a project with no auth usage is a provisioning state, not a
 * failure — flagging it violates the finding evidence policy (findings need
 * runtime evidence). Detectors call this first and stay silent when auth is
 * simply not in use yet.
 */
export async function getEndUserAuthUsage(projectId: string): Promise<EndUserAuthUsage> {
  const { queryWorkspaceSchema } = await import('@/lib/services/workspaceDatabase')
  const schema = `workspace_${projectId}`

  const [usersRows, oauthCount, usersPolicyCount] = await Promise.all([
    queryWorkspaceSchema(
      projectId,
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'users' LIMIT 1`,
      schema,
    ).catch(() => ({ rows: [] as unknown[] })),
    prisma.workspaceOAuthConfig
      .count({ where: { projectId, enabled: true } })
      .catch(() => 0),
    prisma.permissionPolicy
      .count({ where: { projectId, tableName: 'users', enabled: true } })
      .catch(() => 0),
  ])

  const rows: unknown[] = (usersRows as any)?.rows ?? usersRows ?? []
  const usersTableExists = rows.length > 0
  const configuredEvidence = oauthCount > 0 || usersPolicyCount > 0

  return {
    usersTableExists,
    configuredEvidence,
    inUse: usersTableExists || configuredEvidence,
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
