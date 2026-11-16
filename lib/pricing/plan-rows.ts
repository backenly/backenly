/**
 * Free beside Pro: the plan facts the console compares, in one place.
 *
 * The Billing page shows a Free organization what Pro changes, one row per
 * fact, next to what the organization uses today. Pro's metered amounts come
 * from the public pricing catalog (lib/pricing/catalog.ts), the same numbers
 * the pricing page and the overage bill read. The rest are the Plan rows the
 * product enforces (SANDBOX and BUILDER in the Cloud overlay's
 * prisma/seed-billing.ts), restated here because public code cannot import
 * the overlay; __tests__/cloud/catalog-seed-consistency.test.ts is where the
 * two are held equal.
 *
 * Plain data, no React, so a page and a test read the same rows.
 */

import { PRO_INCLUDED, includedEgressMb } from '@/lib/pricing/catalog'

/** What Free includes, as the SANDBOX Plan row enforces it. */
export const FREE_INCLUDED = {
  projects: 1,
  mau: 50_000,
  aiCredits: 200,
  fnRuns: 10_000,
  dbMb: 512,
  fileMb: 1_024,
  seats: 2,
  restoreDays: 7,
} as const

/** What Pro adds beyond the catalog's metered amounts, as the BUILDER Plan row enforces it. */
export const PRO_EXTRAS = {
  aiCredits: 3_000,
  seats: 5,
  restoreDays: 30,
} as const

/** Pro's price: $25 a month, or $20 a month billed yearly ($240 a year). */
export const PRO_PRICE = {
  monthlyCents: 2_500,
  yearlyMonthlyCents: 2_000,
} as const

export type PlanRowKey =
  | 'projects'
  | 'mau'
  | 'aiCredits'
  | 'fnRuns'
  | 'database'
  | 'files'
  | 'egress'
  | 'seats'
  | 'restorePoints'
  | 'support'
  | 'selfHealing'

export interface PlanRow {
  key: PlanRowKey
  label: string
  free: string
  pro: string
}

const n = (v: number) => v.toLocaleString('en-US')
const size = (mb: number) => (mb >= 1_024 ? `${n(mb / 1_024)} GB` : `${n(mb)} MB`)

/** The comparison, in the order the Billing page lists it. */
export function planRows(): PlanRow[] {
  const egressFree = includedEgressMb('SANDBOX', 'cdn')
  const egressPro = includedEgressMb('BUILDER', 'cdn')
  return [
    { key: 'projects', label: 'Projects', free: n(FREE_INCLUDED.projects), pro: 'Unlimited' },
    { key: 'mau', label: 'Monthly active users', free: n(FREE_INCLUDED.mau), pro: n(PRO_INCLUDED.mau) },
    { key: 'aiCredits', label: 'AI credits a month', free: n(FREE_INCLUDED.aiCredits), pro: n(PRO_EXTRAS.aiCredits) },
    { key: 'fnRuns', label: 'Function runs a month', free: n(FREE_INCLUDED.fnRuns), pro: n(PRO_INCLUDED.fnRuns) },
    { key: 'database', label: 'Postgres database', free: size(FREE_INCLUDED.dbMb), pro: size(PRO_INCLUDED.dbGib * 1_024) },
    { key: 'files', label: 'File storage', free: size(FREE_INCLUDED.fileMb), pro: size(PRO_INCLUDED.fileGib * 1_024) },
    {
      key: 'egress',
      label: 'Data transfer',
      free: egressFree === null ? 'Custom' : size(egressFree),
      pro: egressPro === null ? 'Custom' : size(egressPro),
    },
    { key: 'seats', label: 'Team seats', free: n(FREE_INCLUDED.seats), pro: n(PRO_EXTRAS.seats) },
    { key: 'restorePoints', label: 'Restore points', free: `${FREE_INCLUDED.restoreDays} days`, pro: `${PRO_EXTRAS.restoreDays} days` },
    { key: 'support', label: 'Support', free: 'Community', pro: 'Email' },
    { key: 'selfHealing', label: 'Self-healing every minute', free: 'Included', pro: 'Included' },
  ]
}
