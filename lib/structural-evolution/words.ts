/**
 * WHAT A PERSON READS ABOUT AN EXTRACTION
 * =======================================
 *
 * The plain sentences the request row, the Architecture changes card and the
 * activity feed show by default: what the change does, why, that apps keep
 * working, what undo does, and what each stage was doing if one does not
 * finish. Never SQL, a lifecycle state, a count, a percentage or a score: the
 * measurements themselves are in the request's technical details, one click
 * further.
 *
 * No runtime imports: the Console's own tests render exactly these sentences.
 */

import type { UserFacingSummary } from '@/lib/evolution-engine/primitive'
import type { ConcernAssessment } from './concerns'
import type { ExtractionSpec } from './sql'

const titleCase = (s: string) => s.replace(/^./, c => c.toUpperCase())
const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** Plain sentences about one extraction. */
export function describeExtraction(spec: ExtractionSpec, why?: string): UserFacingSummary {
  const { host, satellite, label, members } = spec
  return {
    headline: `Move ${label} data out of ${host} into its own table`,
    change:
      `Backenly would create ${satellite} for ${list(members)}, keep it in step with ${host} in both directions, ` +
      `and copy the existing ${label} data across. Nothing is removed from ${host}.`,
    reason: why ?? `${list(members)} behave as one responsibility of their own.`,
    compatibility: `Apps that use ${host} today keep working unchanged; new code can use ${satellite} when it is ready.`,
    access: `Who can read or change ${label} data stays exactly the same.`,
    rollback:
      `Undo removes ${satellite} and leaves ${host} exactly as it was, with no data lost; ` +
      `anything already using ${satellite} stops working. Backenly refuses to undo if that would lose a write.`,
    subjectTitle: titleCase(host),
    did: `moved ${label} data out of ${host} into its own table, ${satellite}`,
    stages: {
      rehearsal: `rehearsing the change on a copy of ${host}`,
      expand: `setting up ${satellite}`,
      backfill: `copying the existing ${label} data into ${satellite}`,
      verify: `checking that ${satellite} matches ${host}`,
      cutover: `opening ${satellite} to your apps`,
    },
  }
}

/**
 * How a measured fact reads in the default reason: what the columns do, never
 * the numbers behind it. A name in common is not behaviour and is never said.
 */
const TOGETHER: Partial<Record<ConcernAssessment['families'][number]['family'], string>> = {
  co_presence: 'are filled in on the same rows',
  cohort: 'were added to the table after it was created',
  lifecycle: "are set later in a row's life, not when it is created",
}

/** What each measured cost is, in one plain sentence. */
function costSentence(kind: string, host: string): string | null {
  switch (kind) {
    case 'hot_host_change':
      return `Changing them has been locking all of ${host} while it is in use.`
    case 'attributed_repairs':
      return 'Backenly keeps finding problems on them.'
    case 'repeating_group':
      return `They are a list kept in numbered columns, so every extra item needs a change to ${host}.`
    default:
      return null
  }
}

/** Why a concern is worth changing, in plain sentences: what its columns do together, and what keeping them costs. */
export function whyOf(c: Pick<ConcernAssessment, 'host' | 'label' | 'families' | 'pressure' | 'emerging' | 'levelReason'>): string {
  const together = c.families
    .filter(f => f.verdict === 'supports')
    .map(f => (f.family === 'reference' ? `point to ${f.detail.replace(/^refers to /, '')}` : TOGETHER[f.family]))
    .filter((x): x is string => !!x)
  const costs = [...new Set(c.pressure.map(p => costSentence(p.kind, c.host)).filter((x): x is string => !!x))]
  const parts = [
    together.length ? `The ${c.label} columns ${list(together.slice(0, 2))}.` : null,
    ...costs.slice(0, 2),
    !costs.length && (c.emerging ?? []).length ? `They are starting to change on their own, apart from the rest of ${c.host}.` : null,
  ].filter((x): x is string => !!x)
  return parts.join(' ') || c.levelReason
}
