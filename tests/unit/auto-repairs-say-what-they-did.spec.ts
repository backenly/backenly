/**
 * Every repair the loop makes on its own says what it did, never the finding
 * type's name. Production QA (2026-11-16): the activity feed read "slow query
 * missing index"; the automatic path read "Backenly fixed slow query missing
 * index on …" for the same index.
 */
import { explainAutonomyEvent } from '@/lib/autonomy/because-copy'
import { ALL_FINDING_TYPES } from '@/lib/core/types'
import { classifyFix } from '@/lib/core/fix-classifier'

const automatic = ALL_FINDING_TYPES.filter(
  (type) => classifyFix(type, { tableName: 'orders', columnName: 'user_id' }).decision === 'auto',
)

it('covers the repairs the loop makes on its own', () => {
  expect(automatic).toEqual(expect.arrayContaining(['slow_query_missing_index', 'infra_table_bloat', 'index_bloat', 'missing_rls']))
})

it.each(automatic)('%s says what Backenly did, not the finding type', (type) => {
  const s = explainAutonomyEvent({ findingType: type, tableName: 'orders', columnName: 'user_id' })
  expect(s.full.toLowerCase()).not.toContain(type.replace(/_/g, ' '))
  expect(s.full).toContain('"orders')
})
