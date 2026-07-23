/**
 * PROPOSAL APPLIER
 * ================
 * Dispatches the items of a Proposal through the existing `executeAction`
 * surface. This is the "agent acting on its own prior plan" half of the
 * agentic loop — by the time we reach here, the user has confirmed the
 * proposal (or a subset), so we run each executable item, mark its status,
 * and aggregate a report.
 *
 * Verification: `executeAction` already returns a typed ExecutionResult
 * (success / error / message). We surface those verbatim; we don't try to
 * second-guess the executor. Items that fail are marked `failed` with the
 * underlying error so the renderer can show them clearly.
 */

import { executeAction } from '../minimal-executor'
import type { AIAction } from '../minimal-executor'
import { closeProposal, getActiveProposal, markItemStatus, saveProposal } from './store'
import { renderApplyReport } from './renderer'
import type {
  ApplyProposalReport,
  ApplyScope,
  Proposal,
  ProposalActionKind,
  ProposalItem,
} from './types'

export interface ApplyProposalOptions {
  proposal: Proposal
  projectId: string
  sessionToken?: string
  scope?: ApplyScope
  /** Optional per-item progress hook for SSE emit. */
  onProgress?: (event: { type: 'start' | 'done' | 'fail' | 'skip'; item: ProposalItem }) => void
  /** Executor seam — defaults to the real `executeAction`. Overridable so the
   *  applier can be unit-tested without mocking the 8k-line executor module. */
  executor?: typeof executeAction
}

/** Map ProposalActionKind → AIAction.action discriminant. */
const KIND_TO_ACTION: Partial<Record<ProposalActionKind, AIAction['action']>> = {
  create_table: 'CREATE_TABLE',
  alter_table: 'ADD_COLUMN', // legacy — most "alter" items map to ADD_COLUMN
  add_column: 'ADD_COLUMN',
  add_index: 'CREATE_INDEX',
  add_constraint: 'ADD_CONSTRAINT',
  rename_column: 'RENAME_COLUMN',
  generate_api: 'GENERATE_API',
  enable_auth: 'ENABLE_AUTH',
  add_provider: 'ADD_PROVIDER',
  create_bucket: 'CREATE_BUCKET',
  delete_bucket: 'DELETE_BUCKET',
  set_permission: 'SET_PERMISSION',
  add_rls: 'SET_PERMISSION',
  create_trigger: 'CREATE_TRIGGER',
  enable_realtime: 'ENABLE_REALTIME',
  fix_auth: 'FIX_AUTH',
  fix_api: 'FIX_API',
  fix_table: 'FIX_TABLE',
  fix_integration: 'FIX_INTEGRATION',
  fix_workflow: 'FIX_WORKFLOW',
  generate_function: 'GENERATE_FUNCTION',
  create_cron_job: 'CREATE_CRON_JOB',
  enable_integration: 'STORE_INTEGRATION_KEY',
}

/** Select the items in scope. `executable_only` and `all` both return every
 *  item — the difference is whether non-executable items are *attempted*
 *  (handled in the loop). Returning everything for `executable_only` keeps
 *  the report informative: the user sees skipped items and why, instead of
 *  a silent no-op. */
function pickItems(proposal: Proposal, scope: ApplyScope = 'executable_only'): ProposalItem[] {
  if (typeof scope === 'object' && Array.isArray(scope.itemIds)) {
    const wanted = new Set(scope.itemIds)
    return proposal.items.filter(i => wanted.has(i.id))
  }
  return proposal.items
}

/** Dispatch each item through `executeAction` and aggregate a report. */
export async function applyProposal(opts: ApplyProposalOptions): Promise<ApplyProposalReport> {
  const { proposal, projectId, sessionToken, scope = 'executable_only', onProgress } = opts
  const exec = opts.executor ?? executeAction

  const selected = pickItems(proposal, scope)
  // `all` forces an attempt even on items the generator tagged non-executable
  // (the user explicitly asked for everything). Every other scope respects
  // the executable flag and reports the rest as skipped.
  const forceAll = scope === 'all'
  const report: ApplyProposalReport = {
    proposalId: proposal.id,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    items: [],
    markdown: '',
  }

  for (const item of selected) {
    // Items the agent already knows it can't run get a clean "skipped" entry —
    // no executor call, but they still appear in the report so the user sees
    // why nothing happened for that line.
    if (!item.executable && !forceAll) {
      onProgress?.({ type: 'skip', item })
      report.skipped++
      report.items.push({ id: item.id, title: item.title, status: 'skipped' })
      await markItemStatus(projectId, proposal.id, item.id, 'skipped', {
        error: item.blockerReason ?? (item.blocker ?? 'not executable'),
      }).catch(() => {})
      continue
    }

    const aiAction = mapToAIAction(item)
    if (!aiAction) {
      onProgress?.({ type: 'fail', item })
      report.failed++
      report.items.push({
        id: item.id,
        title: item.title,
        status: 'failed',
        error: `Unknown action kind: ${item.actionKind}`,
      })
      await markItemStatus(projectId, proposal.id, item.id, 'failed', {
        error: `Unknown action kind: ${item.actionKind}`,
      }).catch(() => {})
      continue
    }

    report.attempted++
    onProgress?.({ type: 'start', item })
    await markItemStatus(projectId, proposal.id, item.id, 'in_progress').catch(() => {})

    try {
      const result = await exec(aiAction, projectId, sessionToken)
      if (result.success) {
        const proof = (result as any).message ?? 'Applied'
        report.succeeded++
        report.items.push({ id: item.id, title: item.title, status: 'done', proof: clipProof(proof) })
        await markItemStatus(projectId, proposal.id, item.id, 'done', { proof: clipProof(proof) }).catch(() => {})
        onProgress?.({ type: 'done', item: { ...item, status: 'done', proof: clipProof(proof) } })
      } else {
        const err = (result as any).error ?? (result as any).message ?? 'Execution failed'
        report.failed++
        report.items.push({ id: item.id, title: item.title, status: 'failed', error: clipProof(err) })
        await markItemStatus(projectId, proposal.id, item.id, 'failed', { error: clipProof(err) }).catch(() => {})
        onProgress?.({ type: 'fail', item: { ...item, status: 'failed', error: clipProof(err) } })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Execution threw'
      report.failed++
      report.items.push({ id: item.id, title: item.title, status: 'failed', error: clipProof(msg) })
      await markItemStatus(projectId, proposal.id, item.id, 'failed', { error: clipProof(msg) }).catch(() => {})
      onProgress?.({ type: 'fail', item: { ...item, status: 'failed', error: clipProof(msg) } })
    }
  }

  // Roll the proposal to a terminal state when there is nothing pending left.
  const anyPending = proposal.items.some(i => i.status === 'pending' || i.status === 'in_progress')
  if (!anyPending) {
    await closeProposal(projectId, report.failed === 0 ? 'applied' : 'partial').catch(() => {})
  }

  // Render the markdown summary so callers can drop it straight into a chat
  // response without re-importing the renderer.
  report.markdown = renderApplyReport(report)

  return report
}

function mapToAIAction(item: ProposalItem): AIAction | null {
  const action = KIND_TO_ACTION[item.actionKind]
  if (!action) return null
  return {
    action,
    params: (item.params ?? {}) as any,
    reasoning: `Proposal item: ${item.title}`,
    confidence: 0.9,
  }
}

function clipProof(s: string): string {
  if (s.length <= 240) return s
  return `${s.slice(0, 237)}…`
}

/** Convenience helper: load active proposal and apply it. Returns null when
 *  no active proposal exists. Used by the proposal-stage pipeline entry. */
export async function loadAndApplyActiveProposal(opts: {
  projectId: string
  sessionToken?: string
  scope?: ApplyScope
  onProgress?: ApplyProposalOptions['onProgress']
}): Promise<ApplyProposalReport | null> {
  const proposal = await getActiveProposal(opts.projectId)
  if (!proposal) return null
  // Persist a fresh copy so the in-progress markers survive partial failures
  // even if the upsert race ahead of markItemStatus.
  await saveProposal(proposal).catch(() => {})
  return applyProposal({
    proposal,
    projectId: opts.projectId,
    sessionToken: opts.sessionToken,
    scope: opts.scope,
    onProgress: opts.onProgress,
  })
}
