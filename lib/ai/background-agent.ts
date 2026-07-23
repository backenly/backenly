/**
 * BACKGROUND PROACTIVE IMPROVEMENT AGENT (#12)
 * ==============================================
 * Silently audits a project's backend and surfaces actionable suggestions.
 * Runs non-blocking after every successful build and on project load.
 *
 * What it checks:
 *  Schema health   — missing FK constraints, unindexed FK columns
 *  Security        — tables without RLS policies, auth gaps
 *  Performance     — large tables with no indexes on filter columns
 *  Integration     — auth-without-email, built-not-deployed
 *  Hygiene         — test/temp tables, tables with no API endpoints
 *
 * "I noticed your posts table is missing an index on user_id. Fixed it."
 * That's the Replit/Base44 experience this produces.
 */

import { prisma } from '@/lib/db/prisma'

export interface BackgroundFinding {
  severity: 'critical' | 'warning' | 'info'
  category: 'schema' | 'performance' | 'integration' | 'security'
  title: string
  description: string
  autoFixable: boolean
  fixAction?: string              // What the user should type to fix it
  executorAction?: string         // AIAction.action type for autonomous auto-fix
  executorParams?: Record<string, any>  // Params to pass to executeAction
}

export interface BackgroundCheckResult {
  projectId: string
  findings: BackgroundFinding[]
  autoFixed: string[]
  checkedAt: string
}

/**
 * Run all background checks for a project.
 * Auto-fixes low-risk issues silently, surfaces the rest as suggestions.
 */
export async function runBackgroundAgent(projectId: string): Promise<BackgroundCheckResult> {
  const findings: BackgroundFinding[] = []
  const autoFixed: string[] = []

  try {
    const { inferAndSaveRelationships, introspectSchema } = await import('./minimal-executor')
    const { listTables, checkAuthStatus } = await import('./schema-tools')

    // ── Load project state ───────────────────────────────────────────────────
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        authManifest: true,
        activeIntegrations: true,
        isFrontendConnected: true,
        isDeployed: true,
        tables: { select: { name: true } },
      },
    })

    const integrations = (project?.activeIntegrations as Record<string, any>) ?? {}
    const authManifest = (project?.authManifest as any) ?? {}
    const hasAuth = !!authManifest?.enabled
    const hasTables = (project?.tables?.length ?? 0) > 0
    const tableNames = (project?.tables ?? []).map(t => t.name)

    // ── 1. FK constraint repair (auto-fix) ──────────────────────────────────
    if (hasTables) {
      try {
        await inferAndSaveRelationships(projectId)
        autoFixed.push('FK relationships inferred and saved')
      } catch { /* non-fatal */ }
    }

    // ── 2. Unindexed FK columns — critical for query performance ────────────
    if (hasTables) {
      try {
        const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
        const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

        const unindexedFks = await prisma.$queryRawUnsafe<any[]>(`
          SELECT kcu.table_name, kcu.column_name
          FROM information_schema.key_column_usage kcu
          JOIN information_schema.table_constraints tc
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND kcu.table_schema = $1
            AND NOT EXISTS (
              SELECT 1 FROM pg_indexes pi2
              WHERE pi2.schemaname = $1
                AND pi2.tablename = kcu.table_name
                AND pi2.indexdef LIKE '%' || kcu.column_name || '%'
            )
        `, postgresSchema)

        if (unindexedFks.length > 0) {
          for (const row of unindexedFks) {
            findings.push({
              severity: 'warning',
              category: 'performance',
              title: `Missing index on ${row.table_name}.${row.column_name}`,
              description: `FK column "${row.column_name}" on "${row.table_name}" has no index — join queries will be slow at scale.`,
              autoFixable: true,
              fixAction: `add index on ${row.table_name}.${row.column_name}`,
              executorAction: 'CREATE_INDEX',
              executorParams: { tableName: row.table_name, columnName: row.column_name },
            })
          }
        }
      } catch { /* non-fatal — DB may not be provisioned yet */ }
    }

    // ── 3. Tables without RLS policies (security gap) ───────────────────────
    if (hasAuth && hasTables) {
      try {
        const policiedTables = await prisma.permissionPolicy.findMany({
          where: { projectId },
          select: { tableName: true },
        })
        const policiedSet = new Set(policiedTables.map((p: any) => p.tableName))

        const unprotectedTables = tableNames.filter(
          t => !policiedSet.has(t) && t !== 'users'
        )

        if (unprotectedTables.length > 0) {
          findings.push({
            severity: 'warning',
            category: 'security',
            title: 'Tables without row-level security',
            description: `These tables are exposed without RLS — any authenticated user can read all rows: ${unprotectedTables.join(', ')}`,
            autoFixable: false,
            fixAction: `set permission policy for ${unprotectedTables[0]}`,
          })
        }
      } catch { /* non-fatal */ }
    }

    // ── 4. Tables without REST APIs ─────────────────────────────────────────
    if (hasTables) {
      try {
        const apis = await prisma.apiDefinition.findMany({
          where: { projectId, enabled: true },
          select: { name: true },
        })
        const apiSet = new Set(apis.map((a: any) => a.name))
        const noApiTables = tableNames.filter(
          t => !apiSet.has(t) && t !== 'users'
        )

        for (const tableName of noApiTables) {
          findings.push({
            severity: 'warning',
            category: 'schema',
            title: `${tableName} has no REST API`,
            description: `Table "${tableName}" exists but has no generated REST endpoints.`,
            autoFixable: true,
            fixAction: `generate API for ${tableName}`,
            executorAction: 'GENERATE_API',
            executorParams: { tableName },
          })
        }
      } catch { /* non-fatal */ }
    }

    // ── 5. Auth enabled but no email service ────────────────────────────────
    if (hasAuth) {
      const hasEmail = integrations.resend?.enabled || integrations.sendgrid?.enabled
      if (!hasEmail) {
        findings.push({
          severity: 'warning',
          category: 'integration',
          title: 'Auth without email service',
          description: 'Auth is enabled but no email provider is connected. Password reset and verification emails will not work.',
          autoFixable: false,
          fixAction: 'enable email with Resend',
        })
      }
    }

    // ── 6. Built but not deployed ────────────────────────────────────────────
    if (hasTables && !project?.isDeployed) {
      findings.push({
        severity: 'info',
        category: 'integration',
        title: 'Backend not yet deployed',
        description: 'Your backend is ready but not live. Deploy to get a public HTTPS URL for your frontend.',
        autoFixable: false,
        fixAction: 'deploy my project',
      })
    }

    // ── 7. Frontend SDK not generated ────────────────────────────────────────
    if (hasTables && !project?.isFrontendConnected) {
      findings.push({
        severity: 'info',
        category: 'integration',
        title: 'Frontend not connected',
        description: 'You have a working backend but no SDK snippet generated. Connect your frontend to start using the APIs.',
        autoFixable: false,
        fixAction: 'connect frontend',
      })
    }

    // ── 8. Test/temp table hygiene ───────────────────────────────────────────
    const suspiciousTables = tableNames.filter(t =>
      /^(test|temp|tmp|debug|copy_of|backup|old_|bak_)/i.test(t)
    )
    if (suspiciousTables.length > 0) {
      findings.push({
        severity: 'info',
        category: 'schema',
        title: 'Cleanup opportunity',
        description: `Tables with test/temp names detected: ${suspiciousTables.join(', ')}. Consider removing them to keep your schema clean.`,
        autoFixable: false,
      })
    }

    // ── 9. No tables at all (empty project nudge) ────────────────────────────
    if (!hasTables) {
      findings.push({
        severity: 'info',
        category: 'schema',
        title: 'No backend resources yet',
        description: 'Describe your app and I\'ll build the full backend — tables, APIs, and auth — in one message.',
        autoFixable: false,
        fixAction: 'build me a SaaS backend',
      })
    }

  } catch {
    // Background agent must never crash the main request
  }

  const result: BackgroundCheckResult = {
    projectId,
    findings,
    autoFixed,
    checkedAt: new Date().toISOString(),
  }

  // Gap 9: Persist findings to DB so they can be surfaced proactively on page load
  // Use AuditLog with type='background_check' — non-blocking, fire-and-forget
  if (findings.length > 0 || autoFixed.length > 0) {
    persistFindingsToDB(projectId, result).catch(() => {})
  }

  return result
}

/**
 * Gap 9: Persist background findings to DB for proactive surfacing.
 * Stores in AuditLog with type='background_check', upserts by projectId (1 record per project).
 */
async function persistFindingsToDB(projectId: string, result: BackgroundCheckResult): Promise<void> {
  try {
    // Delete old background check record for this project, then insert fresh
    await prisma.auditLog.deleteMany({
      where: { projectId, type: 'background_check' },
    })
    await prisma.auditLog.create({
      data: {
        projectId,
        action: 'background_check',
        type: 'background_check',
        details: `${result.findings.length} findings, ${result.autoFixed.length} auto-fixed`,
        metadata: JSON.parse(JSON.stringify({
          findings: result.findings,
          autoFixed: result.autoFixed,
          checkedAt: result.checkedAt,
        })),
      },
    })
  } catch {
    // Non-fatal
  }
}

/**
 * Gap 9: Load the most recent persisted background findings for a project.
 * Used to surface suggestions on chat load (not just after builds).
 */
export async function getPersistedFindings(projectId: string): Promise<BackgroundCheckResult | null> {
  try {
    const record = await prisma.auditLog.findFirst({
      where: { projectId, type: 'background_check' },
      orderBy: { timestamp: 'desc' },
    })
    if (!record?.metadata) return null
    const meta = record.metadata as any
    return {
      projectId,
      findings: meta.findings ?? [],
      autoFixed: meta.autoFixed ?? [],
      checkedAt: meta.checkedAt ?? record.timestamp.toISOString(),
    }
  } catch {
    return null
  }
}

/**
 * Format background findings as a concise message to append to successful builds.
 * Shows at most 2 items to avoid overwhelming the user.
 */
export function formatBackgroundFindings(result: BackgroundCheckResult): string {
  const { findings, autoFixed } = result

  if (autoFixed.length === 0 && findings.length === 0) return ''

  const lines: string[] = []

  if (autoFixed.length > 0) {
    lines.push(`Auto-fixed: ${autoFixed.join(', ')}.`)
  }

  // Surface critical first, then warnings, then info
  const critical = findings.filter(f => f.severity === 'critical')
  const warnings = findings.filter(f => f.severity === 'warning')
  const infos = findings.filter(f => f.severity === 'info')

  const ordered = [...critical, ...warnings, ...infos].slice(0, 2)

  for (const f of ordered) {
    const action = f.fixAction ? ` → type "${f.fixAction}"` : ''
    if (f.severity === 'critical' || f.severity === 'warning') {
      lines.push(`Notice: ${f.title}${action}`)
    } else {
      lines.push(`Tip: ${f.title}${action}`)
    }
  }

  const remaining = findings.length - ordered.length
  if (remaining > 0) {
    lines.push(`+${remaining} more suggestion${remaining > 1 ? 's' : ''} available.`)
  }

  return lines.length > 0 ? `\n\n${lines.join('\n')}` : ''
}

/**
 * Non-blocking wrapper — safe to call with .catch(() => {}).
 * Returns a formatted hint string to append to the main response.
 */
export async function getBackgroundHints(projectId: string): Promise<string> {
  try {
    const result = await runBackgroundAgent(projectId)
    return formatBackgroundFindings(result)
  } catch {
    return ''
  }
}

// ── Autonomous Loop ───────────────────────────────────────────────────────────

/**
 * Actions that are safe to apply automatically without user confirmation.
 * All are purely additive — they never drop, truncate, or change existing data.
 */
const SAFE_AUTO_FIX_ACTIONS = new Set<string>([
  'GENERATE_API',   // Create REST API for a table that has none — additive
  'CREATE_INDEX',   // Create index on FK column — additive, never destructive
])

/**
 * Autonomous health scan: runs `runBackgroundAgent`, auto-applies safe fixes,
 * and saves an AutonomousAction notification for the "while you were away" banner.
 *
 * Called by the 15-minute background-health cron for every active project.
 * Never throws — all errors are caught so one project never blocks others.
 */
export async function runAutonomousHealthScan(projectId: string, userId: string): Promise<void> {
  try {
    // Cost control: skip if this project was scanned within the last 2 hours
    const lastScan = await prisma.autonomousAction.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    if (lastScan && lastScan.createdAt > twoHoursAgo) return

    const result = await runBackgroundAgent(projectId)

    // Separate findings into auto-fixable vs needs approval
    const autoFixableFindings = result.findings.filter(
      f => f.executorAction && SAFE_AUTO_FIX_ACTIONS.has(f.executorAction),
    )
    const needsApproval = result.findings.filter(
      f => !f.executorAction || !SAFE_AUTO_FIX_ACTIONS.has(f.executorAction ?? ''),
    )

    // Auto-apply safe fixes using the executor
    const applied: string[] = [...result.autoFixed]
    if (autoFixableFindings.length > 0) {
      const { executeAction } = await import('./minimal-executor')
      for (const finding of autoFixableFindings) {
        try {
          const fixResult = await executeAction(
            { action: finding.executorAction as any, params: finding.executorParams ?? {} },
            projectId,
          )
          if (fixResult.success) {
            applied.push(finding.title)
            console.log(`[AutonomousHealth] Auto-fixed "${finding.title}" on project ${projectId}`)
          }
        } catch (err: any) {
          console.warn(`[AutonomousHealth] Auto-fix failed for "${finding.title}":`, err?.message)
        }
      }
    }

    // Save notification if there's anything to surface
    if (applied.length > 0 || needsApproval.length > 0) {
      await saveAutonomousActionNotification(projectId, userId, applied, needsApproval)
    }
  } catch (err: any) {
    console.warn(`[AutonomousHealth] Scan failed for project ${projectId}:`, err?.message)
  }
}

/**
 * Persist an AutonomousAction record and send a PlatformNotification
 * so the developer sees the "while you were away" banner on next project open.
 */
async function saveAutonomousActionNotification(
  projectId: string,
  userId: string,
  appliedFixes: string[],
  pendingReview: BackgroundFinding[],
): Promise<void> {
  try {
    // Write the AutonomousAction audit record
    await prisma.autonomousAction.create({
      data: {
        projectId,
        appliedFixes: JSON.parse(JSON.stringify(appliedFixes)),
        pendingReview: JSON.parse(JSON.stringify(
          pendingReview.map(f => ({
            severity: f.severity,
            category: f.category,
            title: f.title,
            description: f.description,
            fixAction: f.fixAction,
          }))
        )),
        seenByUser: false,
      },
    })

    // Also send a PlatformNotification so the in-app bell icon lights up
    const totalItems = appliedFixes.length + pendingReview.length
    if (totalItems > 0) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com'
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }).catch(() => null)
      const projectName = project?.name ?? 'your project'

      const titleParts: string[] = []
      if (appliedFixes.length > 0) titleParts.push(`${appliedFixes.length} fix${appliedFixes.length !== 1 ? 'es' : ''} applied`)
      if (pendingReview.length > 0) titleParts.push(`${pendingReview.length} item${pendingReview.length !== 1 ? 's' : ''} need${pendingReview.length === 1 ? 's' : ''} review`)

      const bodyParts: string[] = []
      if (appliedFixes.length > 0) bodyParts.push(`Applied: ${appliedFixes.slice(0, 2).join(', ')}${appliedFixes.length > 2 ? ` +${appliedFixes.length - 2} more` : ''}`)
      if (pendingReview.length > 0) bodyParts.push(`Review: ${pendingReview.slice(0, 2).map(f => f.title).join(', ')}${pendingReview.length > 2 ? ` +${pendingReview.length - 2} more` : ''}`)

      const { createPlatformNotification } = await import('@/lib/notifications/platform')
      await createPlatformNotification({
        userId,
        type: 'autonomous_action',
        title: `While you were away — ${titleParts.join(', ')} in "${projectName}"`,
        body: bodyParts.join('. '),
        metadata: {
          projectId,
          appliedCount: appliedFixes.length,
          pendingCount: pendingReview.length,
          actionUrl: `${appUrl}/app/projects/${projectId}/database`,
        },
      })
    }
  } catch (err: any) {
    console.warn('[AutonomousHealth] Failed to save notification:', err?.message)
  }
}
