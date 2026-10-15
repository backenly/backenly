/**
 * A committed schema mutation and an unavailable postcondition read are
 * different outcomes. This exercises the real dispatchTool -> runExecutor ->
 * executeAction path; only PostgreSQL and adjacent asynchronous services are
 * mocked.
 */

const mockQueryRawUnsafe = jest.fn()
const mockQueryRaw = jest.fn()
const mockExecuteRawUnsafe = jest.fn()
const mockFindFirst = jest.fn()
const mockFindMany = jest.fn()
const mockSnapshotSchema = jest.fn()
const mockReconcileAutoRls = jest.fn()

const mockPrisma = {
  $queryRawUnsafe: (...args: any[]) => mockQueryRawUnsafe(...args),
  $queryRaw: (...args: any[]) => mockQueryRaw(...args),
  $executeRawUnsafe: (...args: any[]) => mockExecuteRawUnsafe(...args),
  table: {
    findFirst: (...args: any[]) => mockFindFirst(...args),
    findMany: (...args: any[]) => mockFindMany(...args),
  },
}

jest.mock('@/lib/db', () => ({ prisma: mockPrisma }))
jest.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

jest.mock('@/lib/ai/execution-timeline', () => ({
  trackAction: async (_projectId: string, _runId: string, _action: unknown, work: () => Promise<unknown>) => work(),
}))

jest.mock('@/lib/versioning/schema-versions', () => ({
  snapshotSchema: (...args: any[]) => mockSnapshotSchema(...args),
}))

jest.mock('@/lib/services/databaseProvisioning', () => ({
  getWorkspaceDatabaseNames: () => ({ postgresSchema: 'workspace_project_1' }),
}))

jest.mock('@/lib/services/workspace-rls', () => ({
  reconcileAutoRls: (...args: any[]) => mockReconcileAutoRls(...args),
}))

// Both are post-dispatch, best-effort side effects. They are unrelated to the
// mutation/readback boundary under test.
jest.mock('@/lib/memory/decision-memory', () => ({
  writeDecisionEntry: jest.fn(),
  extractFkInferences: jest.fn(() => []),
}))

jest.mock('@/lib/autonomy/event-trigger', () => ({
  kickReconciler: jest.fn(),
  shouldKickFor: () => false,
}))

jest.mock('@/lib/branches/protection', () => ({
  GATED_SCHEMA_TOOLS: new Set(['add_column']),
  isProductionProtected: async () => false,
  branchRequired: jest.fn(),
}))

const { dispatchTool } = require('@/lib/ai/brain/tools') as typeof import('@/lib/ai/brain/tools')

describe('MCP schema mutation verification', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSnapshotSchema.mockResolvedValue('version-1')
    mockFindFirst.mockResolvedValue({ id: 'table-posts' })
    mockFindMany.mockResolvedValue([])
    mockExecuteRawUnsafe.mockResolvedValue(0)
    mockReconcileAutoRls.mockResolvedValue(undefined)
    // 0. The dispatch's existence pre-check (DB-06) finds the table in the
    //    catalog, as apply_migration's check would.
    mockQueryRaw.mockResolvedValue([{ table_name: 'posts' }])

    // 1. The target table exists. 2. The target column does not. 3. DDL runs.
    // 4. Only the postcondition readback loses its connection.
    mockQueryRawUnsafe
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('forced postcondition readback outage'))
  })

  it('does not report a fully successful MCP mutation when its postcondition cannot be read', async () => {
    const result = await dispatchTool(
      'add_column',
      { tableName: 'posts', columnName: 'subtitle', columnType: 'TEXT' },
      {
        projectId: 'project-1',
        userId: 'user-1',
        agentSurface: true,
        mcpOwnerConfirmed: true,
        createdThisTurn: new Set<string>(),
      },
    )

    // The mutation reached PostgreSQL and did not throw.
    expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(1)
    expect(mockExecuteRawUnsafe.mock.calls[0][0]).toContain('ADD COLUMN')
    // The failed third query is the ADD_COLUMN postcondition readback.
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(3)

    // The mutation is not relabelled as failed, but the caller gets an explicit
    // unverified outcome instead of an indistinguishable success. The raw
    // database error remains internal while the stable code is diagnosable.
    expect(result).toMatchObject({
      ok: true,
      data: {
        verification: 'unverified',
        verificationError: 'POSTCONDITION_READBACK_FAILED',
      },
    })
    expect(JSON.stringify(result)).not.toContain('forced postcondition readback outage')
  })

  it('keeps the existing successful response shape when the postcondition is verified', async () => {
    mockQueryRawUnsafe.mockReset()
    mockQueryRawUnsafe
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ column_name: 'subtitle' }])

    const result = await dispatchTool(
      'add_column',
      { tableName: 'posts', columnName: 'subtitle', columnType: 'TEXT' },
      {
        projectId: 'project-1',
        userId: 'user-1',
        agentSurface: true,
        mcpOwnerConfirmed: true,
        createdThisTurn: new Set<string>(),
      },
    )

    expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true })
    expect(result.data).toBeUndefined()
  })
})
