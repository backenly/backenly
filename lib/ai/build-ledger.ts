/**
 * BUILD LEDGER — Issue 24
 * ========================
 * Per-project ledger of what was built, planned, blocked, or failed.
 * Stored in AiConfiguration.config (JSON) — no schema migration required.
 *
 * Rules:
 *   - Updated from REAL execution results — never from LLM context alone.
 *   - Injected into every prompt turn so the AI never "forgets" what was built.
 *   - Blocked items include WHY they are blocked so the AI does not re-attempt them.
 *   - UI reads the same ledger so there is no stale cache mismatch.
 */

import { prisma } from '@/lib/db/prisma'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LedgerItem {
  type: string   // 'table' | 'api' | 'bucket' | 'auth' | 'function' | 'trigger' | 'integration' | ...
  name: string
}

export interface LedgerBuiltItem extends LedgerItem {
  verifiedAt: string  // ISO timestamp of verification
}

export interface LedgerPlannedItem extends LedgerItem {
  reason: string      // Why it was planned but not yet built
}

export interface LedgerBlockedItem extends LedgerItem {
  blockedBy: string   // What is needed before this can proceed
  /**
   * Exact goal string to re-run when the blocker is resolved.
   * Populated from BlockedItem.canContinueWith during loop execution.
   * When present, the auto-resume handler uses this instead of constructing
   * a generic "implement: <name>" goal, giving the agent precise instructions.
   */
  continuationGoal?: string
}

export interface LedgerFailedItem extends LedgerItem {
  error: string       // Failure reason
}

export interface BuildLedger {
  built:   LedgerBuiltItem[]
  planned: LedgerPlannedItem[]
  blocked: LedgerBlockedItem[]
  failed:  LedgerFailedItem[]
  /** ISO timestamp of last ledger update */
  updatedAt: string
}

export type LedgerUpdate =
  | { op: 'built';   item: Omit<LedgerBuiltItem,   'verifiedAt'> & { verifiedAt?: string } }
  | { op: 'planned'; item: LedgerPlannedItem }
  | { op: 'blocked'; item: LedgerBlockedItem }
  | { op: 'failed';  item: LedgerFailedItem }
  | { op: 'unblock'; name: string }   // move a blocked item → built after credentials arrive

// ── Config key ───────────────────────────────────────────────────────────────

const LEDGER_CONFIG_KEY = '__buildLedger'

// ── Load ─────────────────────────────────────────────────────────────────────

/**
 * Load the BuildLedger for a project.
 * Returns an empty ledger if none exists yet.
 */
export async function loadBuildLedger(projectId: string): Promise<BuildLedger> {
  const empty: BuildLedger = {
    built: [],
    planned: [],
    blocked: [],
    failed: [],
    updatedAt: new Date().toISOString(),
  }

  try {
    const aiConfig = await prisma.aiConfiguration.findUnique({
      where: { projectId },
      select: { config: true },
    })

    if (!aiConfig?.config) return empty

    const config = aiConfig.config as Record<string, unknown>
    const raw = config[LEDGER_CONFIG_KEY]
    if (!raw || typeof raw !== 'object') return empty

    // Validate shape — fall back to empty if corrupt
    const ledger = raw as Partial<BuildLedger>
    return {
      built:   Array.isArray(ledger.built)   ? ledger.built   : [],
      planned: Array.isArray(ledger.planned) ? ledger.planned : [],
      blocked: Array.isArray(ledger.blocked) ? ledger.blocked : [],
      failed:  Array.isArray(ledger.failed)  ? ledger.failed  : [],
      updatedAt: typeof ledger.updatedAt === 'string' ? ledger.updatedAt : empty.updatedAt,
    }
  } catch {
    return empty
  }
}

// ── Save ─────────────────────────────────────────────────────────────────────

async function saveBuildLedger(projectId: string, ledger: BuildLedger): Promise<void> {
  try {
    const existing = await prisma.aiConfiguration.findUnique({
      where: { projectId },
      select: { config: true },
    })

    // Use JSON round-trip to satisfy Prisma's InputJsonValue constraint
    const existingConfig = (existing?.config ?? {}) as Record<string, unknown>
    const newConfig = JSON.parse(JSON.stringify({ ...existingConfig, [LEDGER_CONFIG_KEY]: ledger }))

    if (existing) {
      await prisma.aiConfiguration.update({
        where: { projectId },
        data: { config: newConfig, updatedAt: new Date() },
      })
    } else {
      await prisma.aiConfiguration.create({
        data: {
          projectId,
          model: 'gpt-4o-mini',
          config: newConfig,
        },
      })
    }
  } catch {
    // Non-fatal — ledger is a best-effort enhancement
  }
}

// ── Update ────────────────────────────────────────────────────────────────────

/**
 * Apply one or more updates to the BuildLedger.
 * Each update is idempotent — re-applying the same item is a no-op.
 */
export async function updateBuildLedger(
  projectId: string,
  updates: LedgerUpdate[],
): Promise<BuildLedger> {
  const ledger = await loadBuildLedger(projectId)
  const now = new Date().toISOString()

  for (const update of updates) {
    switch (update.op) {
      case 'built': {
        // Move out of planned/blocked/failed if present
        const name = update.item.name
        ledger.planned = ledger.planned.filter(i => i.name !== name)
        ledger.blocked = ledger.blocked.filter(i => i.name !== name)
        ledger.failed  = ledger.failed.filter(i => i.name !== name)
        // Add if not already in built
        if (!ledger.built.some(i => i.name === name && i.type === update.item.type)) {
          ledger.built.push({
            ...update.item,
            verifiedAt: update.item.verifiedAt ?? now,
          })
        }
        break
      }

      case 'planned': {
        // Only add if not already built or blocked
        const name = update.item.name
        if (
          !ledger.built.some(i => i.name === name) &&
          !ledger.planned.some(i => i.name === name)
        ) {
          ledger.planned.push(update.item)
        }
        break
      }

      case 'blocked': {
        // Remove from planned if it was there; add to blocked
        const name = update.item.name
        ledger.planned = ledger.planned.filter(i => i.name !== name)
        if (!ledger.blocked.some(i => i.name === name)) {
          ledger.blocked.push(update.item)
        }
        break
      }

      case 'failed': {
        const name = update.item.name
        ledger.planned = ledger.planned.filter(i => i.name !== name)
        if (!ledger.failed.some(i => i.name === name)) {
          ledger.failed.push(update.item)
        }
        break
      }

      case 'unblock': {
        // Move a blocked item to built (called when credentials arrive)
        const name = update.name
        const blockedItem = ledger.blocked.find(i => i.name === name)
        if (blockedItem) {
          ledger.blocked = ledger.blocked.filter(i => i.name !== name)
          if (!ledger.built.some(i => i.name === name)) {
            ledger.built.push({ type: blockedItem.type, name, verifiedAt: now })
          }
        }
        break
      }
    }
  }

  ledger.updatedAt = now
  await saveBuildLedger(projectId, ledger)
  return ledger
}

// ── Format for prompt injection ───────────────────────────────────────────────

/**
 * Format the BuildLedger into a compact block that is injected at the top of
 * every AI prompt turn.  The AI reads this block as ground truth — it must
 * never contradict what is listed here.
 */
export function formatLedgerForPrompt(ledger: BuildLedger): string {
  if (
    ledger.built.length === 0 &&
    ledger.planned.length === 0 &&
    ledger.blocked.length === 0 &&
    ledger.failed.length === 0
  ) {
    return ''
  }

  const lines: string[] = ['[BUILD LEDGER — ground truth, do not contradict]']

  if (ledger.built.length > 0) {
    const items = ledger.built.map(i => `${i.type}:${i.name}`).join(', ')
    lines.push(`  BUILT (verified): ${items}`)
  }
  if (ledger.blocked.length > 0) {
    const items = ledger.blocked.map(i => `${i.name} (${i.blockedBy})`).join(', ')
    lines.push(`  BLOCKED: ${items}`)
  }
  if (ledger.planned.length > 0) {
    const items = ledger.planned.map(i => `${i.name}`).join(', ')
    lines.push(`  PLANNED: ${items}`)
  }
  if (ledger.failed.length > 0) {
    const items = ledger.failed.map(i => `${i.name} (${i.error})`).join(', ')
    lines.push(`  FAILED: ${items}`)
  }

  return lines.join('\n')
}

// ── Helpers for bulk result processing ───────────────────────────────────────

/**
 * Convert an execution result list into LedgerUpdate[] ready to apply.
 * Used by the agent loop and integration handlers.
 */
export function resultsToLedgerUpdates(
  results: Array<{
    type: string
    name: string
    success: boolean
    error?: string
    blockedBy?: string
    continuationGoal?: string
  }>
): LedgerUpdate[] {
  return results.map(r => {
    if (r.blockedBy) {
      return {
        op: 'blocked',
        item: { type: r.type, name: r.name, blockedBy: r.blockedBy, continuationGoal: r.continuationGoal },
      } as LedgerUpdate
    }
    if (r.success) {
      return { op: 'built', item: { type: r.type, name: r.name } } as LedgerUpdate
    }
    return { op: 'failed', item: { type: r.type, name: r.name, error: r.error ?? 'unknown error' } } as LedgerUpdate
  })
}
