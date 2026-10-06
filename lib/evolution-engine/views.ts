/**
 * VIEWS — what the console and the API show of the engine, and nothing more
 * =========================================================================
 *
 * A normal user sees outcomes in sentences: what changed, whether it worked,
 * whether it helped, and that it can be undone. Internal states, rung names,
 * SQL and evidence are opt-in (`technical`, `?detail=1`), never the default.
 */

import type { LifecycleState } from './lifecycle'
import type { BenefitVerdict } from './benefit'

/** One architecture change, as the Autonomy page lists it. */
export interface ArchitectureChangeView {
  decisionId: string
  primitive: string
  /** What it is about, e.g. `orders`. */
  subject: string
  /** The latest sentence written for a person about this change. */
  headline: string
  /** What the change does, in one sentence. */
  change: string
  /** Plain status; the internal state is kept for `?detail=1` consumers only. */
  status: { label: string; tone: 'neutral' | 'attention' | 'progress' | 'good' | 'bad' }
  state: LifecycleState
  /** Why it stopped, when it did. */
  stoppedBecause?: string
  /** Whether it helped, once that could be said. */
  outcome?: { verdict: BenefitVerdict; summary: string }
  at: string
  /** Actions a person may take now. Each one goes through POST /api/projects/[id]/architecture. */
  actions: { undo: boolean; pause: boolean; resume: boolean }
  /** The approval-request finding, while one is waiting in the queue. */
  findingId?: string
}

/** A recommendation that is not proposed to run: said, explained, left alone. */
export interface RecommendationView {
  subject: string
  concernKey: string
  sentence: string
}

/** A subject the engine looked at hard and chose to leave alone, and why. */
export interface NoChangeView {
  subject: string
  reason: string
}

/** GET /api/projects/[id]/architecture — the concise default. */
export interface ArchitectureSummary {
  changes: ArchitectureChangeView[]
  /** Approval requests waiting in the Autonomy queue. */
  waitingOnYou: number
  recommendations: RecommendationView[]
  noChange: NoChangeView[]
  watching: number
  /** Whether this deployment lets approved changes run, and why not when it does not. */
  execution: { enabled: boolean; reason: string | null }
  analyzedAt: string | null
}
