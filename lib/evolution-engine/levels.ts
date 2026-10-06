/**
 * LEVELS — how strongly the engine believes the architecture should change
 * ========================================================================
 *
 * Detection and execution are different questions, and folding them into one
 * yes/no made the engine either too timid (it waited for damage before saying
 * anything) or too eager (anything it noticed became a migration). There are
 * four answers, and the first one is the most common and the most important:
 *
 *   no_change_recommended  the engine looked and the current shape is right.
 *                          Active development, a large table, heavy traffic:
 *                          none of these is architectural debt on its own.
 *   watching               a pattern worth following — e.g. columns that behave
 *                          as one responsibility — with nothing yet showing it
 *                          matters. No change is suggested.
 *   recommendation_only    the evidence says a different shape would likely be
 *                          better, before anything is damaged. Said, explained,
 *                          and NOT turned into a migration: either nothing has
 *                          been measured to cost anything yet, or no safe
 *                          deterministic ladder exists for it.
 *   executable_proposal    cohesive, separable, a MEASURED cost, and a concrete
 *                          deterministic plan that preserves behaviour. Still
 *                          needs a person's consent before anything runs.
 *
 * ── What can never promote a level ──────────────────────────────────────────
 *
 * Churn, size and traffic. They are reported as context and used to rank, and
 * none of them is an input to `classifyOpportunity`. Names agreeing is not an
 * input either: the primitive's own cohesion rule (two families, at least one
 * measured) has already decided whether there is a group at all.
 *
 * ── Memory can demote ───────────────────────────────────────────────────────
 *
 * A change this engine already made and that was undone — because it made
 * things worse, or because its owner pressed undo — is not proposed again on
 * the same evidence, and neither is one the owner declined. Without that, an
 * engine that learns nothing rediscovers the same idea every week and the owner
 * learns to ignore it. New evidence — a cost first measured after the reversal
 * or the refusal — lifts the hold.
 *
 * Pure.
 */

export type EvolutionLevel =
  | 'no_change_recommended'
  | 'watching'
  | 'recommendation_only'
  | 'executable_proposal'

export const LEVEL_RANK: Readonly<Record<EvolutionLevel, number>> = {
  no_change_recommended: 0,
  watching: 1,
  recommendation_only: 2,
  executable_proposal: 3,
}

/** What the engine remembers about this exact opportunity, from ./memory.ts. */
export type PriorOutcome =
  | { kind: 'none' }
  | { kind: 'reversed'; regressed: boolean; at: string }
  /** The owner said no to the request. Respected until something new is measured. */
  | { kind: 'declined'; at: string }
  | { kind: 'in_effect'; at: string }

export interface OpportunitySignals {
  /** The primitive's cohesion rule held. */
  cohesive: boolean
  /** Something MEASURED says the parts do not belong together. Vetoes everything. */
  contradicted: boolean
  /** Some support exists but the rule did not hold, often because a probe could not look. */
  partialEvidence: boolean
  /** The primitive can move it without breaking anything. */
  separable: boolean
  /** Why changing it would cost more than it saves (e.g. nearly every row carries it), if so. */
  counterproductive: string | null
  /** Costs that have actually happened: repairs, a busy table locked by a change, a list squeezed into columns. */
  measuredCost: number
  /** Forward-looking pressure: the part evolving on its own, consumers that use only it. */
  emergingPressure: number
  /** A deterministic, behaviour-preserving plan exists and the executor can run it. */
  executable: boolean
  /** Why it is not executable, when it is not. */
  notExecutableBecause?: string
  prior: PriorOutcome
  /** A measured cost first seen after the prior outcome. Lifts a memory hold. */
  newEvidenceSincePrior: boolean
}

export interface LevelDecision {
  level: EvolutionLevel
  /** One sentence, written for the owner. */
  reason: string
}

export function classifyOpportunity(s: OpportunitySignals): LevelDecision {
  if (s.contradicted) {
    return { level: 'no_change_recommended', reason: 'measurements show these parts do not behave as one responsibility' }
  }
  if (!s.cohesive) {
    return s.partialEvidence
      ? { level: 'watching', reason: 'there is a hint these parts belong together, but not enough measured evidence yet' }
      : { level: 'no_change_recommended', reason: 'nothing measured shows these parts form a separate responsibility' }
  }
  if (s.counterproductive) {
    return { level: 'no_change_recommended', reason: s.counterproductive }
  }
  if (s.prior.kind === 'in_effect') {
    return { level: 'no_change_recommended', reason: 'this change is already in effect' }
  }
  if (s.prior.kind === 'declined' && !s.newEvidenceSincePrior) {
    return {
      level: 'no_change_recommended',
      reason: 'you declined this change; it will be raised again only if something new is measured',
    }
  }
  if (s.prior.kind === 'reversed' && !s.newEvidenceSincePrior) {
    return {
      level: 'no_change_recommended',
      reason: s.prior.regressed
        ? 'the same change was made before and undone because it made things worse; nothing new has been measured since'
        : 'this change was made before and you undid it; it will be raised again only if something new is measured',
    }
  }
  const pressure = s.measuredCost + s.emergingPressure
  if (!s.separable) {
    return pressure > 0
      ? { level: 'recommendation_only', reason: `a separate home would likely be better, but it cannot be moved safely as things stand${s.notExecutableBecause ? `: ${s.notExecutableBecause}` : ''}` }
      : { level: 'watching', reason: 'these parts behave as one responsibility; nothing shows it matters yet' }
  }
  if (s.measuredCost > 0) {
    return s.executable
      ? { level: 'executable_proposal', reason: 'these parts behave as one responsibility and keeping them where they are has a measured cost' }
      : { level: 'recommendation_only', reason: `keeping these parts where they are has a measured cost, but no safe automatic change exists for it yet${s.notExecutableBecause ? `: ${s.notExecutableBecause}` : ''}` }
  }
  if (s.emergingPressure > 0) {
    return {
      level: 'recommendation_only',
      reason: 'these parts are starting to evolve on their own; nothing has been damaged, and nothing is proposed to run until a cost is measured',
    }
  }
  return { level: 'watching', reason: 'these parts behave as one responsibility; nothing shows it matters yet' }
}

export interface SubjectContext {
  subject: string
  changesInWindow: number
  windowDays: number
  rows: number | null
  requests: number | null
  /** Reasons primitives gave for leaving this subject alone, already in plain words. */
  notes: string[]
}

/** Thresholds above which "do nothing" deserves to be said out loud. */
export const NOTABLE_CHANGES = 3
export const NOTABLE_ROWS = 10_000
export const NOTABLE_REQUESTS = 1_000

/**
 * Why a subject the engine looked at hard is being left alone.
 *
 * Only for subjects where a naive system would have been tempted — busy,
 * large, or frequently changed — because that is where "no change" carries
 * information. A quiet table needs no paragraph.
 */
export function explainNoChange(c: SubjectContext): string | null {
  const parts: string[] = []
  if (c.changesInWindow >= NOTABLE_CHANGES) {
    parts.push(
      `${c.subject} changed ${c.changesInWindow} times in the last ${c.windowDays} days; frequent change is what active development looks like, not architectural debt on its own`,
    )
  }
  if (c.rows !== null && c.rows >= NOTABLE_ROWS) {
    parts.push(`it holds about ${c.rows.toLocaleString('en-US')} rows; size alone is not a reason to split a table`)
  }
  if (c.requests !== null && c.requests >= NOTABLE_REQUESTS) {
    parts.push(`it served ${c.requests.toLocaleString('en-US')} requests; traffic alone is not a reason to restructure`)
  }
  if (parts.length === 0 && c.notes.length === 0) return null
  // Sentence case, except where a sentence opens with an identifier: a table
  // called `orders` is not called `Orders`.
  const sentence = (t: string) => (t.startsWith(c.subject) ? t : t.replace(/^./, ch => ch.toUpperCase()))
  return [...parts, ...c.notes].map(sentence).join('. ') + '. No structural change recommended.'
}
