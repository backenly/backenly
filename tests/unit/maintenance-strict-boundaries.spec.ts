/**
 * TWO BOUNDARIES THE FIRST PRODUCTION RUN WALKED STRAIGHT THROUGH
 * ===============================================================
 *
 * Both were found by running the ladder against production on 2026-09-16, and
 * neither was visible in CI, because both need a real catalog and a real worker
 * to show themselves.
 *
 * **An approved mutation may not expand.** `executeAction(ADD_COLUMN, …,
 * allowReplan = false)` disables replanning and not dependency expansion:
 * `resolveDependencies` prepends a `CREATE_TABLE` when no `Table` metadata row
 * exists. That recreated a production table and destroyed its 80 rows while
 * reporting success. A Tier-1 rung approved as "add one nullable column" cannot
 * legally become "create the table first" — different blast radius, different
 * rollback, different approved action set.
 *
 * **Dispatched is not complete.** The executor pushed the backfill onto
 * BackgroundJob and walked straight into `verify`, which then reported on rows
 * nothing had touched. Worse, the worker marks an unknown job type completed
 * with `{ skipped: true }`, so "the job completed" was true while no work had
 * been done at all.
 */

const mockQueryRawUnsafe = jest.fn()
const mockTableFindFirst = jest.fn()
const mockJobFindUnique = jest.fn()

jest.mock('@/lib/db', () => ({
  prisma: {
    $queryRawUnsafe: (...a: any[]) => mockQueryRawUnsafe(...(a as [any])),
    table: { findFirst: (...a: any[]) => mockTableFindFirst(...(a as [])) },
    backgroundJob: { findUnique: (...a: any[]) => mockJobFindUnique(...(a as [any])) },
  },
}))

const mockResolveSchema = jest.fn(async () => 'workspace_p1')
// The row count reads AS OWNER: the product enables RLS on every table it
// creates, and an unclaimed count returns 0 on a full table, which is the same
// reading a destroyed table gives. Mocked separately from $queryRawUnsafe so
// the catalog queue below stays in the order the primitive issues it.
const mockQueryAsOwner = jest.fn()
jest.mock('@/lib/services/workspace-pool', () => ({
  resolveWorkspaceSchema: (...a: any[]) => mockResolveSchema(...(a as [])),
  queryWorkspaceAsOwner: (...a: any[]) => mockQueryAsOwner(...(a as [any])),
}))

const mockExecuteAction = jest.fn()
jest.mock('@/lib/ai/minimal-executor', () => ({
  executeAction: (...a: any[]) => mockExecuteAction(...(a as [])),
}))

import { executeMaintenanceAddStructure, ALLOWED_COLUMN_TYPES } from '@/lib/autonomy/maintenance/primitives/add-structure'

const SPEC = { projectId: 'p1', table: 'sessions', column: 'lifecycle_state', columnType: 'text' }

/**
 * Drive the catalog reads in order: table lookup, row count, column lookup,
 * then the same three again after the mutation.
 */
function catalog(opts: {
  oidBefore?: string | null
  rowsBefore?: number
  columnBefore?: boolean
  oidAfter?: string | null
  rowsAfter?: number
  columnAfter?: { nullable: boolean } | null
}) {
  const {
    oidBefore = '16400', rowsBefore = 80, columnBefore = false,
    oidAfter = '16400', rowsAfter = 80, columnAfter = { nullable: true },
  } = opts
  const queue: any[] = [
    oidBefore === null ? [] : [{ oid: oidBefore }],
    columnBefore ? [{ data_type: 'text', is_nullable: 'YES' }] : [],
    oidAfter === null ? [] : [{ oid: oidAfter }],
    columnAfter ? [{ data_type: 'text', is_nullable: columnAfter.nullable ? 'YES' : 'NO' }] : [],
  ]
  mockQueryRawUnsafe.mockImplementation(async () => queue.shift() ?? [])

  // Only reached when the table exists, which is what the oid queue decides.
  const counts: any[] = [[{ n: BigInt(rowsBefore) }], [{ n: BigInt(rowsAfter) }]]
  mockQueryAsOwner.mockImplementation(async () => counts.shift() ?? [{ n: BigInt(-1) }])
}

beforeEach(() => {
  jest.clearAllMocks()
  mockTableFindFirst.mockResolvedValue({ id: 't1' })
  mockExecuteAction.mockResolvedValue({ success: true, message: '✅ Added' })
  mockResolveSchema.mockResolvedValue('workspace_p1')
})

describe('add_structure adds exactly one column', () => {
  it('adds it, and proves the table was not recreated', async () => {
    catalog({})
    const r = await executeMaintenanceAddStructure(SPEC)

    expect(r).toMatchObject({ added: true, refusal: null })
    expect(r.observed).toEqual({ column: 'lifecycle_state', dataType: 'text', isNullable: true })
    expect(r.identity).toMatchObject({ oidBefore: '16400', oidAfter: '16400', rowsBefore: 80, rowsAfter: 80 })

    expect(mockExecuteAction).toHaveBeenCalledTimes(1)
    const [action, , , , , allowReplan] = mockExecuteAction.mock.calls[0]
    expect(action).toEqual({
      action: 'ADD_COLUMN',
      params: { tableName: 'sessions', columnName: 'lifecycle_state', columnType: 'text' },
    })
    expect(allowReplan).toBe(false)
  })

  it('REFUSES when the platform has no Table row, rather than creating one', async () => {
    // The exact condition that made resolveDependencies prepend a CREATE_TABLE.
    // Refusing here is what prevents the expansion — a precondition, not a flag.
    catalog({})
    mockTableFindFirst.mockResolvedValue(null)

    const r = await executeMaintenanceAddStructure(SPEC)
    expect(r.added).toBe(false)
    expect(r.refusal).toMatch(/metadata\/catalog disagreement/)
    expect(r.refusal).toMatch(/adopted or its metadata repaired first/)
    // Nothing ran. That is the whole point.
    expect(mockExecuteAction).not.toHaveBeenCalled()
  })

  it('does not treat a missing metadata row as a missing table', async () => {
    // The catalog is the source of truth. External DDL is valid and gets
    // adopted, never overwritten, so "metadata absent" and "table absent" are
    // different refusals with different remedies.
    catalog({})
    mockTableFindFirst.mockResolvedValue(null)
    const noMetadata = await executeMaintenanceAddStructure(SPEC)

    catalog({ oidBefore: null })
    mockTableFindFirst.mockResolvedValue({ id: 't1' })
    const noTable = await executeMaintenanceAddStructure(SPEC)

    expect(noMetadata.refusal).not.toEqual(noTable.refusal)
    expect(noTable.refusal).toMatch(/does not exist in workspace_p1/)
  })

  it('catches a recreated table by its oid, even if everything reported success', async () => {
    // The backstop. If an expansion ever slips past every precondition, the
    // catalog still says the table is a different table.
    catalog({ oidBefore: '16400', oidAfter: '17999', rowsAfter: 0 })
    const r = await executeMaintenanceAddStructure(SPEC)

    expect(r.added).toBe(false)
    expect(r.refusal).toMatch(/the table was RECREATED: oid 16400 became 17999/)
  })

  it('catches rows disappearing even when the oid is unchanged', async () => {
    catalog({ rowsBefore: 80, rowsAfter: 0 })
    const r = await executeMaintenanceAddStructure(SPEC)
    expect(r.refusal).toMatch(/row count changed from 80 to 0/)
  })

  it('refuses a target column that already exists', async () => {
    catalog({ columnBefore: true })
    const r = await executeMaintenanceAddStructure(SPEC)
    expect(r.refusal).toMatch(/already exists/)
    expect(mockExecuteAction).not.toHaveBeenCalled()
  })

  it('refuses when the column is not there afterwards, whatever the executor said', async () => {
    catalog({ columnAfter: null })
    const r = await executeMaintenanceAddStructure(SPEC)
    expect(r.refusal).toMatch(/is not in the catalog/)
  })

  it('refuses a NOT NULL column, which would not be reversible', async () => {
    catalog({ columnAfter: { nullable: false } })
    const r = await executeMaintenanceAddStructure(SPEC)
    expect(r.refusal).toMatch(/was added NOT NULL/)
  })

  it('refuses a column type outside the closed set', async () => {
    catalog({})
    const r = await executeMaintenanceAddStructure({ ...SPEC, columnType: 'text; DROP TABLE users' })
    expect(r.refusal).toMatch(/is not in the allowed set/)
    expect(mockExecuteAction).not.toHaveBeenCalled()
    expect(ALLOWED_COLUMN_TYPES).toContain('text')
  })

  it('refuses an identifier that is not one', async () => {
    catalog({})
    const r = await executeMaintenanceAddStructure({ ...SPEC, column: 'a"; DROP TABLE x; --' })
    expect(r.refusal).toMatch(/not a valid identifier/)
    expect(mockExecuteAction).not.toHaveBeenCalled()
  })
})
