/**
 * PROPOSAL STORE
 * ==============
 * Persists the currently-active Proposal for a project so follow-up turns
 * can address it by id instead of re-parsing free text.
 *
 * Storage: ProjectPreference (type='proposal', key='active'). One active
 * proposal per project at a time — generating a new one overwrites the
 * previous one. Items are mutated in place via `markItemStatus`.
 *
 * The store layer is intentionally thin: validation lives in `generator.ts`
 * (write path) and `apply.ts` (execute path). The store just persists JSON.
 */

import { prisma } from '@/lib/db/prisma'
import type { Proposal, ProposalItem, ProposalItemStatus, ProposalStatus } from './types'

const PREF_TYPE = 'proposal'
const PREF_KEY_ACTIVE = 'active'

/** Default TTL for proposals — 48 hours. After this they are returned as null. */
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000

export function newProposalId(): string {
  return `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function newItemId(index: number): string {
  return `it_${index}_${Math.random().toString(36).slice(2, 6)}`
}

/** Persist a proposal as the project's active proposal. Overwrites any prior. */
export async function saveProposal(proposal: Proposal): Promise<void> {
  await prisma.projectPreference.upsert({
    where: {
      projectId_type_key: { projectId: proposal.projectId, type: PREF_TYPE, key: PREF_KEY_ACTIVE },
    },
    create: {
      projectId: proposal.projectId,
      type: PREF_TYPE,
      key: PREF_KEY_ACTIVE,
      value: JSON.stringify(proposal),
      confidence: 1,
    },
    update: { value: JSON.stringify(proposal), confidence: 1, lastSeen: new Date() },
  })
}

/** Return the active proposal if it exists, is not expired, and is not closed. */
export async function getActiveProposal(projectId: string): Promise<Proposal | null> {
  const pref = await prisma.projectPreference.findUnique({
    where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY_ACTIVE } },
  }).catch(() => null)
  if (!pref) return null

  let proposal: Proposal
  try {
    proposal = JSON.parse(pref.value) as Proposal
  } catch {
    return null
  }

  // Expired?
  if (Date.parse(proposal.expiresAt) < Date.now()) return null

  // Terminal states are still readable for telemetry but we treat them as gone
  // from the agent's perspective so a stale "applied" proposal does not re-fire
  // when the user mentions "implement those" weeks later.
  if (proposal.status === 'applied' || proposal.status === 'closed' || proposal.status === 'expired') {
    return null
  }

  return proposal
}

/** Mark a single item's status — used by the applier as it iterates. */
export async function markItemStatus(
  projectId: string,
  proposalId: string,
  itemId: string,
  status: ProposalItemStatus,
  extras: { proof?: string; error?: string } = {},
): Promise<void> {
  const proposal = await getActiveProposal(projectId)
  if (!proposal || proposal.id !== proposalId) return

  const item = proposal.items.find(i => i.id === itemId)
  if (!item) return

  item.status = status
  if (extras.proof !== undefined) item.proof = extras.proof
  if (extras.error !== undefined) item.error = extras.error

  // Roll up proposal status from item statuses.
  proposal.status = rollupStatus(proposal.items)

  await saveProposal(proposal)
}

/** Force-close the active proposal (e.g., user said "skip"). */
export async function closeProposal(projectId: string, status: ProposalStatus = 'closed'): Promise<void> {
  const proposal = await getActiveProposal(projectId)
  if (!proposal) return
  proposal.status = status
  await saveProposal(proposal)
}

/** Compute proposal status from item statuses. */
function rollupStatus(items: ProposalItem[]): ProposalStatus {
  if (items.length === 0) return 'closed'
  const done = items.filter(i => i.status === 'done').length
  const inProgress = items.filter(i => i.status === 'in_progress').length
  const pending = items.filter(i => i.status === 'pending').length
  const failed = items.filter(i => i.status === 'failed').length
  if (inProgress > 0) return 'partial'
  if (done > 0 && pending === 0 && failed === 0) return 'applied'
  if (done > 0 || failed > 0) return 'partial'
  return 'open'
}

/** Compute the default expiry timestamp for a fresh proposal. */
export function defaultExpiry(now: Date = new Date()): string {
  return new Date(now.getTime() + DEFAULT_TTL_MS).toISOString()
}
