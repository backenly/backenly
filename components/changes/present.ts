/**
 * How a change reads in the console: one status label per outcome, and the
 * plain names of its lifecycle events. Shared by the list, the details and the
 * restore dialog so a state is never called two different things.
 */

import type { StatusTone } from '@/components/inspector/kit'
import type { ChangeOutcomeState, ChangeSummary } from '@/lib/changes/history'

export const OUTCOME: Record<ChangeOutcomeState, { tone: StatusTone; label: string }> = {
  healthy: { tone: 'operational', label: 'Applied · Verified' },
  unverified: { tone: 'attention', label: 'Applied · Not verified' },
  recovered: { tone: 'managed', label: 'Recovered automatically' },
  restored: { tone: 'neutral', label: 'Restored' },
  awaiting_approval: { tone: 'attention', label: 'Restore requires approval' },
  kept: { tone: 'attention', label: 'Kept · Checks failed' },
  needs_attention: { tone: 'failed', label: 'Needs attention' },
  in_progress: { tone: 'beta', label: 'In progress' },
  failed: { tone: 'paused', label: 'Not applied' },
}

export function outcomeOf(c: Pick<ChangeSummary, 'outcome' | 'status'>): { tone: StatusTone; label: string } {
  if (c.outcome.state === 'in_progress') {
    return { tone: 'beta', label: c.status === 'recovering' ? 'Restoring…' : c.status === 'verifying' ? 'Verifying…' : 'Applying…' }
  }
  return OUTCOME[c.outcome.state] ?? { tone: 'neutral', label: c.status }
}

/** Waiting for a person's decision: the row offers it directly. */
export function awaitsDecision(c: Pick<ChangeSummary, 'outcome'>): boolean {
  return c.outcome.state === 'awaiting_approval' || c.outcome.state === 'needs_attention'
}

export const EVENT: Record<string, string> = {
  checkpointed: 'Checkpoint taken',
  applied: 'Applied',
  apply_failed: 'Failed before changing anything',
  partially_applied: 'Failed part-way',
  verified: 'Verified',
  verification_inconclusive: 'Could not be fully verified',
  verification_failed: 'Failed verification',
  recovery_planned: 'Recovery checked',
  recovery_escalated: 'Sent for approval',
  recovery_started: 'Restore started',
  recovery_completed: 'Recovered',
  recovery_verified: 'Restore verified',
  recovery_failed: 'Restore did not complete',
  restored: 'Previous state restored',
  reapplied: 'Reapplied',
  manual_intervention_required: 'Automation stopped for a person',
  kept: 'Kept as it is',
  reconciled: 'Settled after an interruption',
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })
}
