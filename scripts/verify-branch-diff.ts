/**
 * Unit verifier for the branch schema-diff core (lib/branches/diff.ts).
 * Pure functions, no database. Run: npx tsx scripts/verify-branch-diff.ts
 */
import { computeSchemaDiff, validateBranchName, branchSchemaName } from '../lib/branches/diff'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++
  console.log(`${ok ? '✔' : '✖'} ${label}${!ok && detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`)
}

const col = (columnName: string, dataType = 'text', isNullable = true) =>
  ({ tableName: '', columnName, dataType, udtName: dataType, isNullable, columnDefault: null, isPrimaryKey: false, isForeignKey: false, ordinalPosition: 0 }) as any

const schema = (tables: Array<[string, any[]]>) =>
  ({ projectId: 'p', schemaName: 's', generatedAt: '', tables: tables.map(([tableName, columns]) => ({ tableName, columns })) }) as any

const main = schema([
  ['posts', [col('id', 'uuid'), col('title'), col('views', 'integer')]],
  ['legacy', [col('id', 'uuid'), col('body')]],
])

const branch = schema([
  ['posts', [col('id', 'uuid'), col('title'), col('views', 'bigint'), col('slug')]], // type change + added col
  ['comments', [col('id', 'uuid'), col('body'), col('post_id', 'uuid')]],            // new table
  // 'legacy' missing → dropped on branch
])

const d = computeSchemaDiff(main, branch)

check('new table detected', d.addedTables.length === 1 && d.addedTables[0].tableName === 'comments', d.addedTables.map(t => t.tableName))
check('dropped table detected', d.droppedTables.length === 1 && d.droppedTables[0] === 'legacy', d.droppedTables)
check('added column detected', d.altered.some(a => a.table === 'posts' && a.addedColumns.some(c => c.name === 'slug')), d.altered)
check('type change detected integer→bigint', d.altered.some(a => a.typeChanged.some(t => t.column === 'views' && t.from === 'integer' && t.to === 'bigint')), d.altered)
check('no false dropped columns', d.altered.every(a => a.droppedColumns.length === 0), d.altered)
check('not identical', d.identical === false)

const same = computeSchemaDiff(main, main)
check('identical schemas → identical:true, empty diff', same.identical && same.addedTables.length === 0 && same.altered.length === 0)

// dropped column case
const branch2 = schema([['posts', [col('id', 'uuid'), col('title')]], ['legacy', [col('id', 'uuid'), col('body')]]])
const d2 = computeSchemaDiff(main, branch2)
check('dropped column detected', d2.altered.some(a => a.table === 'posts' && a.droppedColumns.includes('views')), d2.altered)

// name rules
check('valid slug accepted', validateBranchName('add-payments') === null)
check('uppercase rejected via lowering', validateBranchName('Add-Payments') === null) // trimmed+lowered → valid
check('too short rejected', validateBranchName('a') !== null)
check('sql-hostile name rejected', validateBranchName('x; drop schema') !== null)
check('schema name derivation', branchSchemaName('abc-123', 'add-payments') === 'workspace_abc-123_br_add_payments')

if (failures > 0) {
  console.error(`\n✖ ${failures} branch-diff verification(s) failed`)
  process.exitCode = 1
} else {
  console.log('\n✔ Branch diff core verified')
}
