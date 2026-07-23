/**
 * Phase 10 — Conversation History + BuildRun Snapshot Cleanup.
 *
 * These are *service-layer* types. We deliberately do NOT introduce new Prisma
 * models in this phase. Build-run state is stored as enriched metadata on the
 * existing `ConversationMessage` table. If/when we need to query build runs
 * independently we can promote these into dedicated `BuildRun` /
 * `BuildRunSnapshot` Prisma models without changing the call sites that depend
 * on this service.
 *
 * Conceptual model:
 *   BuildRun           — one user request that triggered the build runtime.
 *                        Identified by `buildJobId`.
 *   BuildRunSnapshot   — a point-in-time view of the run (initial result,
 *                        post-credentials view, etc.). Persisted as an AI
 *                        ConversationMessage with snapshot metadata.
 *   ConversationMessage — every user / AI line in the chat thread.
 */

export interface BuildResponseSummary {
  mode?: 'plan' | 'build'
  built?: Array<{ id: string; label: string; detail?: string }>
  verified?: string[]
  partial?: Array<{ id: string; label: string; detail?: string }>
  blocked?: Array<{
    id: string
    label: string
    reason: string
    requiredAction?: string
    integrationId?: string
    envVar?: string
  }>
  failed?: Array<{ id: string; label: string; reason: string }>
  remaining?: string[]
  next_step?: string
  jobStatus?: string
  markdown?: string
}

export interface BuildSnapshotMetadata {
  /** Identifier of the parent build run. Stable across snapshots. */
  buildJobId: string
  /** Monotonic sequence number — higher = newer snapshot. */
  snapshotSeq: number
  /** ISO-8601 timestamp set when this snapshot was overtaken by a newer one. */
  supersededAt?: string
  /** Persisted alongside the snapshot so the UI can rehydrate the build card. */
  buildResponse?: BuildResponseSummary
  /** Marker copied from legacy `saveBuildMessages` so summarizer skips it. */
  noSummarize?: boolean
  /** ISO timestamp when the snapshot was first written. */
  savedAt?: string
  /** Free-form passthrough so callers can attach extra metadata. */
  [key: string]: unknown
}

export interface ConversationMessageRecord {
  id: string
  projectId: string
  role: 'user' | 'ai'
  content: string
  metadata: BuildSnapshotMetadata | Record<string, unknown> | null
  createdAt: Date
}

export interface LoadedConversation {
  /** Full chronologically ordered transcript (oldest first). */
  messages: ConversationMessageRecord[]
  /**
   * Latest non-superseded build snapshot, if any. The UI uses this to render
   * the active build card / dashboard state. Historical snapshots stay in
   * `messages` for the scrollable thread but are tagged with `supersededAt`.
   */
  currentBuildState: {
    messageId: string
    buildJobId: string
    snapshotSeq: number
    buildResponse: BuildResponseSummary
    createdAt: Date
  } | null
}
