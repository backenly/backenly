/**
 * DECISION MEMORY (Pillar 5.2)
 * ============================
 * After every successful AI execution, writes a structured decision entry that
 * tells the system what it decided, why, and what inferences it applied.
 *
 * Two persistence targets:
 *   1. graphData.decisionLog  — per-version graph history (appendDecisionLog)
 *   2. Project.architecturalMemory — append-only text log read by the AI prompt
 *
 * This stops the system from:
 *   - asking the same FK inference questions twice
 *   - re-applying the same RLS policy it already decided on
 *   - forgetting that the user overrode an AI default
 *
 * Called from lib/ai/minimal-executor.ts after a successful executeAction loop.
 */

import { prisma } from '@/lib/db/prisma'
import { appendDecisionLog, recordRlsPolicy, recordIntegration, recordWorkflow } from './graph-schema'
import type { AIAction } from '@/lib/ai/minimal-executor'

// ─── Public API ───────────────────────────────────────────────────────────────

export interface DecisionContext {
  /** The AI action that was successfully executed */
  action: AIAction
  /** FK inferences the executor auto-applied (column → table.column) */
  fkInferences?: Array<{ column: string; references: string }>
  /** RLS policy that was auto-applied */
  rlsApplied?: { tableName: string; template: string }
  /** Integration that was connected */
  integrationId?: string
  /** Whether any default was overridden by the user */
  userOverrode?: boolean
  /** Free-form note for complex actions */
  note?: string
}

/**
 * Write a decision memory entry for a completed executor action.
 * Non-fatal — a memory write failure must never fail the user's request.
 */
export async function writeDecisionEntry(
  projectId: string,
  ctx: DecisionContext,
): Promise<void> {
  try {
    await Promise.all([
      _writeToDecisionLog(projectId, ctx),
      _appendToArchitecturalMemory(projectId, ctx),
      _writeSideEffects(projectId, ctx),
    ])
  } catch (err) {
    console.warn('[DecisionMemory] writeDecisionEntry failed (non-fatal):', err)
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _buildDecisionText(ctx: DecisionContext): { decided: string; reason: string } {
  const { action, fkInferences, rlsApplied, integrationId, userOverrode, note } = ctx
  const p = action.params
  const tableName: string = p.tableName ?? p.junctionName ?? p.name ?? ''

  switch (action.action) {
    case 'CREATE_TABLE': {
      const fkText = fkInferences?.length
        ? `. Inferred FK${fkInferences.length > 1 ? 's' : ''}: ${fkInferences.map((f) => `${f.column} → ${f.references}`).join(', ')}`
        : ''
      const rlsText = rlsApplied ? `. Applied own_rows RLS automatically` : ''
      return {
        decided: `Created table "${tableName}"${fkText}${rlsText}`,
        reason: userOverrode
          ? 'User overrode AI defaults'
          : fkInferences?.length
          ? 'FK inference from column naming convention'
          : 'User request',
      }
    }

    case 'CREATE_JUNCTION_TABLE':
      return {
        decided: `Created junction table "${tableName}" linking ${p.tableA} ↔ ${p.tableB}`,
        reason: 'Many-to-many relationship inferred from user intent',
      }

    case 'ADD_COLUMN': {
      const fkText = fkInferences?.length
        ? ` Inferred FK: ${fkInferences[0].column} → ${fkInferences[0].references}`
        : ''
      return {
        decided: `Added column "${p.columnName}" (${p.columnType}) to "${tableName}".${fkText}`,
        reason: userOverrode ? 'User-specified type' : 'AI inferred from column name',
      }
    }

    case 'GENERATE_API':
      return {
        decided: `Generated REST API for "${tableName}" at ${p.basePath ?? `/${tableName}`}`,
        reason: 'API coverage gap — table had no endpoint',
      }

    case 'SET_PERMISSION':
    case 'REMOVE_PERMISSION':
      return {
        decided: `${action.action === 'SET_PERMISSION' ? 'Applied' : 'Removed'} "${p.template ?? p.operation}" permission on "${tableName}"`,
        reason: userOverrode ? 'User-specified policy' : 'AI auto-applied based on table shape',
      }

    case 'STORE_INTEGRATION_KEY':
      return {
        decided: `Stored integration key for "${integrationId ?? p.integrationId}"`,
        reason: 'User requested integration setup',
      }

    case 'ENABLE_AUTH':
      return {
        decided: 'Enabled email/password authentication and provisioned JWT secret',
        reason: 'Auth setup requested by user',
      }

    case 'CREATE_TRIGGER':
      return {
        decided: `Created ${p.event ?? 'insert'} trigger on "${p.sourceTable}" → "${p.targetUrl ?? p.functionName ?? 'handler'}"`,
        reason: 'Event automation requested by user',
      }

    case 'FIX_AUTH':
    case 'FIX_API':
    case 'FIX_TABLE':
    case 'FIX_DEPLOY':
    case 'FIX_REALTIME':
    case 'FIX_STORAGE':
    case 'FIX_INTEGRATION':
      return {
        decided: `Self-repaired: ${action.action.replace('FIX_', '').toLowerCase()} issue${tableName ? ` on "${tableName}"` : ''}`,
        reason: note ?? 'Workspace observer detected and auto-fixed the issue',
      }

    default:
      return {
        decided: note ?? `Executed ${action.action}${tableName ? ` on "${tableName}"` : ''}`,
        reason: 'User request',
      }
  }
}

async function _writeToDecisionLog(
  projectId: string,
  ctx: DecisionContext,
): Promise<void> {
  const { decided, reason } = _buildDecisionText(ctx)
  const p = ctx.action.params

  await appendDecisionLog(projectId, {
    decided,
    reason,
    action: ctx.action.action,
    tableName: p.tableName ?? p.junctionName ?? p.name ?? undefined,
    columnName: p.columnName ?? undefined,
    userOverrode: ctx.userOverrode,
  })
}

async function _appendToArchitecturalMemory(
  projectId: string,
  ctx: DecisionContext,
): Promise<void> {
  const { decided, reason } = _buildDecisionText(ctx)
  const date = new Date().toISOString().slice(0, 10)
  const line = `\nOn ${date}, ${decided}. Reason: ${reason}.`

  // Atomic append — COALESCE handles the initial null case
  await prisma.$executeRaw`
    UPDATE projects
    SET "architecturalMemory" = COALESCE("architecturalMemory", '') || ${line}
    WHERE id = ${projectId}
  `
}

async function _writeSideEffects(
  projectId: string,
  ctx: DecisionContext,
): Promise<void> {
  const { action, rlsApplied, integrationId } = ctx
  const p = action.params

  // Record RLS policy applied
  if (rlsApplied) {
    await recordRlsPolicy(projectId, {
      tableName: rlsApplied.tableName,
      template: rlsApplied.template,
      appliedBy: 'ai_action',
    })
  }

  // Record integration connected
  if (action.action === 'STORE_INTEGRATION_KEY' && (integrationId ?? p.integrationId)) {
    await recordIntegration(projectId, {
      integrationId: integrationId ?? p.integrationId,
    })
  }

  // Detect checkout / multi-step workflow: if a table called "orders" is created
  // alongside "order_items", record the inferred checkout workflow
  if (action.action === 'CREATE_TABLE' && p.tableName === 'orders') {
    await recordWorkflow(projectId, {
      name: 'checkout',
      steps: ['create_order', 'stripe_session', 'webhook', 'update_status'],
      invariants: ["paid_order.status === 'paid'"],
      source: 'inferred',
    })
  }
}

// ─── FK Inference Helper ──────────────────────────────────────────────────────

/**
 * Extract FK inferences from a CREATE_TABLE / ADD_COLUMN params.
 * Looks at column names ending in _id and matches them to known tables.
 * Call this in the executor BEFORE calling writeDecisionEntry so you can pass
 * the inferences as ctx.fkInferences.
 */
export function extractFkInferences(
  columns: Array<{ name: string; type?: string }>,
  knownTables: string[],
): Array<{ column: string; references: string }> {
  const tableSet = new Set(knownTables)
  const inferences: Array<{ column: string; references: string }> = []

  for (const col of columns) {
    if (!col.name.endsWith('_id') || col.name === 'id') continue
    const candidate = col.name.slice(0, -3) // strip _id
    // Try plural → singular heuristic
    const singular = candidate.endsWith('s') ? candidate.slice(0, -1) : candidate
    const ref = tableSet.has(candidate)
      ? candidate
      : tableSet.has(singular)
      ? singular
      : null
    if (ref) {
      inferences.push({ column: col.name, references: `${ref}.id` })
    }
  }

  return inferences
}
