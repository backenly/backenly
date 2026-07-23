/**
 * Phase 10 — Build Run Service.
 *
 * Owns persistence of conversation messages tied to a build run AND the
 * supersession protocol that keeps the chat thread coherent after refresh.
 *
 * Why this exists:
 *   Build runs can produce multiple messages (initial blocked → resumed after
 *   credentials → final verified). The legacy `saveBuildMessages` helper
 *   *deleted* prior snapshots, which is lossy and surprised users who scrolled
 *   back. This service instead marks the prior AI snapshot for the same job as
 *   `supersededAt = now` and inserts a new snapshot with `snapshotSeq + 1`.
 *
 *   The chat thread therefore stays a complete history; only the most recent
 *   non-superseded snapshot is treated as the "current build state" by the UI.
 *
 * No new Prisma models are introduced. The service stores its data in the
 * existing `ConversationMessage.metadata` JSON column. The shape is documented
 * in `lib/build-runs/types.ts`.
 */

import { prisma } from '@/lib/db/prisma'
import type { Prisma } from '@prisma/client'
import type {
  BuildResponseSummary,
  BuildSnapshotMetadata,
  ConversationMessageRecord,
  LoadedConversation,
} from './types'

/** Prisma's JSON input is fussy; this cast is the documented escape hatch. */
function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function asMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function toRecord(row: {
  id: string
  projectId: string
  role: string
  content: string
  metadata: unknown
  createdAt: Date
}): ConversationMessageRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    role: (row.role === 'user' ? 'user' : 'ai') as 'user' | 'ai',
    content: row.content,
    metadata: (row.metadata ?? null) as ConversationMessageRecord['metadata'],
    createdAt: row.createdAt,
  }
}

/**
 * Append a single user message. Returns the persisted record.
 */
export async function appendUserMessage(
  projectId: string,
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<ConversationMessageRecord> {
  const row = await prisma.conversationMessage.create({
    data: { projectId, role: 'user', content, metadata: asJson(metadata) },
    select: { id: true, projectId: true, role: true, content: true, metadata: true, createdAt: true },
  })
  return toRecord(row)
}

/**
 * Append a single AI message (no build-run semantics). Used for plain chat
 * replies, deploy cards, capability summaries, etc.
 */
export async function appendAiMessage(
  projectId: string,
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<ConversationMessageRecord> {
  const row = await prisma.conversationMessage.create({
    data: { projectId, role: 'ai', content, metadata: asJson(metadata) },
    select: { id: true, projectId: true, role: true, content: true, metadata: true, createdAt: true },
  })
  return toRecord(row)
}

interface RecordBuildSnapshotInput {
  projectId: string
  buildJobId: string
  /** User content that *triggered* this snapshot (may be redacted creds, etc.). */
  userContent: string
  /** AI markdown body — falls back to plain text when buildResponse is missing. */
  aiContent: string
  /** Structured payload powering BuildRuntimeCard hydration. */
  buildResponse?: BuildResponseSummary
  /** Optional caller metadata merged into the AI snapshot. */
  extraMetadata?: Record<string, unknown>
}

interface RecordBuildSnapshotResult {
  userMessage: ConversationMessageRecord
  aiSnapshot: ConversationMessageRecord
  supersededIds: string[]
  snapshotSeq: number
}

/**
 * Record a new build snapshot for the given run, marking older snapshots for
 * the same `buildJobId` as superseded.
 *
 * Ordering guarantees (single project):
 *   - Older snapshots receive `supersededAt` set to the current timestamp and
 *     keep their original `snapshotSeq`.
 *   - The newly inserted AI message receives `snapshotSeq = max(existing) + 1`
 *     and no `supersededAt`.
 *   - The user message is inserted as a normal user-row (no build metadata)
 *     so the conversational order reads "user said X → AI snapshot N".
 */
export async function recordBuildSnapshot(
  input: RecordBuildSnapshotInput,
): Promise<RecordBuildSnapshotResult> {
  const { projectId, buildJobId, userContent, aiContent, buildResponse, extraMetadata } = input

  // 1) Find prior AI snapshots for this build job (any snapshotSeq)
  const priorRows = await prisma.conversationMessage.findMany({
    where: { projectId, role: 'ai' },
    select: { id: true, metadata: true },
  })
  const priorForJob = priorRows.filter(row => {
    const meta = asMetadata(row.metadata)
    return meta.buildJobId === buildJobId
  })

  // 2) Determine the next snapshot sequence number
  const nextSeq = priorForJob.reduce((max, row) => {
    const meta = asMetadata(row.metadata) as BuildSnapshotMetadata
    const seq = typeof meta.snapshotSeq === 'number' ? meta.snapshotSeq : 0
    return seq > max ? seq : max
  }, 0) + 1

  // 3) Mark prior snapshots as superseded (PATCH metadata, never delete)
  const supersededAt = new Date().toISOString()
  const supersededIds: string[] = []
  for (const row of priorForJob) {
    const meta = asMetadata(row.metadata) as BuildSnapshotMetadata
    if (meta.supersededAt) continue // already superseded
    await prisma.conversationMessage.update({
      where: { id: row.id },
      data: { metadata: asJson({ ...meta, supersededAt }) },
    })
    supersededIds.push(row.id)
  }

  // 4) Insert the user message (no build metadata) and the new AI snapshot
  const userRow = await prisma.conversationMessage.create({
    data: { projectId, role: 'user', content: userContent, metadata: asJson({}) },
    select: { id: true, projectId: true, role: true, content: true, metadata: true, createdAt: true },
  })

  const aiMetadata: BuildSnapshotMetadata = {
    buildJobId,
    snapshotSeq: nextSeq,
    savedAt: new Date().toISOString(),
    noSummarize: true,
    ...(buildResponse ? { buildResponse } : {}),
    ...(extraMetadata ?? {}),
  }
  const aiRow = await prisma.conversationMessage.create({
    data: { projectId, role: 'ai', content: aiContent, metadata: asJson(aiMetadata) },
    select: { id: true, projectId: true, role: true, content: true, metadata: true, createdAt: true },
  })

  return {
    userMessage: toRecord(userRow),
    aiSnapshot: toRecord(aiRow),
    supersededIds,
    snapshotSeq: nextSeq,
  }
}

/**
 * Load the conversation thread + compute current build state.
 *
 * `messages` is ordered by (createdAt ASC, snapshotSeq ASC) so the thread
 * renders deterministically across refreshes — no async-flush flicker.
 *
 * `currentBuildState` is the AI snapshot with the highest `snapshotSeq` for
 * which `supersededAt` is unset. When no build snapshots exist or all are
 * superseded, this is `null` and the UI should not show an "active build" card.
 */
export async function loadConversation(projectId: string): Promise<LoadedConversation> {
  const rows = await prisma.conversationMessage.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, projectId: true, role: true, content: true, metadata: true, createdAt: true },
  })

  // Stable secondary sort by snapshotSeq (when defined) preserves intra-second order.
  const messages = rows.map(toRecord).sort((a, b) => {
    const ta = a.createdAt.getTime()
    const tb = b.createdAt.getTime()
    if (ta !== tb) return ta - tb
    const sa = (asMetadata(a.metadata) as BuildSnapshotMetadata).snapshotSeq ?? 0
    const sb = (asMetadata(b.metadata) as BuildSnapshotMetadata).snapshotSeq ?? 0
    return sa - sb
  })

  // Pick the most recent non-superseded snapshot. Across different buildJobIds,
  // recency wins by createdAt; within the same job, supersededAt has already
  // pruned older snapshots so the latest seq survives.
  let currentBuildState: LoadedConversation['currentBuildState'] = null
  for (const msg of messages) {
    if (msg.role !== 'ai') continue
    const meta = asMetadata(msg.metadata) as BuildSnapshotMetadata
    if (!meta.buildJobId || !meta.buildResponse) continue
    if (meta.supersededAt) continue
    const seq = typeof meta.snapshotSeq === 'number' ? meta.snapshotSeq : 0
    if (
      currentBuildState &&
      msg.createdAt.getTime() < currentBuildState.createdAt.getTime()
    ) continue
    currentBuildState = {
      messageId: msg.id,
      buildJobId: meta.buildJobId,
      snapshotSeq: seq,
      buildResponse: meta.buildResponse,
      createdAt: msg.createdAt,
    }
  }

  return { messages, currentBuildState }
}

/**
 * Helper used by tests + callers that want to know whether a particular
 * persisted message is the current (non-superseded) snapshot.
 */
export function isCurrentSnapshot(metadata: unknown): boolean {
  const meta = asMetadata(metadata) as BuildSnapshotMetadata
  if (!meta.buildJobId) return false
  return !meta.supersededAt
}

/**
 * Clear the entire conversation for a project (used by /clear). Build runs
 * vanish along with the chat — the workspace tables/APIs are untouched.
 */
export async function clearConversation(projectId: string): Promise<void> {
  await prisma.conversationMessage.deleteMany({ where: { projectId } })
}
