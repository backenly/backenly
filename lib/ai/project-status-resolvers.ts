/**
 * PROJECT STATUS RESOLVERS
 * ========================
 * Single source of truth for dashboard, inspector, /status, /scan,
 * chat response summaries, and build header badges.
 *
 * Every UI surface that shows project state MUST call these resolvers
 * instead of reading from multiple scattered sources. This eliminates
 * dashboard/inspector/chat disagreements.
 *
 * Usage:
 *   import { getProjectBuildStatus, getProjectAuthStatus } from '@/lib/ai/project-status-resolvers'
 */

import { prisma } from '@/lib/db/prisma'
import { loadActiveBuildJob } from '@/lib/ai/build-runtime/continuation-store'
import { reconcileBlockedCredentials } from '@/lib/ai/credential-reconciler'

// ── Auth Status ───────────────────────────────────────────────────────────────

export interface ProjectAuthStatus {
  enabled: boolean
  providers: string[]          // ['email/password', 'google', 'github']
  hasJwt: boolean
  hasOAuth: boolean
  rlsPoliciesCount: number
  summary: string              // human-readable one-liner
}

export async function getProjectAuthStatus(projectId: string): Promise<ProjectAuthStatus> {
  try {
    const [project, oauthConfigs, policies] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: { jwtSecret: true },
      }),
      prisma.workspaceOAuthConfig.findMany({
        where: { projectId, enabled: true },
        select: { provider: true },
      }),
      prisma.permissionPolicy.findMany({
        where: { projectId },
        select: { id: true },
      }),
    ])

    const hasJwt = !!(project?.jwtSecret)
    const providers: string[] = []
    if (hasJwt) providers.push('email/password')
    for (const o of oauthConfigs) providers.push(o.provider)

    const enabled = hasJwt || oauthConfigs.length > 0

    let summary: string
    if (!enabled) {
      summary = 'Auth not configured'
    } else if (providers.length === 1) {
      summary = `Auth: ${providers[0]}`
    } else {
      summary = `Auth: ${providers.join(', ')}`
    }

    if (policies.length > 0) {
      summary += ` · RLS on ${policies.length} table${policies.length !== 1 ? 's' : ''}`
    }

    return {
      enabled,
      providers,
      hasJwt,
      hasOAuth: oauthConfigs.length > 0,
      rlsPoliciesCount: policies.length,
      summary,
    }
  } catch {
    return {
      enabled: false,
      providers: [],
      hasJwt: false,
      hasOAuth: false,
      rlsPoliciesCount: 0,
      summary: 'Auth status unavailable',
    }
  }
}

// ── Storage Status ────────────────────────────────────────────────────────────

export interface ProjectStorageStatus {
  buckets: Array<{ name: string; isPublic: boolean }>
  bucketCount: number
  summary: string
}

export async function getProjectStorageStatus(projectId: string): Promise<ProjectStorageStatus> {
  try {
    const buckets = await prisma.storageBucket.findMany({
      where: { projectId },
      select: { name: true, isPublic: true },
      orderBy: { createdAt: 'asc' },
    })

    const summary =
      buckets.length === 0
        ? 'No storage buckets'
        : `${buckets.length} bucket${buckets.length !== 1 ? 's' : ''}: ${buckets.map(b => b.name).join(', ')}`

    return { buckets, bucketCount: buckets.length, summary }
  } catch {
    return { buckets: [], bucketCount: 0, summary: 'Storage status unavailable' }
  }
}

// ── Integration Status ────────────────────────────────────────────────────────

export interface ProjectIntegrationStatus {
  connected: string[]          // integration IDs that are active
  missing: Array<{             // from active build job blocked nodes
    name: string
    type: string
    requiredEnvVar?: string
    provider?: string
  }>
  connectedCount: number
  missingCount: number
  summary: string
}

export async function getProjectIntegrationStatus(projectId: string): Promise<ProjectIntegrationStatus> {
  try {
    const [keys, oauthConfigs] = await Promise.all([
      prisma.projectIntegrationKey.findMany({
        where: { projectId },
        select: { integrationId: true },
      }),
      prisma.workspaceOAuthConfig.findMany({
        where: { projectId },
        select: { provider: true },
      }),
    ])

    const connected: string[] = [
      ...keys.map(k => k.integrationId),
      ...oauthConfigs.map(o => o.provider),
    ]

    // Get missing from credential reconciler (reads live build job)
    const reconcile = await reconcileBlockedCredentials(projectId)
    const missing = reconcile.remainingBlockers

    const connectedCount = connected.length
    const missingCount = missing.length

    let summary: string
    if (connectedCount === 0 && missingCount === 0) {
      summary = 'No integrations'
    } else if (connectedCount > 0 && missingCount === 0) {
      summary = `${connectedCount} integration${connectedCount !== 1 ? 's' : ''} connected`
    } else if (connectedCount === 0 && missingCount > 0) {
      summary = `${missingCount} credential${missingCount !== 1 ? 's' : ''} needed: ${missing.map(m => m.name).join(', ')}`
    } else {
      summary = `${connectedCount} connected · ${missingCount} missing: ${missing.map(m => m.name).join(', ')}`
    }

    return { connected, missing, connectedCount, missingCount, summary }
  } catch {
    return { connected: [], missing: [], connectedCount: 0, missingCount: 0, summary: 'Integration status unavailable' }
  }
}

// ── Build Status ──────────────────────────────────────────────────────────────

export type BuildStatusLabel =
  | 'Not started'
  | 'In Progress'
  | 'Structure ready'
  | 'Credentials needed'
  | 'Needs launch fixes'
  | 'Failed build step'
  | 'Awaiting approval'
  | 'Scan recommended'
  | 'Build Complete'

export interface ProjectBuildStatus {
  jobStatus: string | null       // raw BuildJob.status
  label: BuildStatusLabel
  tablesCount: number
  apisCount: number
  blockedCount: number
  failedCount: number
  builtCount: number
  isProductionReady: boolean
  summary: string
}

export async function getProjectBuildStatus(projectId: string): Promise<ProjectBuildStatus> {
  const empty: ProjectBuildStatus = {
    jobStatus: null,
    label: 'Not started',
    tablesCount: 0,
    apisCount: 0,
    blockedCount: 0,
    failedCount: 0,
    builtCount: 0,
    isProductionReady: false,
    summary: 'No build started',
  }

  try {
    const [job, tables, apis] = await Promise.all([
      loadActiveBuildJob(projectId),
      prisma.table.findMany({ where: { projectId }, select: { id: true } }),
      prisma.apiDefinition.findMany({ where: { projectId }, select: { id: true } }),
    ])

    const tablesCount = tables.length
    const apisCount = apis.length

    if (!job) {
      if (tablesCount === 0) return empty
      return {
        ...empty,
        tablesCount,
        apisCount,
        label: 'Structure ready',
        summary: `${tablesCount} table${tablesCount !== 1 ? 's' : ''}, ${apisCount} endpoint${apisCount !== 1 ? 's' : ''} — no active build job`,
      }
    }

    const allNodes = job.phases.flatMap(p => p.nodes)
    const blockedCount = allNodes.filter(n => n.status === 'blocked').length
    const failedCount = allNodes.filter(n => n.status === 'failed').length
    const builtCount = allNodes.filter(n => n.status === 'verified' || n.status === 'partial').length

    // Derive label from real state
    let label: BuildStatusLabel
    if (job.status === 'running') {
      label = 'In Progress'
    } else if (failedCount > 0) {
      label = 'Failed build step'
    } else if (blockedCount > 0) {
      label = 'Credentials needed'
    } else if (job.status === 'verified') {
      label = 'Build Complete'
    } else if (job.status === 'partial') {
      label = 'Structure ready'
    } else {
      label = 'Scan recommended'
    }

    // Production ready: verified status + no blockers + no failures + has auth + has tables
    const isProductionReady =
      job.status === 'verified' &&
      blockedCount === 0 &&
      failedCount === 0 &&
      tablesCount > 0 &&
      apisCount > 0

    const summary = [
      `${tablesCount} table${tablesCount !== 1 ? 's' : ''}`,
      `${apisCount} endpoint${apisCount !== 1 ? 's' : ''}`,
      blockedCount > 0 ? `${blockedCount} credential${blockedCount !== 1 ? 's' : ''} needed` : null,
      failedCount > 0 ? `${failedCount} step${failedCount !== 1 ? 's' : ''} failed` : null,
    ].filter(Boolean).join(' · ')

    return {
      jobStatus: job.status,
      label,
      tablesCount,
      apisCount,
      blockedCount,
      failedCount,
      builtCount,
      isProductionReady,
      summary,
    }
  } catch {
    return empty
  }
}

// ── Composite: full project status ───────────────────────────────────────────

export interface FullProjectStatus {
  auth: ProjectAuthStatus
  storage: ProjectStorageStatus
  integrations: ProjectIntegrationStatus
  build: ProjectBuildStatus
}

/**
 * Load all four status dimensions in parallel.
 * Use this when you need a complete project health snapshot —
 * dashboard summaries, /scan proof, chat response headers.
 */
export async function getFullProjectStatus(projectId: string): Promise<FullProjectStatus> {
  const [auth, storage, integrations, build] = await Promise.all([
    getProjectAuthStatus(projectId),
    getProjectStorageStatus(projectId),
    getProjectIntegrationStatus(projectId),
    getProjectBuildStatus(projectId),
  ])
  return { auth, storage, integrations, build }
}

/**
 * Produce a single, non-contradictory status line for a project.
 * Used by dashboard cards, inspector headers, chat summaries, and status badges.
 *
 * Rules:
 *  - Never say "complete" when there are missing credentials
 *  - Never say "ready" when there are failed nodes
 *  - Never say "credentials needed" and "all set" in the same message
 *  - Prefer specificity over vagueness
 */
export function getConsistentStatusLine(status: FullProjectStatus): string {
  const { build, auth, integrations } = status

  if (build.tablesCount === 0) return 'No backend built yet'
  if (build.jobStatus === 'running') return 'Build in progress…'

  if (build.failedCount > 0) {
    return `Build has ${build.failedCount} failed step${build.failedCount !== 1 ? 's' : ''} — say "/scan" to diagnose`
  }

  if (build.blockedCount > 0) {
    const names = integrations.missing.slice(0, 2).map(m => m.name)
    const more = integrations.missing.length > 2 ? ` (+${integrations.missing.length - 2} more)` : ''
    return `Credentials needed: ${names.join(', ')}${more}`
  }

  if (!auth.enabled) {
    return `${build.tablesCount} tables, ${build.apisCount} endpoints — auth not configured`
  }

  if (build.isProductionReady) {
    return `Production ready — ${build.tablesCount} tables, ${build.apisCount} endpoints, auth ${auth.providers.join('+')} ✓`
  }

  if (build.jobStatus === 'verified') {
    return `Build complete — ${build.tablesCount} tables, ${build.apisCount} endpoints, auth enabled`
  }

  if (build.jobStatus === 'partial') {
    return `Structure ready — ${build.tablesCount} tables, ${build.apisCount} endpoints`
  }

  return `${build.tablesCount} table${build.tablesCount !== 1 ? 's' : ''}, ${build.apisCount} endpoint${build.apisCount !== 1 ? 's' : ''}`
}
