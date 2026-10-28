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
  /** One short sentence for where the change is: "Backenly improved your Orders architecture." */
  headline: string
  /**
   * The sentence or two under it: what was done and that it can be undone, why
   * it stopped, or why it is waiting. No counts, no internal names.
   */
  detail: string
  /** What the change does, in one sentence. */
  change: string
  /** Plain status. */
  status: { label: string; tone: 'neutral' | 'attention' | 'progress' | 'good' | 'bad' }
  /** The internal lifecycle state: only for `?detail=1` consumers, never by default. */
  state?: LifecycleState
  /** Why it stopped, when it did. */
  stoppedBecause?: string
  /** Why it is not carrying on by itself, when it is not: this deployment or this project does not let it. */
  waiting?: string
  /**
   * Whether it helped, once that could be said: `plain` is what a person reads;
   * `summary` has the numbers behind it, for whoever opens the details.
   */
  outcome?: { verdict: BenefitVerdict; plain: string; summary: string }
  /** What undo removes and keeps, shown before a person confirms an undo. */
  undoEffect?: string
  at: string
  /**
   * Actions a person may take now. Each one goes through POST
   * /api/projects/[id]/architecture. Pause and resume are never offered together.
   */
  actions: {
    undo: boolean
    pause: boolean
    resume: boolean
    /** A change stopped after it was in place: keep it as it is and be watched again (sent as `resume`). */
    keep: boolean
  }
  /** The approval-request finding, while one is waiting in the queue: decided there, not on the card. */
  findingId?: string
}

/**
 * Whether approved changes carry on by themselves here, and if not, why and
 * whether a person can push one on. Requests are raised only when they do.
 */
export interface Continuation {
  /** Every step, the backfill, observation and judging happen without anybody pressing anything. */
  unattended: boolean
  /** A person may carry a waiting change on with Resume (the deployment runs changes at all). */
  byHand: boolean
  /** Why not, as a sentence for a person; null when unattended. */
  why: string | null
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
