/**
 * CONCERNS — is there a second thing living inside this table?
 * ============================================================
 *
 * The self-healing loop keeps a backend WORKING. This asks a different
 * question, the one an engineer asks in a design review rather than an
 * incident: is the structure still the right one?
 *
 * The canonical case is the one every growing product produces. `orders` is
 * created with an id, a customer, a total and a status. A month later refunds
 * arrive as `refund_amount` and `refund_reason`; then `refunded_at`; then
 * coupons; then a discount. Each change was verified, each change works, and
 * `orders` is now four concerns sharing one row, one lock, one set of grants and
 * one migration path. Every future change to refunds is a change to the table
 * that takes the checkout traffic. Nothing is broken, so nothing the healing
 * loop watches will ever fire. That is exactly why a separate engine has to.
 *
 * ── What counts as evidence, and what does not ──────────────────────────────
 *
 * A concern is a set of columns that belong together and apart from the rest of
 * the row. Five independent families of evidence can speak to that:
 *
 *   lexical      they are named for the same thing          (a guess)
 *   co_presence  they are NULL together and set together   (measured, rows)
 *   cohort       they arrived after the table did           (measured, history)
 *   lifecycle    they are set long after the row is created (measured, rows)
 *   reference    they point at another entity              (catalog)
 *
 * Each family answers `supports`, `contradicts`, `silent` (it ran and has no
 * opinion) or `unavailable` (it could not run). The last two are different
 * facts and are never merged: a probe that did not run is not a probe that
 * found nothing, which is the rule `hypothesis/structural.ts` exists to enforce
 * and the rule this module inherits.
 *
 * Cohesion needs TWO supporting families, at least one of them measured, and no
 * family that measured the opposite. Names alone never qualify — a shared
 * prefix proposes a group, it does not prove one.
 *
 * ── Churn is an amplifier, never a detector ─────────────────────────────────
 *
 * The obvious detector is "this table keeps changing". It is also wrong: churn
 * is what active building looks like, and a system that files proposals against
 * the healthiest, busiest part of a backend trains its owner to ignore it. The
 * subsystem-recurrence gate learned this first, and `firesConcernExtraction`
 * follows it: churn is not a parameter. It cannot fire a proposal because the
 * function that decides cannot see it.
 *
 * What CAN fire one is a measured cost of keeping the concern where it is:
 *
 *   repeating_group     the concern is a list squeezed into numbered columns,
 *                       so it has a hard ceiling (`coupon_1`, `coupon_2`)
 *   attributed_repairs  the healing loop has had to repair these columns
 *   hot_host_change     a change to this concern took an exclusive lock on a
 *                       table that was serving real traffic at the time
 *
 * The last one is the honest form of "they keep patching orders". A table being
 * built has no traffic and cannot produce it; a live checkout table being
 * altered for a refund feature can, and each such change is a real cost that
 * already happened. How OFTEN it happened only ranks the proposal.
 *
 * Pure. Every input is a value; the database lives in ./sensing.ts.
 */

import type { TableFacts } from './facts'
import { readName, hostStem, defaultSatelliteName, isBookkeeping, singular } from './lexicon'
import {
  classifyOpportunity,
  explainNoChange,
  LEVEL_RANK,
  type EvolutionLevel,
  type PriorOutcome,
} from '@/lib/evolution-engine/levels'

// ── Thresholds ───────────────────────────────────────────────────────────────

/** A column must be set on at least this many sampled rows to be measured. */
export const MIN_PRESENT = 5
/** Minimum pairwise Jaccard of non-NULL rows for co-presence to support. */
export const COPRESENCE_SUPPORTS = 0.9
/** Below this the columns are measurably NOT set together. */
export const COPRESENCE_CONTRADICTS = 0.5
/**
 * A concern carried by at least this share of rows is not optional.
 *
 * Splitting a dense concern adds a join to every read and removes no cost, so
 * it is reported and never proposed.
 */
export const DENSE_PRESENCE = 0.9
/** Rows needed before density is a measurement rather than an anecdote. */
export const MIN_ROWS_FOR_DENSITY = 20
/** A concern set a median of an hour or more after creation has its own lifecycle. */
export const LIFECYCLE_MIN_LAG_SECONDS = 3600
export const MIN_LAG_SAMPLES = 5
/** Requests to the host in the window that make an exclusive lock a real cost. */
export const HOT_REQUESTS = 1000
/** ...or rows, for a table mostly reached outside the request log. */
export const HOT_ROWS = 10_000
/** "Each month" is the pattern; three months is the window that sees it. */
export const WINDOW_DAYS = 90

// ── Inputs ───────────────────────────────────────────────────────────────────

/**
 * NULL-ness of the candidate columns over a bounded sample of rows.
 *
 * One string per row, one character per column in `columns` order. Compact on
 * purpose: the sample is capped, but a wide table times five thousand rows is
 * still a lot of booleans to carry as objects.
 */
export interface PresenceSample {
  columns: string[]
  rows: string[]
  /** Seconds between the host's creation timestamp and each timestamp column, where both are set. */
  lags: Record<string, number[]>
  creationColumn: string | null
  method: 'full' | 'sample'
}

export interface ColumnBirth {
  /** Snapshot version the column first appeared in, or null when it predates history. */
  version: number | null
  at: string | null
}

export interface ConcernChangeEvent {
  version: number
  at: string
  columns: string[]
  kinds: Array<'added' | 'altered'>
}

export interface ColumnHistory {
  available: boolean
  reason?: string
  /** The snapshot version the host first appears in, or null when it predates history. */
  hostBirthVersion: number | null
  births: Record<string, ColumnBirth>
  events: ConcernChangeEvent[]
}

export interface Consumer {
  kind: 'ai_function' | 'app_trigger' | 'db_trigger'
  id: string
  name: string
  columns: string[]
}

export interface RepairRecord {
  findingId: string
  type: string
  column: string
  at: string
}

export interface PressureInputs {
  windowDays: number
  repairs: RepairRecord[]
  /** Requests served for the host in the window, or null when unreadable. */
  hostRequests: number | null
  /**
   * Consumers that name ANY column of the host, with every host column each
   * one names — so a consumer that uses only one concern can be told apart from
   * one that uses the whole row.
   */
  consumers: Consumer[]
  now: Date
}

export interface TableAnalysisInput {
  facts: TableFacts
  presence: PresenceSample | null
  presenceUnavailableReason?: string
  history: ColumnHistory
  pressure: PressureInputs
  /**
   * What architecture memory recalls, keyed by concern (`<host>:<label>`, see
   * `concernKeyOf`). Keyed by concern rather than by column list so that a
   * column joining the group after a reversal does not erase what was learned.
   * Absent means nothing is remembered.
   */
  priors?: Record<string, PriorOutcome>
}

// ── Outputs ──────────────────────────────────────────────────────────────────

export type EvidenceFamily = 'lexical' | 'co_presence' | 'cohort' | 'lifecycle' | 'reference'
export type FamilyVerdict = 'supports' | 'contradicts' | 'silent' | 'unavailable'

export interface FamilyFinding {
  family: EvidenceFamily
  verdict: FamilyVerdict
  detail: string
}

/** Costs that have actually happened. Only these can make a change executable. */
export type PressureKind = 'repeating_group' | 'attributed_repairs' | 'hot_host_change'

/**
 * Pressure that has not cost anything yet: the concern changing on its own,
 * consumers that use only it. Enough to RECOMMEND, before anything is damaged;
 * never enough to propose running a migration.
 */
export type EmergingKind = 'independent_evolution' | 'specialized_consumers'

export interface PressureSignal {
  kind: PressureKind
  detail: string
  /** When the cost was last incurred, if it has a time. */
  at?: string
}

export interface EmergingSignal {
  kind: EmergingKind
  detail: string
}

export type ConcernShape =
  | 'optional_one_to_one'
  | 'repeating_group'
  | 'dense_one_to_one'

export interface Separability {
  /** Anything here means no ladder may be built for this concern. */
  expandBlockers: string[]
  /**
   * What a person must migrate before the legacy columns could be dropped.
   * Never blocks the ladder: `contract` is human-only and the ladder is
   * complete without it.
   */
  contractBlockers: string[]
  caveats: string[]
}

/**
 * The stable name of WHAT is being reorganised: the host and the word its
 * columns are named for. Architecture memory ties decisions together by it.
 */
export function concernKeyOf(host: string, label: string): string {
  return `${host}:${label}`
}

export interface ConcernAssessment {
  key: string
  /** `<host>:<label>`; survives the column list changing. See `concernKeyOf`. */
  concernKey: string
  host: string
  /** The word the columns are named for, as written (`refund`). */
  label: string
  members: string[]
  families: FamilyFinding[]
  cohesive: boolean
  presenceRate: number | null
  shape: ConcernShape
  separability: Separability
  pressure: PressureSignal[]
  amplifiers: {
    changeEventsInWindow: number
    consumers: number
    hostRequests: number | null
    hostRows: number | null
  }
  priority: { score: number; label: 'high' | 'medium' | 'low' }
  /** The churn-blind gate: cohesive, separable, not dense, a measured cost. */
  fires: boolean
  /** Forward-looking pressure. Can raise a recommendation, never a migration. */
  emerging: EmergingSignal[]
  /** The engine's level for this concern, before the plan's own validity is known. */
  level: EvolutionLevel
  levelReason: string
  /** What this change keeps exactly as it is, and what it deliberately does not decide. */
  semanticBoundary: string
  /** One sentence: why this is or is not proposed. */
  verdict: string
  defaultSatellite: string
}

export interface TableAssessment {
  table: string
  rows: number | null
  core: string[]
  eligible: string[]
  concerns: ConcernAssessment[]
  /** The table as a whole: the highest level any concern reached, and why nothing changes if nothing does. */
  subject: { level: EvolutionLevel; noChangeReason: string | null; changesInWindow: number }
  coverage: {
    presence: 'measured' | 'unavailable'
    presenceDetail?: string
    history: 'available' | 'unavailable'
    historyDetail?: string
  }
}

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * Whether a concern is proposed for extraction. Pure, and churn-blind.
 *
 * Note what is absent: change count, table width, consumer count, priority.
 * Those order proposals and none of them may create one. A future edit that
 * wants churn to fire a proposal has to change this signature, which is the
 * point.
 */
export function firesConcernExtraction(input: {
  supporting: EvidenceFamily[]
  contradicting: EvidenceFamily[]
  separable: boolean
  dense: boolean
  pressureCount: number
}): boolean {
  return (
    isCohesive(input.supporting, input.contradicting) &&
    input.separable &&
    !input.dense &&
    input.pressureCount >= 1
  )
}

/** Two supporting families, one of them measured, none measuring the opposite. */
export function isCohesive(supporting: EvidenceFamily[], contradicting: EvidenceFamily[]): boolean {
  const distinct = new Set(supporting)
  return distinct.size >= 2 && [...distinct].some(f => f !== 'lexical') && contradicting.length === 0
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TIMESTAMP_UDTS = new Set(['timestamptz', 'timestamp', 'date'])
const CREATION_COLUMNS = ['created_at', 'inserted_at', 'createdAt', 'created', 'creation_date', 'created_on']

export function creationColumn(facts: TableFacts): string | null {
  for (const name of CREATION_COLUMNS) {
    const c = facts.columns.find(x => x.name === name)
    if (c && TIMESTAMP_UDTS.has(c.udt)) return c.name
  }
  return null
}

export function timestampColumns(facts: TableFacts, among: string[]): string[] {
  const set = new Set(among)
  return facts.columns.filter(c => set.has(c.name) && TIMESTAMP_UDTS.has(c.udt)).map(c => c.name)
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function humanDuration(seconds: number): string {
  if (seconds >= 86_400) return `${(seconds / 86_400).toFixed(1)} days`
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} hours`
  return `${Math.round(seconds / 60)} minutes`
}

class UnionFind {
  private parent = new Map<string, string>()
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x)
    let r = x
    while (this.parent.get(r) !== r) r = this.parent.get(r)!
    this.parent.set(x, r)
    return r
  }
  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    if (ra < rb) this.parent.set(rb, ra)
    else this.parent.set(ra, rb)
  }
  groups(members: string[]): string[][] {
    const out = new Map<string, string[]>()
    for (const m of members) {
      const r = this.find(m)
      out.set(r, [...(out.get(r) ?? []), m])
    }
    return [...out.values()].map(g => g.sort())
  }
}

/** Per-column set of sampled row indexes where the column is non-NULL. */
function presenceSets(sample: PresenceSample): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  sample.columns.forEach((c, ci) => {
    const s = new Set<number>()
    sample.rows.forEach((bits, ri) => {
      if (bits[ci] === '1') s.add(ri)
    })
    out.set(c, s)
  })
  return out
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

// ── Core and eligible columns ────────────────────────────────────────────────

/**
 * Which columns could ever leave the table.
 *
 * Conservative by construction: the primary key, anything another table points
 * at, anything NOT NULL, generated or an identity, bookkeeping, and anything
 * named for the row itself stay. What remains is optional data with a name
 * that says what it is about.
 */
export function partitionColumns(facts: TableFacts): { core: string[]; eligible: string[] } {
  const hs = hostStem(facts.table)
  const pinned = new Set<string>([
    ...facts.primaryKey,
    ...facts.inboundForeignKeys.flatMap(f => f.columns),
  ])
  const core: string[] = []
  const eligible: string[] = []
  for (const c of facts.columns) {
    const reading = readName(c.name, hs)
    const stays =
      pinned.has(c.name) || c.notNull || c.generated || c.identity || reading.stem === null
    ;(stays ? core : eligible).push(c.name)
  }
  return { core, eligible }
}

// ── Candidates ───────────────────────────────────────────────────────────────

interface Candidate {
  members: string[]
  origins: Set<'lexical' | 'co_presence' | 'cohort'>
}

function candidateGroups(
  facts: TableFacts,
  eligible: string[],
  sets: Map<string, Set<number>> | null,
  history: ColumnHistory,
): Candidate[] {
  const hs = hostStem(facts.table)
  const byKey = new Map<string, Candidate>()
  const add = (members: string[], origin: 'lexical' | 'co_presence' | 'cohort') => {
    if (members.length < 2) return
    const sorted = [...members].sort()
    const key = sorted.join(',')
    const c = byKey.get(key) ?? { members: sorted, origins: new Set() }
    c.origins.add(origin)
    byKey.set(key, c)
  }

  // Lexical: one group per stem.
  const byStem = new Map<string, string[]>()
  for (const col of eligible) {
    const s = readName(col, hs).stem
    if (s) byStem.set(s, [...(byStem.get(s) ?? []), col])
  }
  for (const g of byStem.values()) add(g, 'lexical')

  // Co-presence: columns set on the same rows, connected.
  if (sets) {
    const uf = new UnionFind()
    const measurable = eligible.filter(c => (sets.get(c)?.size ?? 0) >= MIN_PRESENT)
    for (let i = 0; i < measurable.length; i++) {
      for (let j = i + 1; j < measurable.length; j++) {
        const a = sets.get(measurable[i])!
        const b = sets.get(measurable[j])!
        if (jaccard(a, b) >= COPRESENCE_SUPPORTS) uf.union(measurable[i], measurable[j])
      }
    }
    for (const g of uf.groups(measurable)) add(g, 'co_presence')
  }

  // Cohort: born in the same change, after the host. A host that predates
  // the history has no birth version, and any column with a known birth was
  // then necessarily added later.
  if (history.available) {
    const after = history.hostBirthVersion ?? -Infinity
    const byVersion = new Map<number, string[]>()
    for (const col of eligible) {
      const v = history.births[col]?.version
      if (v !== null && v !== undefined && v > after) {
        byVersion.set(v, [...(byVersion.get(v) ?? []), col])
      }
    }
    for (const g of byVersion.values()) add(g, 'cohort')
  }

  return [...byKey.values()]
}

// ── Families ─────────────────────────────────────────────────────────────────

function evaluateFamilies(
  facts: TableFacts,
  members: string[],
  sample: PresenceSample | null,
  sampleUnavailable: string | undefined,
  sets: Map<string, Set<number>> | null,
  history: ColumnHistory,
): FamilyFinding[] {
  const hs = hostStem(facts.table)
  const out: FamilyFinding[] = []

  // lexical
  const stems = new Set(members.map(m => readName(m, hs).stem))
  out.push(
    stems.size === 1 && !stems.has(null)
      ? { family: 'lexical', verdict: 'supports', detail: `all named for "${readName(members[0], hs).word}"` }
      : { family: 'lexical', verdict: 'silent', detail: 'the names do not share a subject' },
  )

  // co_presence
  if (!sample || !sets) {
    out.push({
      family: 'co_presence',
      verdict: 'unavailable',
      detail: sampleUnavailable ?? 'rows could not be sampled',
    })
  } else {
    const thin = members.filter(m => (sets.get(m)?.size ?? 0) < MIN_PRESENT)
    if (thin.length > 0) {
      out.push({
        family: 'co_presence',
        verdict: 'unavailable',
        detail:
          `too few sampled rows carry ${thin.join(', ')} to measure (need ${MIN_PRESENT} each, ` +
          `${sample.rows.length} row(s) sampled)`,
      })
    } else {
      let min = 1
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          min = Math.min(min, jaccard(sets.get(members[i])!, sets.get(members[j])!))
        }
      }
      const pct = `${Math.round(min * 100)}%`
      out.push(
        min >= COPRESENCE_SUPPORTS
          ? { family: 'co_presence', verdict: 'supports', detail: `set on the same rows (lowest pairwise overlap ${pct} over ${sample.rows.length} sampled rows)` }
          : min < COPRESENCE_CONTRADICTS
            ? { family: 'co_presence', verdict: 'contradicts', detail: `set on different rows (lowest pairwise overlap ${pct}), so they are not one thing` }
            : { family: 'co_presence', verdict: 'silent', detail: `partly set together (lowest pairwise overlap ${pct})` },
      )
    }
  }

  // cohort
  if (!history.available) {
    out.push({ family: 'cohort', verdict: 'unavailable', detail: history.reason ?? 'no schema history' })
  } else if (history.hostBirthVersion === null) {
    const allKnown = members.every(m => history.births[m]?.version !== null && history.births[m]?.version !== undefined)
    out.push(
      allKnown
        ? { family: 'cohort', verdict: 'supports', detail: 'every column was added after schema history began, while the table already existed' }
        : { family: 'cohort', verdict: 'silent', detail: 'the table and some of these columns predate the schema history' },
    )
  } else {
    const births = members.map(m => history.births[m]?.version ?? null)
    const allLater = births.every(v => v !== null && v > history.hostBirthVersion!)
    const distinct = new Set(births).size
    out.push(
      allLater
        ? {
            family: 'cohort',
            verdict: 'supports',
            detail:
              distinct === 1
                ? 'added together, in one change, after the table was created'
                : `added after the table was created, across ${distinct} changes`,
          }
        : { family: 'cohort', verdict: 'silent', detail: 'some of these columns were part of the original table' },
    )
  }

  // lifecycle — the creation column is a catalog fact, read from the facts and
  // never from the sample: a blind sample must surface as `unavailable`, not
  // as "this table has no creation timestamp".
  const created = creationColumn(facts)
  const stamps = timestampColumns(facts, members)
  if (stamps.length === 0) {
    out.push({ family: 'lifecycle', verdict: 'silent', detail: 'no timestamp among these columns' })
  } else if (!created) {
    out.push({ family: 'lifecycle', verdict: 'silent', detail: 'the table has no creation timestamp to compare against' })
  } else if (!sample) {
    out.push({ family: 'lifecycle', verdict: 'unavailable', detail: sampleUnavailable ?? 'rows could not be sampled' })
  } else {
    const lags = stamps.flatMap(s => sample.lags[s] ?? [])
    if (lags.length < MIN_LAG_SAMPLES) {
      out.push({
        family: 'lifecycle',
        verdict: 'unavailable',
        detail: `only ${lags.length} row(s) carry both ${created} and ${stamps.join('/')}`,
      })
    } else {
      const m = median(lags)
      out.push(
        m >= LIFECYCLE_MIN_LAG_SECONDS
          ? { family: 'lifecycle', verdict: 'supports', detail: `set a median of ${humanDuration(m)} after the row is created — a later event in its life` }
          : { family: 'lifecycle', verdict: 'silent', detail: `set at creation time (median ${humanDuration(Math.max(0, m))} later)` },
      )
    }
  }

  // reference
  const memberSet = new Set(members)
  const fks = facts.constraints.filter(c => c.kind === 'f' && c.columns.every(col => memberSet.has(col)))
  out.push(
    fks.length > 0
      ? { family: 'reference', verdict: 'supports', detail: `refers to ${[...new Set(fks.map(f => f.refTable))].join(', ')}` }
      : { family: 'reference', verdict: 'silent', detail: 'refers to no other table' },
  )

  return out
}

// ── Separability ─────────────────────────────────────────────────────────────

/**
 * What stands in the way, split by WHEN it matters.
 *
 * Expand never removes a column from the host, so a policy, view or CHECK that
 * reads a member keeps working through the whole ladder — it only matters to
 * the person who later drops the column. Folding those into expand blockers
 * would refuse nearly every real table for a step software never takes.
 */
export function assessSeparability(
  facts: TableFacts,
  members: string[],
  consumers: Consumer[],
): Separability {
  const expandBlockers: string[] = []
  const contractBlockers: string[] = []
  const caveats: string[] = []
  const set = new Set(members)
  const touches = (cols: string[]) => cols.some(c => set.has(c))
  const within = (cols: string[]) => cols.length > 0 && cols.every(c => set.has(c))

  if (facts.relkind === 'p') expandBlockers.push(`${facts.table} is partitioned, which this ladder does not support`)
  if (facts.primaryKey.length !== 1) {
    expandBlockers.push(
      `${facts.table} has no single-column primary key for the new table to reference and for the backfill to page through`,
    )
  }
  for (const c of facts.columns.filter(c => set.has(c.name))) {
    if (c.hasColumnAcl) {
      expandBlockers.push(
        `${c.name} has column-level privileges; the new table's access is mirrored from table grants and could widen who can read it`,
      )
    }
    if (c.notNull || c.generated || c.identity) {
      expandBlockers.push(`${c.name} is NOT NULL, generated or an identity, and cannot be optional data in another table`)
    }
  }
  if (members.length < 2) expandBlockers.push('a concern needs at least two columns')

  for (const d of facts.dependents.filter(d => set.has(d.column))) {
    switch (d.kind) {
      case 'view':
        contractBlockers.push(`view ${d.object} reads ${d.column}`)
        break
      case 'policy':
        contractBlockers.push(`row-level policy ${d.object} on ${facts.table} reads ${d.column}`)
        break
      case 'generated_column':
        contractBlockers.push(`generated column ${d.object} is computed from ${d.column}`)
        break
      case 'trigger':
        contractBlockers.push(`trigger ${d.object} fires on ${d.column}`)
        break
      default:
        break
    }
  }
  for (const k of facts.constraints) {
    if (k.kind === 'p' || !touches(k.columns)) continue
    if (within(k.columns)) {
      if (k.kind === 'f' && !['a', 'r'].includes(k.onDelete ?? 'a')) {
        caveats.push(
          `${k.name} has an ON DELETE action; it stays on ${facts.table} and keeps guarding the value, and is not copied, ` +
            'because two cascades on one fact would race',
        )
      }
      continue
    }
    contractBlockers.push(`constraint ${k.name} spans these columns and the rest of the row (${k.columns.join(', ')})`)
  }
  for (const f of facts.inboundForeignKeys) {
    if (touches(f.columns)) contractBlockers.push(`${f.fromTable}.${f.name} references ${f.columns.join(', ')}`)
  }
  for (const i of facts.indexes) {
    if (i.constraintBacked || !touches(i.references)) continue
    if (!within(i.references)) {
      caveats.push(`index ${i.name} mixes these columns with others and is not carried to the new table`)
      contractBlockers.push(`index ${i.name} would be dropped with the columns`)
    }
  }
  for (const t of facts.triggers) {
    if (t.name.startsWith('bkn_evo_')) continue
    const src = t.functionSource ?? ''
    const named = members.filter(m => new RegExp(`\\b${m}\\b`).test(src))
    if (named.length > 0) {
      caveats.push(
        `trigger ${t.name} names ${named.join(', ')} in its function body (text match — PostgreSQL does not record this); ` +
          'what it writes is still mirrored, because the sync reads the finished row',
      )
      contractBlockers.push(`trigger function for ${t.name} mentions ${named.join(', ')}`)
    }
  }
  for (const c of consumers) {
    contractBlockers.push(`${c.kind.replace('_', ' ')} "${c.name}" reads or writes ${c.columns.join(', ')}`)
  }
  contractBlockers.push(
    'PostgREST clients and direct connection strings choose their own columns and cannot be enumerated',
  )

  return { expandBlockers, contractBlockers, caveats }
}

// ── Pressure ─────────────────────────────────────────────────────────────────

function repeatingGroup(members: string[]): boolean {
  const byBase = new Map<string, Set<number>>()
  for (const m of members) {
    const r = readName(m, null)
    if (r.ordinal !== null && r.ordinalBase) {
      byBase.set(r.ordinalBase, (byBase.get(r.ordinalBase) ?? new Set()).add(r.ordinal))
    }
  }
  return [...byBase.values()].some(s => s.size >= 2)
}

function assessPressure(
  facts: TableFacts,
  members: string[],
  history: ColumnHistory,
  p: PressureInputs,
): { signals: PressureSignal[]; eventsInWindow: number } {
  const set = new Set(members)
  const signals: PressureSignal[] = []
  const since = p.now.getTime() - p.windowDays * 86_400_000

  if (repeatingGroup(members)) {
    signals.push({
      kind: 'repeating_group',
      detail:
        'the concern is a list stored in numbered columns, so it has a fixed ceiling and every extra item is a schema change',
    })
  }

  const repairs = p.repairs.filter(r => set.has(r.column) && new Date(r.at).getTime() >= since)
  if (repairs.length > 0) {
    const ids = new Set(repairs.map(r => r.findingId))
    signals.push({
      kind: 'attributed_repairs',
      detail: `the healing loop repaired these columns ${ids.size} time(s) in the last ${p.windowDays} days (${[...new Set(repairs.map(r => r.type))].join(', ')})`,
      at: repairs.map(r => r.at).sort().at(-1),
    })
  }

  const events = history.available
    ? history.events.filter(e => e.columns.some(c => set.has(c)) && new Date(e.at).getTime() >= since)
    : []
  const rows = facts.stats?.liveRows ?? null
  const hot = (p.hostRequests !== null && p.hostRequests >= HOT_REQUESTS) || (rows !== null && rows >= HOT_ROWS)
  if (events.length > 0 && hot) {
    const load = [
      p.hostRequests !== null ? `${p.hostRequests.toLocaleString('en-US')} request(s) in the window` : null,
      rows !== null ? `about ${rows.toLocaleString('en-US')} row(s)` : null,
    ].filter(Boolean).join(', ')
    signals.push({
      kind: 'hot_host_change',
      detail:
        `changing this concern took an exclusive lock on ${facts.table} (${load}) — ` +
        `${events.length} time(s) in the last ${p.windowDays} days`,
      at: events.map(e => e.at).sort().at(-1),
    })
  }

  return { signals, eventsInWindow: events.length }
}

/** Two separate changes that touched this concern and nothing else on the table. */
export const INDEPENDENT_CHANGES = 2
/** Consumers that read or write this concern and no other distinctive column of the table. */
export const SPECIALIZED_CONSUMERS = 2

/**
 * Pressure that has not cost anything yet.
 *
 * The one place change frequency is read as more than a ranking — and only
 * changes that touched the concern ALONE, on a concern cohesion already
 * established. It can raise a recommendation and nothing more: the level
 * classifier gives emerging pressure no path to an executable proposal.
 */
function assessEmerging(
  facts: TableFacts,
  members: string[],
  history: ColumnHistory,
  p: PressureInputs,
): EmergingSignal[] {
  const set = new Set(members)
  const since = p.now.getTime() - p.windowDays * 86_400_000
  const out: EmergingSignal[] = []

  const alone = history.available
    ? history.events.filter(e => new Date(e.at).getTime() >= since && e.columns.length > 0 && e.columns.every(c => set.has(c)))
    : []
  if (alone.length >= INDEPENDENT_CHANGES) {
    out.push({
      kind: 'independent_evolution',
      detail: `these columns changed on their own ${alone.length} times in the last ${p.windowDays} days, with nothing else on ${facts.table} changing alongside them`,
    })
  }

  const pk = new Set(facts.primaryKey)
  const distinctive = (c: string) => !pk.has(c) && !isBookkeeping(c)
  const specialized = p.consumers.filter(c => {
    const named = c.columns.filter(distinctive)
    return named.length > 0 && named.every(col => set.has(col))
  })
  if (specialized.length >= SPECIALIZED_CONSUMERS) {
    out.push({
      kind: 'specialized_consumers',
      detail: `${specialized.length} of Backenly's functions and triggers use these columns and nothing else distinctive on ${facts.table} (${specialized.map(c => c.name).join(', ')})`,
    })
  }
  return out
}

/**
 * What a behaviour-preserving extraction keeps, and what it does not decide.
 *
 * Seeing that columns move together is evidence about structure, not about the
 * business. Whether a parent can have several of these — partial refunds,
 * repeated attempts, a history — is a change of MEANING, and it is never part
 * of a structural change.
 */
export function semanticBoundaryFor(host: string, label: string): string {
  return (
    `This keeps today's meaning exactly: at most one ${label} record per ${singular(host)}, the same values and the ` +
    `same access. Whether a ${singular(host)} should be able to have several — or whether ${label} is really a ` +
    'history of events — is a change of meaning, which this does not make and which would need your decision.'
  )
}

// ── Priority (ordering only) ─────────────────────────────────────────────────

/**
 * How urgently a FIRING proposal deserves attention. Ordering only.
 *
 * This is where churn finally gets to speak: two proposals that both cleared
 * the gate are ranked by how often the concern has been changing, how many
 * consumers it has, and how sparse it is. None of it can make a non-firing
 * concern fire.
 */
export function priorityOf(input: {
  pressureCount: number
  changeEvents: number
  consumers: number
  presenceRate: number | null
  supportingFamilies: number
}): { score: number; label: 'high' | 'medium' | 'low' } {
  const score = Math.round(
    40 * Math.min(input.pressureCount, 2) / 2 +
      20 * Math.min(input.changeEvents, 6) / 6 +
      15 * Math.min(input.consumers, 4) / 4 +
      15 * (input.presenceRate === null ? 0.5 : 1 - input.presenceRate) +
      10 * Math.min(Math.max(input.supportingFamilies - 1, 0), 3) / 3,
  )
  return { score, label: score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low' }
}

// ── The analysis ─────────────────────────────────────────────────────────────

export function analyzeTable(input: TableAnalysisInput): TableAssessment {
  const { facts, presence, history, pressure } = input
  const { core, eligible } = partitionColumns(facts)
  const sets = presence ? presenceSets(presence) : null
  const hs = hostStem(facts.table)

  const evaluated = candidateGroups(facts, eligible, sets, history).map(c => {
    const families = evaluateFamilies(facts, c.members, presence, input.presenceUnavailableReason, sets, history)
    const supporting = families.filter(f => f.verdict === 'supports').map(f => f.family)
    const contradicting = families.filter(f => f.verdict === 'contradicts').map(f => f.family)
    return { ...c, families, supporting, contradicting, cohesive: isCohesive(supporting, contradicting) }
  })

  // Overlapping candidates: the best-evidenced wins, then the larger, then the
  // lexically first so the result never depends on iteration order.
  evaluated.sort(
    (a, b) =>
      Number(b.cohesive) - Number(a.cohesive) ||
      b.supporting.length - a.supporting.length ||
      b.members.length - a.members.length ||
      a.members.join(',').localeCompare(b.members.join(',')),
  )
  const taken = new Set<string>()
  const chosen = evaluated.filter(c => {
    if (c.members.some(m => taken.has(m))) return false
    c.members.forEach(m => taken.add(m))
    return true
  })

  const concerns: ConcernAssessment[] = chosen.map(c => {
    const members = c.members
    const consumers = pressure.consumers.filter(x => x.columns.some(col => members.includes(col)))
    const separability = assessSeparability(facts, members, consumers)

    let presenceRate: number | null = null
    if (presence && sets && presence.rows.length >= MIN_ROWS_FOR_DENSITY) {
      const any = new Set<number>()
      for (const m of members) for (const r of sets.get(m) ?? []) any.add(r)
      presenceRate = any.size / presence.rows.length
    }
    const dense = presenceRate !== null && presenceRate >= DENSE_PRESENCE

    const { signals, eventsInWindow } = assessPressure(facts, members, history, pressure)
    const emerging = c.cohesive ? assessEmerging(facts, members, history, pressure) : []
    const repeating = signals.some(s => s.kind === 'repeating_group')
    const shape: ConcernShape = repeating ? 'repeating_group' : dense ? 'dense_one_to_one' : 'optional_one_to_one'
    const separable = separability.expandBlockers.length === 0

    const fires = firesConcernExtraction({
      supporting: c.supporting,
      contradicting: c.contradicting,
      separable,
      dense,
      pressureCount: signals.length,
    })

    const words = members.map(m => readName(m, hs).word).filter((w): w is string => !!w)
    const counts = new Map<string, number>()
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
    const label =
      [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0]?.[0] ??
      'concern'

    // ── The engine's level ────────────────────────────────────────────────
    const concernKey = concernKeyOf(facts.table, label)
    const prior = input.priors?.[concernKey] ?? { kind: 'none' as const }
    const costAts = signals.map(x => x.at).filter((x): x is string => !!x)
    const newEvidenceSincePrior =
      (prior.kind === 'reversed' || prior.kind === 'declined') &&
      costAts.some(at => new Date(at).getTime() > new Date(prior.at).getTime())
    const measuredFamiliesBlind = c.families.some(
      f => f.verdict === 'unavailable' && ['co_presence', 'cohort', 'lifecycle'].includes(f.family),
    )
    const decision = classifyOpportunity({
      cohesive: c.cohesive,
      contradicted: c.contradicting.length > 0,
      partialEvidence: !c.cohesive && c.supporting.length > 0 && measuredFamiliesBlind,
      separable,
      counterproductive: dense
        ? `${Math.round((presenceRate ?? 0) * 100)}% of rows carry this concern, so a separate table would add a join to nearly every read and remove no cost`
        : null,
      measuredCost: signals.length,
      emergingPressure: emerging.length,
      executable: !repeating,
      notExecutableBecause: repeating
        ? 'these are numbered copies of one field and need a different change (one row per number), which is not automated'
        : undefined,
      prior,
      newEvidenceSincePrior,
    })

    const verdict =
      decision.level === 'executable_proposal'
        ? `Proposed: ${members.join(', ')} behave as one ${label} concern and keeping them on ${facts.table} has a measured cost.`
        : decision.level === 'recommendation_only'
          ? `Recommended, not proposed to run: ${decision.reason}.`
          : !c.cohesive
            ? c.contradicting.length > 0
              ? `Not proposed: ${c.contradicting.join(', ')} measured that these columns do not belong together.`
              : `Not proposed: only ${c.supporting.length === 0 ? 'nothing' : c.supporting.join(' and ')} supports grouping them, and cohesion needs two families with at least one measured.`
            : !separable
              ? `Not proposed: ${separability.expandBlockers[0]}.`
              : decision.level === 'no_change_recommended'
                ? `Not proposed: ${decision.reason}.`
                : `Watching: the columns form one concern, but nothing measured shows that keeping them on ${facts.table} costs anything yet.`

    return {
      key: `${facts.table}:${members.join(',')}`,
      concernKey,
      host: facts.table,
      label,
      members,
      families: c.families,
      cohesive: c.cohesive,
      presenceRate,
      shape,
      separability,
      pressure: signals,
      amplifiers: {
        changeEventsInWindow: eventsInWindow,
        consumers: consumers.length,
        hostRequests: pressure.hostRequests,
        hostRows: facts.stats?.liveRows ?? null,
      },
      priority: priorityOf({
        pressureCount: signals.length,
        changeEvents: eventsInWindow,
        consumers: consumers.length,
        presenceRate,
        supportingFamilies: new Set(c.supporting).size,
      }),
      fires,
      emerging,
      level: decision.level,
      levelReason: decision.reason,
      semanticBoundary: semanticBoundaryFor(facts.table, label),
      verdict,
      defaultSatellite: defaultSatelliteName(facts.table, label),
    }
  })

  concerns.sort(
    (a, b) =>
      LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
      b.priority.score - a.priority.score ||
      a.key.localeCompare(b.key),
  )

  // ── The table as a whole ────────────────────────────────────────────────
  //
  // "No change" is an answer, and for a table a naive system would be tempted
  // by — busy, big, frequently changed — it is said out loud with its reasons.
  const since = pressure.now.getTime() - pressure.windowDays * 86_400_000
  const changesInWindow = history.available
    ? history.events.filter(e => new Date(e.at).getTime() >= since).length
    : 0
  const top = concerns.reduce<EvolutionLevel>(
    (best, c) => (LEVEL_RANK[c.level] > LEVEL_RANK[best] ? c.level : best),
    'no_change_recommended',
  )
  const notes = concerns
    .filter(c => c.cohesive && LEVEL_RANK[c.level] < LEVEL_RANK.recommendation_only)
    .map(c =>
      c.level === 'watching'
        ? `watching ${c.members.join(', ')}: they behave as one ${c.label} concern, and nothing shows it matters yet`
        : `${c.members.join(', ')} stay where they are: ${c.levelReason}`,
    )
  const noChangeReason =
    LEVEL_RANK[top] >= LEVEL_RANK.recommendation_only
      ? null
      : explainNoChange({
          subject: facts.table,
          changesInWindow,
          windowDays: pressure.windowDays,
          rows: facts.stats?.liveRows ?? null,
          requests: pressure.hostRequests,
          notes,
        })

  return {
    table: facts.table,
    rows: facts.stats?.liveRows ?? null,
    core,
    eligible,
    concerns,
    subject: { level: top, noChangeReason, changesInWindow },
    coverage: {
      presence: presence ? 'measured' : 'unavailable',
      ...(presence ? {} : { presenceDetail: input.presenceUnavailableReason ?? 'rows could not be sampled' }),
      history: history.available ? 'available' : 'unavailable',
      ...(history.available ? {} : { historyDetail: history.reason ?? 'no schema history' }),
    },
  }
}
