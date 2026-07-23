/**
 * FINDING GROUPS — one defect, one row.
 *
 * A single backend defect fans out into one HealthFinding per affected table.
 * One wrong policy dialect on nine tables persisted as nine `rls_expression_invalid`
 * rows; one unreachable probe host persisted as four `contract_surface_broken`
 * rows. Rendered one-per-row, the user read ten rows and learned two facts —
 * and had to click "Approve & fix" nine times to repair one mistake.
 *
 * The findings themselves are correct: the fix engine acts per table, so per
 * table is the right unit to STORE. It is the wrong unit to SHOW. This module
 * is the seam between the two — it folds findings that share a root cause into
 * one group carrying every member's id, so the UI can render one row and still
 * approve all nine.
 *
 * Grouping is deliberately conservative. A group is only formed when we can
 * name it honestly:
 *   1. size 1                 → the finding's own sentence (identical to today)
 *   2. a curated group title  → "RLS policies on 5 tables are ineffective"
 *   3. every member's sentence is already identical → that sentence
 *   4. otherwise              → NOT grouped; the members stay separate rows
 * Rule 4 is the important one. A group we cannot title without guessing is a
 * group that would misdescribe the backend, and this surface is the one place
 * the product asks to be trusted about what is wrong.
 *
 * Pure module: no prisma, no server-only imports — safe in client components,
 * same contract as `finding-summaries`. Both the Overview summary and the
 * Autonomy queue read it, so the two surfaces cannot disagree about what is
 * open, how severe it is, or how it is categorised.
 */

import { normalizeFindingType } from './types'
import { summariseFinding } from './finding-summaries'

// ── Shape ────────────────────────────────────────────────────────────────────

/** The minimum a finding must carry to be grouped. Structurally satisfied by
 *  both the /health row shape and the trust report's PendingApproval. */
export interface GroupableFinding {
  id: string
  type: string
  severity: string
  details: Record<string, unknown> | null
  status?: string
  detectedAt?: string | null
}

export type FindingCategory = 'security' | 'performance' | 'reliability'

export interface FindingGroup<T extends GroupableFinding = GroupableFinding> {
  /** Stable across renders and refetches — safe as a React key. */
  key: string
  /** One honest sentence for the whole group. */
  title: string
  category: FindingCategory
  /** The most severe member's severity — a group is as urgent as its worst. */
  severity: string
  /** Every member, most severe first. Length 1 is the common, un-grouped case. */
  members: T[]
  /** Convenience: `members.map(m => m.id)`. The ids a bulk fix must act on. */
  findingIds: string[]
  /** Distinct table/resource names across members, in first-seen order. */
  subjects: string[]
}

// ── Classification (the single copy) ─────────────────────────────────────────

const CATEGORY_MATCHERS: Array<[FindingCategory, RegExp]> = [
  ['security', /(rls|auth|oauth|jwt|unprotected|permission|secret|credential|spike)/i],
  ['performance', /(index|seq_scan|slow|perf|n_plus_one|latency|scan)/i],
  ['reliability', /(webhook|deploy|drift|api|endpoint|orphan|shadow|fk|migration|broken)/i],
]

export const CATEGORY_LABEL: Record<FindingCategory, string> = {
  security: 'Security',
  performance: 'Performance',
  reliability: 'Reliability',
}

/**
 * Which lane a finding belongs to. Verification scenarios stamp domain
 * categories (auth/rls/state_machine) rather than the three lanes, so those are
 * mapped explicitly instead of falling through to the reliability default.
 */
export function categoryOf(f: GroupableFinding): FindingCategory {
  const explicit = (f.details as Record<string, unknown> | null)?.category
  if (explicit === 'security' || explicit === 'performance' || explicit === 'reliability') {
    return explicit
  }
  if (explicit === 'auth' || explicit === 'rls') return 'security'
  for (const [cat, re] of CATEGORY_MATCHERS) if (re.test(f.type)) return cat
  return 'reliability'
}

export const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 }

export function severityLabel(sev: string): { label: string; dot: string; text: string } {
  switch (sev) {
    case 'critical': return { label: 'HIGH', dot: 'bg-rose-400', text: 'text-rose-300' }
    case 'warning':  return { label: 'MED',  dot: 'bg-amber-400', text: 'text-amber-300' }
    default:         return { label: 'LOW',  dot: 'bg-zinc-400', text: 'text-zinc-400' }
  }
}

// ── Cause signature ──────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

function subjectOf(f: GroupableFinding): string | undefined {
  const d = (f.details ?? {}) as Record<string, unknown>
  return (
    normalizeFindingType(f.type, d)?.tableName ??
    str(d.tableName) ?? str(d.table) ?? str(d.surface) ?? str(d.location) ?? str(d.name)
  )
}

/**
 * What makes two findings the SAME defect rather than the same kind of defect.
 *
 * The canonical base answers "same kind". The discriminator answers "same
 * cause": nine tables carrying the same broken policy name share a cause; two
 * tables missing unrelated indexes do not. Deliberately excludes the subject —
 * the subject is what VARIES within a group.
 */
function causeSignature(f: GroupableFinding): string {
  const d = (f.details ?? {}) as Record<string, unknown>
  const base = normalizeFindingType(f.type, d)?.base ?? f.type
  const discriminator =
    str(d.policyName) ??      // rls_expression_invalid — the offending policy
    str(d.detail) ??          // contract_surface_broken — the probe error
    ''
  return `${base}::${discriminator}`
}

// Two fields deliberately excluded from the signature above:
//
// `details.reason` — every detector writes one, and it is written PER TABLE:
//   drift-detector emits `RLS is enabled on "orders" but a policy exposes every
//   row`. Folding it into the signature would make every member of every group
//   unique, so nothing would ever group and the fold would look implemented
//   while doing nothing. Only fields that describe the CAUSE belong here.
//
// `severity` — the same cause landing as warning on four tables and critical on
//   a fifth is still one cause and should still be one decision. The group
//   carries its worst member's severity, so the row surfaces the critical one
//   rather than burying it.

// ── Curated group titles ─────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many)

/**
 * Titles for the families that genuinely fan out per table. Each states the
 * count first, because the count is the fact the ungrouped list hid.
 * A base absent from this map is not blocked from grouping — it just has to
 * earn it via rule 3 (every member already says the same sentence).
 */
const GROUP_TITLES: Record<string, (n: number, d: Record<string, unknown>) => string> = {
  rls_expression_invalid: (n, d) =>
    `RLS policies on ${n} ${plural(n, 'table')} are ineffective${str(d.policyName) ? ` (\`${d.policyName}\`)` : ''}`,
  missing_rls: (n) =>
    `${n} ${plural(n, 'table')} exposing user data ${plural(n, 'has', 'have')} no row-level security`,
  unprotected_user_data: (n) =>
    `${n} ${plural(n, 'table')} ${plural(n, 'stores', 'store')} user data with no RLS policy`,
  missing_fk: (n) =>
    `${n} ${plural(n, 'relation')} ${plural(n, 'has', 'have')} no foreign key constraint`,
  missing_fk_index: (n) =>
    `Sequential scans on ${n} ${plural(n, 'table')} (no index)`,
  missing_api_definition: (n) =>
    `${n} ${plural(n, 'table')} ${plural(n, 'has', 'have')} no generated API`,
  missing_api_crud: (n) =>
    `${n} ${plural(n, 'table')} ${plural(n, 'has', 'have')} no generated API`,
  api_drift: (n) =>
    `${n} API ${plural(n, 'contract')} drifted from their ${plural(n, 'table')}`,
  realtime_gap: (n) =>
    `${n} ${plural(n, 'table')} ${plural(n, 'is', 'are')} not broadcast to realtime subscribers`,
  orphan_table: (n) =>
    `${n} ${plural(n, 'table')} ${plural(n, 'is', 'are')} orphaned (no API, no relations)`,
  missing_archival_job: (n) =>
    `${n} ${plural(n, 'table')} ${plural(n, 'grows', 'grow')} without bound — no archival job`,
  missing_rate_limit: (n) =>
    `${n} public ${plural(n, 'endpoint')} ${plural(n, 'has', 'have')} no rate limit`,
  shadow_mutation: (n) =>
    `${n} ${plural(n, 'table')} ${plural(n, 'was', 'were')} changed outside the governed pipeline`,
}

/**
 * `contract_surface_broken` is canonical but carries no fix mapping, so it
 * never reaches the normalizer's base map — same convention `finding-summaries`
 * uses. Titled here because it is one of the two families that fans out most.
 */
function titleForBase(
  base: string,
  n: number,
  details: Record<string, unknown>,
): string | null {
  if (base === 'contract_surface_broken') {
    const detail = str(details.detail)
    return `${n} live API ${plural(n, 'surface')} ${plural(n, 'is', 'are')} failing${detail ? `: ${detail}` : ''}`
  }
  return GROUP_TITLES[base]?.(n, details) ?? null
}

// ── The fold ─────────────────────────────────────────────────────────────────

/**
 * Fold findings into root-cause groups, most severe first.
 *
 * Order is stable: groups are ranked by their worst member's severity, then by
 * the input order of their first member, so a refetch that returns the same
 * findings renders the same rows in the same places.
 */
export function groupFindings<T extends GroupableFinding>(findings: T[]): FindingGroup<T>[] {
  const buckets = new Map<string, T[]>()
  for (const f of findings) {
    const sig = causeSignature(f)
    const bucket = buckets.get(sig)
    if (bucket) bucket.push(f)
    else buckets.set(sig, [f])
  }

  const groups: FindingGroup<T>[] = []

  for (const [sig, members] of buckets) {
    // Worst-first inside the group, so `members[0]` is the one whose details
    // represent the group and the expanded list leads with what matters.
    const sorted = [...members].sort(
      (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
    )
    const head = sorted[0]
    const details = (head.details ?? {}) as Record<string, unknown>
    const base = normalizeFindingType(head.type, details)?.base ?? head.type

    const title = ((): string | null => {
      if (sorted.length === 1) return summariseFinding(head.type, head.details)
      const curated = titleForBase(base, sorted.length, details)
      if (curated) return curated
      // Rule 3 — they already say the same thing, so saying it once is not a
      // summary, it is a de-duplication.
      const first = summariseFinding(head.type, head.details)
      const allSame = sorted.every((m) => summariseFinding(m.type, m.details) === first)
      return allSame ? first : null
    })()

    if (title === null) {
      // Rule 4 — cannot title it without guessing, so do not group it.
      for (const m of sorted) {
        groups.push({
          key: `${sig}::${m.id}`,
          title: summariseFinding(m.type, m.details),
          category: categoryOf(m),
          severity: m.severity,
          members: [m],
          findingIds: [m.id],
          subjects: [subjectOf(m)].filter((s): s is string => !!s),
        })
      }
      continue
    }

    const subjects: string[] = []
    for (const m of sorted) {
      const s = subjectOf(m)
      if (s && !subjects.includes(s)) subjects.push(s)
    }

    groups.push({
      key: sig,
      title,
      category: categoryOf(head),
      severity: head.severity,
      members: sorted,
      findingIds: sorted.map((m) => m.id),
      subjects,
    })
  }

  return groups.sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
  )
}

/** Count of underlying findings across groups — the number the user must clear. */
export function countFindings(groups: FindingGroup[]): number {
  return groups.reduce((n, g) => n + g.members.length, 0)
}
