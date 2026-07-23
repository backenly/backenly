/**
 * TABLE LIFECYCLE — single canonical runtime for table + column mutations.
 *
 * Why this file exists:
 *   Before this service, the dashboard's "+ New table" button and "Delete table"
 *   button each had their own bespoke SQL — `id SERIAL PRIMARY KEY`, no soft
 *   delete, no updatedAt trigger, no realtime trigger, no auto-indexes, no
 *   ApiDefinition row, no BackendGraph update, no decision memory. The AI's
 *   `executeCreateTable` / `executeDropTable` did all of that.
 *
 *   The split meant a table created in the inspector was a second-class citizen:
 *   wrong PK type, invisible to subscribers, no REST endpoints, AI couldn't
 *   reason about it. Same hazard for delete — orphaned metadata, phantom APIs.
 *
 *   This service collapses both paths into ONE. The brain's tools and the
 *   dashboard's buttons both go through `executeAction` (the governance kernel
 *   with verify+self-heal, schema versioning, typegen, decision memory, etc.).
 *
 * Boundary: input validation + authorization happens in the API route. This
 * service assumes the caller has already verified the user owns the project.
 */

import { executeAction, type ExecutionResult } from '@/lib/ai/minimal-executor'
import { assertValidProjectId } from '@/lib/security/workspace-schema'

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const COLUMN_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export type ColumnSpec = {
  name: string
  type: string
  nullable?: boolean
  unique?: boolean
  fkTo?: string
}

export type ConstraintType = 'not_null' | 'unique' | 'check' | 'foreign_key'

export interface CreateTableOpts {
  tableName: string
  description?: string
  columns?: ColumnSpec[]
  /** Skip auto-generation of REST API after the table is created. Default: false. */
  skipApi?: boolean
}

export interface CreateTableResult {
  success: boolean
  tableName: string
  apiGenerated: boolean
  message: string
  error?: string
}

/**
 * Create a workspace table through the canonical AI executor.
 * Same governance as `create_table` in the brain: UUID PK, soft-delete column,
 * updatedAt trigger, FK pre-resolve, auto-indexes, CHECK constraints, realtime
 * NOTIFY trigger, post-execution verify+self-heal, decision memory, typegen.
 *
 * After the table lands, this service automatically calls GENERATE_API so the
 * new table immediately has REST endpoints visible in the APIs section — no
 * extra round-trip required from the caller.
 */
export async function createWorkspaceTable(
  projectId: string,
  opts: CreateTableOpts,
): Promise<CreateTableResult> {
  assertValidProjectId(projectId)
  const tableName = String(opts.tableName ?? '').trim()
  if (!tableName) {
    return { success: false, tableName, apiGenerated: false, message: 'Table name is required', error: 'INVALID_NAME' }
  }
  if (!TABLE_NAME_RE.test(tableName)) {
    return {
      success: false,
      tableName,
      apiGenerated: false,
      message: 'Table name must start with a letter or underscore and contain only letters, numbers, or underscores.',
      error: 'INVALID_NAME',
    }
  }

  const createResult = await executeAction(
    {
      action: 'CREATE_TABLE',
      params: {
        tableName,
        columns: Array.isArray(opts.columns) ? opts.columns : [],
        ...(opts.description ? { description: opts.description } : {}),
      },
    },
    projectId,
  )

  if (!createResult.success) {
    return {
      success: false,
      tableName,
      apiGenerated: false,
      message: createResult.message || 'Failed to create table',
      error: createResult.error || 'CREATE_FAILED',
    }
  }

  if (opts.skipApi) {
    return {
      success: true,
      tableName,
      apiGenerated: false,
      message: createResult.message || `Table "${tableName}" created.`,
    }
  }

  const apiResult = await executeAction(
    { action: 'GENERATE_API', params: { tableName } },
    projectId,
  )

  return {
    success: true,
    tableName,
    apiGenerated: apiResult.success,
    message: apiResult.success
      ? `Table "${tableName}" created and REST API generated.`
      : `Table "${tableName}" created. REST API generation reported: ${apiResult.message}`,
  }
}

/**
 * Drop a workspace table through the canonical AI executor.
 * Cleans up: workspace SQL table, prisma.table metadata, prisma.apiDefinition
 * rows, the entity in BackendGraph, and cached Zod validation schemas.
 *
 * `confirmed: true` is forwarded so the executor's approval gate doesn't double-
 * prompt — the UI is responsible for showing the destructive-action modal
 * before calling this.
 */
export async function dropWorkspaceTable(
  projectId: string,
  tableName: string,
): Promise<ExecutionResult> {
  assertValidProjectId(projectId)
  const safe = String(tableName ?? '').trim()
  if (!safe) return { success: false, message: 'Table name is required', error: 'INVALID_NAME' }
  if (!TABLE_NAME_RE.test(safe)) {
    return { success: false, message: 'Invalid table name format.', error: 'INVALID_NAME' }
  }
  return executeAction(
    { action: 'DROP_TABLE', params: { tableName: safe, confirmed: true } },
    projectId,
  )
}

/**
 * Add a column to an existing table. Auto-creates the table if missing — same
 * behavior as `executeAddColumn`. Caller should ensure the table exists for a
 * clean UX, but this is safe either way.
 */
export async function addWorkspaceColumn(
  projectId: string,
  opts: { tableName: string; column: { name: string; type: string; nullable?: boolean; default?: string } },
): Promise<ExecutionResult> {
  assertValidProjectId(projectId)
  const tableName = String(opts.tableName ?? '').trim()
  const colName = String(opts.column?.name ?? '').trim()
  const colType = String(opts.column?.type ?? '').trim()
  if (!tableName || !TABLE_NAME_RE.test(tableName)) {
    return { success: false, message: 'Invalid table name.', error: 'INVALID_NAME' }
  }
  if (!colName || !COLUMN_NAME_RE.test(colName)) {
    return { success: false, message: 'Invalid column name.', error: 'INVALID_COLUMN_NAME' }
  }
  if (!colType) {
    return { success: false, message: 'Column type is required.', error: 'INVALID_COLUMN_TYPE' }
  }
  return executeAction(
    {
      action: 'ADD_COLUMN',
      params: {
        tableName,
        columnName: colName,
        columnType: colType,
        column: { name: colName, type: colType, nullable: opts.column.nullable, default: opts.column.default },
      },
    },
    projectId,
  )
}

export async function renameWorkspaceColumn(
  projectId: string,
  opts: { tableName: string; oldName: string; newName: string },
): Promise<ExecutionResult> {
  assertValidProjectId(projectId)
  const tableName = String(opts.tableName ?? '').trim()
  const oldName = String(opts.oldName ?? '').trim()
  const newName = String(opts.newName ?? '').trim()
  if (!tableName || !TABLE_NAME_RE.test(tableName)) {
    return { success: false, message: 'Invalid table name.', error: 'INVALID_NAME' }
  }
  if (!oldName || !COLUMN_NAME_RE.test(oldName) || !newName || !COLUMN_NAME_RE.test(newName)) {
    return { success: false, message: 'Invalid column name.', error: 'INVALID_COLUMN_NAME' }
  }
  if (oldName === newName) {
    return { success: false, message: 'New column name is the same as the old name.', error: 'NO_CHANGE' }
  }
  return executeAction(
    { action: 'RENAME_COLUMN', params: { tableName, oldName, newName } },
    projectId,
  )
}

export async function dropWorkspaceColumn(
  projectId: string,
  opts: { tableName: string; columnName: string },
): Promise<ExecutionResult> {
  assertValidProjectId(projectId)
  const tableName = String(opts.tableName ?? '').trim()
  const columnName = String(opts.columnName ?? '').trim()
  if (!tableName || !TABLE_NAME_RE.test(tableName)) {
    return { success: false, message: 'Invalid table name.', error: 'INVALID_NAME' }
  }
  if (!columnName || !COLUMN_NAME_RE.test(columnName)) {
    return { success: false, message: 'Invalid column name.', error: 'INVALID_COLUMN_NAME' }
  }
  return executeAction(
    { action: 'DROP_COLUMN', params: { tableName, columnName, confirmed: true } },
    projectId,
  )
}

export async function addWorkspaceConstraint(
  projectId: string,
  opts: {
    tableName: string
    columnName: string
    constraintType: ConstraintType
    expression?: string
  },
): Promise<ExecutionResult> {
  assertValidProjectId(projectId)
  const tableName = String(opts.tableName ?? '').trim()
  const columnName = String(opts.columnName ?? '').trim()
  if (!tableName || !TABLE_NAME_RE.test(tableName)) {
    return { success: false, message: 'Invalid table name.', error: 'INVALID_NAME' }
  }
  if (!columnName || !COLUMN_NAME_RE.test(columnName)) {
    return { success: false, message: 'Invalid column name.', error: 'INVALID_COLUMN_NAME' }
  }
  const allowed: ConstraintType[] = ['not_null', 'unique', 'check', 'foreign_key']
  if (!allowed.includes(opts.constraintType)) {
    return { success: false, message: 'Unsupported constraint type.', error: 'INVALID_CONSTRAINT' }
  }
  return executeAction(
    {
      action: 'ADD_CONSTRAINT',
      params: { tableName, columnName, constraintType: opts.constraintType, expression: opts.expression },
    },
    projectId,
  )
}
