/**
 * WORKFLOW CORRECTNESS MONITOR
 * ============================
 * Pillar 3.4 — Detects broken end-to-end workflows.
 *
 * "Not does the orders table exist, but does order → payment → status
 *  update actually work."
 *
 * Each KNOWN_WORKFLOW checks that all required components are present AND
 * wired together. A workflow finding tells the user exactly which component
 * is missing and how to fix it, not just that something is wrong.
 *
 * Add new workflows here as the platform gains integration breadth.
 */

import { prisma } from '@/lib/db/prisma'
import { hasIntegrationKey } from '@/lib/services/integrationKeyStore'
import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { notReservedTableSql } from '@/lib/security/workspace-schema'
import type { RawFinding } from './types'

// ─── Workflow Registry ────────────────────────────────────────────────────────

interface WorkflowCheck {
  name: string
  displayName: string
  verify: (projectId: string) => Promise<WorkflowVerifyResult>
}

interface WorkflowVerifyResult {
  healthy: boolean
  missingComponents: string[]
  presentComponents: string[]
}

const KNOWN_WORKFLOWS: WorkflowCheck[] = [
  {
    name: 'stripe_checkout',
    displayName: 'Stripe Checkout',
    verify: verifyStripeCheckout,
  },
  {
    name: 'user_auth_flow',
    displayName: 'User Auth Flow',
    verify: verifyUserAuthFlow,
  },
  {
    name: 'realtime_notifications',
    displayName: 'Realtime Notifications',
    verify: verifyRealtimeNotifications,
  },
]

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run all workflow correctness checks for a project.
 * Only checks workflows where at least one required component is present
 * (avoids noise for projects that don't use a particular workflow).
 */
export async function verifyWorkflows(projectId: string): Promise<RawFinding[]> {
  const findings: RawFinding[] = []

  for (const workflow of KNOWN_WORKFLOWS) {
    try {
      const result = await workflow.verify(projectId)

      // Only report if the workflow is partially or fully broken AND at least one
      // component is present (avoids false positives for unused workflows)
      if (!result.healthy && result.presentComponents.length > 0) {
        findings.push({
          type: 'workflow_broken',
          severity: 'warning',
          details: {
            workflow: workflow.name,
            displayName: workflow.displayName,
            missingComponents: result.missingComponents,
            presentComponents: result.presentComponents,
            reason: `Workflow "${workflow.displayName}" is incomplete: missing ${result.missingComponents.join(', ')}`,
          },
          autoFixable: false,
        })
      }
    } catch {
      // Per-workflow errors are swallowed — one broken check must not stop others
    }
  }

  return findings
}

// ─── Workflow Implementations ─────────────────────────────────────────────────

async function verifyStripeCheckout(projectId: string): Promise<WorkflowVerifyResult> {
  const present: string[] = []
  const missing: string[] = []

  const check = async (label: string, predicate: () => Promise<boolean>) => {
    const ok = await predicate().catch(() => false)
    ok ? present.push(label) : missing.push(label)
    return ok
  }

  // Stripe API key stored
  await check('stripe_key', () => hasIntegrationKey(projectId, 'stripe'))

  // orders or payments table exists in the workspace DB
  const schema = `workspace_${projectId}`
  await check('orders_or_payments_table', async () => {
    const rows = await queryWorkspaceSchema(
      projectId,
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name IN ('orders', 'payments', 'subscriptions')
       LIMIT 1`,
      schema,
    )
    const r: unknown[] = rows?.rows ?? rows ?? []
    return r.length > 0
  })

  // Stripe webhook endpoint exists as an AiFunction or AppTrigger
  await check('stripe_webhook_handler', async () => {
    const fn = await prisma.aiFunction.findFirst({
      where: { projectId, name: { contains: 'stripe' }, status: 'active' },
      select: { id: true },
    })
    if (fn) return true

    const trigger = await prisma.appTrigger.findFirst({
      where: { projectId, webhookUrl: { contains: 'stripe' }, enabled: true },
      select: { id: true },
    })
    return !!trigger
  })

  // status update trigger wired (orders/payments table has update trigger or AI function)
  await check('status_update_trigger', async () => {
    const trigger = await prisma.appTrigger.findFirst({
      where: {
        projectId,
        enabled: true,
        event: { in: ['update', 'all'] },
        sourceTable: { in: ['orders', 'payments', 'subscriptions'] },
      },
      select: { id: true },
    })
    if (trigger) return true

    const fn = await prisma.aiFunction.findFirst({
      where: {
        projectId,
        status: 'active',
        triggerType: { in: ['on_db_update', 'on_db_insert'] },
        triggerTable: { in: ['orders', 'payments', 'subscriptions'] },
      },
      select: { id: true },
    })
    return !!fn
  })

  return { healthy: missing.length === 0, missingComponents: missing, presentComponents: present }
}

async function verifyUserAuthFlow(projectId: string): Promise<WorkflowVerifyResult> {
  const present: string[] = []
  const missing: string[] = []

  const check = async (label: string, predicate: () => Promise<boolean>) => {
    const ok = await predicate().catch(() => false)
    ok ? present.push(label) : missing.push(label)
    return ok
  }

  // Anchor: the workspace users table. The runtime creates it lazily on the
  // first real signup (ensureAuthUsersTable), so its absence means end-user
  // auth is simply not in use yet — not a broken workflow. Without this gate
  // every empty project was flagged, because the vacuously-true user_data_rls
  // check below counted as a "present component".
  const schema = `workspace_${projectId}`
  const usersRows = await queryWorkspaceSchema(
    projectId,
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = 'users' LIMIT 1`,
    schema,
  ).catch(() => ({ rows: [] as unknown[] }))
  const usersTable: unknown[] = (usersRows as any)?.rows ?? usersRows ?? []
  if (usersTable.length === 0) {
    // Workflow not in use — healthy with empty components so observer skips it
    return { healthy: true, missingComponents: [], presentComponents: [] }
  }
  present.push('users_table')

  // jwtSecret set on project
  await check('jwt_secret', async () => {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { jwtSecret: true },
    })
    return !!project?.jwtSecret
  })

  // At least one PermissionPolicy on the users table (RLS enabled)
  await check('rls_on_users', async () => {
    const policy = await prisma.permissionPolicy.findFirst({
      where: { projectId, tableName: 'users', enabled: true },
      select: { id: true },
    })
    return !!policy
  })

  // At least one other table has a user_id column with RLS (end-user data is
  // protected). Skipped entirely when the project has no user-owned tables —
  // a not-applicable check is neither present nor missing evidence.
  const userDataRows = await queryWorkspaceSchema(
    projectId,
    `SELECT DISTINCT t.tablename
     FROM pg_tables t
     JOIN information_schema.columns c
       ON c.table_schema = $1 AND c.table_name = t.tablename
       AND c.column_name IN ('user_id', 'userId')
     WHERE t.schemaname = $1 AND t.tablename <> 'users'
       AND ${notReservedTableSql('t.tablename')}
     LIMIT 1`,
    schema,
  ).catch(() => ({ rows: [] as unknown[] }))
  const userDataTables: string[] = ((userDataRows as any)?.rows ?? userDataRows ?? []).map(
    (r: any) => r.tablename,
  )
  if (userDataTables.length > 0) {
    await check('user_data_rls', async () => {
      const policy = await prisma.permissionPolicy.findFirst({
        where: { projectId, tableName: { in: userDataTables }, enabled: true },
        select: { id: true },
      })
      return !!policy
    })
  }

  return { healthy: missing.length === 0, missingComponents: missing, presentComponents: present }
}

async function verifyRealtimeNotifications(projectId: string): Promise<WorkflowVerifyResult> {
  const present: string[] = []
  const missing: string[] = []

  const check = async (label: string, predicate: () => Promise<boolean>) => {
    const ok = await predicate().catch(() => false)
    ok ? present.push(label) : missing.push(label)
    return ok
  }

  // At least one AppTrigger exists (realtime workflow is in use)
  const hasAnyTrigger = await prisma.appTrigger
    .count({ where: { projectId, enabled: true } })
    .then((n) => n > 0)
    .catch(() => false)

  await check('active_triggers', async () => hasAnyTrigger)

  if (!hasAnyTrigger) {
    // Workflow not in use — return healthy with empty components so observer skips it
    return { healthy: true, missingComponents: [], presentComponents: [] }
  }

  // Tables with triggers should have ApiDefinitions (so SDK can subscribe)
  await check('api_definitions_for_trigger_tables', async () => {
    const triggers = await prisma.appTrigger.findMany({
      where: { projectId, enabled: true },
      select: { sourceTable: true },
    })
    const triggerTables = [...new Set(triggers.map((t) => t.sourceTable))]

    for (const tableName of triggerTables) {
      const table = await prisma.table.findFirst({
        where: { projectId, name: tableName },
        include: { apiDefinition: { select: { id: true } } },
      })
      if (!table?.apiDefinition) return false
    }
    return true
  })

  // Workspace DB must have been provisioned (realtime uses PostgreSQL LISTEN/NOTIFY)
  await check('workspace_provisioned', async () => {
    const ws = await prisma.workspace.findFirst({
      where: { projectId },
      select: { databaseProvisioned: true },
    })
    return !!ws?.databaseProvisioned
  })

  return { healthy: missing.length === 0, missingComponents: missing, presentComponents: present }
}
