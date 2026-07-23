/**
 * Phase 5: Dry-Run Simulator
 * 
 * Simulates execution in a sandbox BEFORE touching production.
 * Replit doesn't do this - this is why Backenly feels safe.
 */

import { ExecutionPlan, ExecutionStep } from './execution-plan-generator'
import { BackendStateGraph } from './backend-state-graph'

export interface DryRunResult {
  success: boolean
  simulatedChanges: SimulatedChange[]
  failures: SimulationFailure[]
  estimatedTime: number
  estimatedDowntime: number
  apiDiff: ApiDiff[]
  dataMigration: MigrationSummary
  warnings: string[]
  safeToExecute: boolean
}

export interface SimulatedChange {
  step: string
  type: 'schema' | 'api' | 'auth' | 'storage' | 'config'
  before: any
  after: any
  impact: string
}

export interface SimulationFailure {
  step: string
  reason: string
  errorType: 'syntax' | 'constraint' | 'dependency' | 'permission'
  blocking: boolean
}

export interface ApiDiff {
  endpoint: string
  method: string
  changeType: 'added' | 'removed' | 'modified'
  breakingChange: boolean
  details: string
}

export interface MigrationSummary {
  affectedTables: string[]
  estimatedRows: number
  requiresDowntime: boolean
  duration: number
  operations: MigrationOperation[]
}

export interface MigrationOperation {
  table: string
  operation: 'add_column' | 'drop_column' | 'rename_column' | 'change_type' | 'backfill'
  safe: boolean
  reversible: boolean
}

/**
 * Run dry-run simulation
 * 
 * CRITICAL: This MUST catch failures before production execution
 */
export async function runDryRun(
  plan: ExecutionPlan,
  graph: BackendStateGraph
): Promise<DryRunResult> {
  console.log('[Dry Run] Starting simulation for plan:', plan.planId)
  
  const simulatedChanges: SimulatedChange[] = []
  const failures: SimulationFailure[] = []
  const apiDiff: ApiDiff[] = []
  const warnings: string[] = []
  
  // Clone the graph for simulation
  const sandboxGraph = JSON.parse(JSON.stringify(graph))
  
  // Simulate each step
  for (const step of plan.steps) {
    try {
      const result = await simulateStep(step, sandboxGraph)
      
      if (result.failure) {
        failures.push(result.failure)
        if (result.failure.blocking) {
          console.log(`[Dry Run] Blocking failure at step: ${step.stepId}`)
          break // Stop on blocking failure
        }
      }
      
      if (result.change) {
        simulatedChanges.push(result.change)
      }
      
      if (result.apiChanges) {
        apiDiff.push(...result.apiChanges)
      }
      
      if (result.warnings) {
        warnings.push(...result.warnings)
      }
      
    } catch (error) {
      failures.push({
        step: step.stepId,
        reason: error instanceof Error ? error.message : 'Unknown error',
        errorType: 'syntax',
        blocking: true,
      })
      break
    }
  }
  
  // Analyze data migration
  const dataMigration = analyzeMigration(simulatedChanges, sandboxGraph)
  
  // Calculate time estimates
  const estimatedTime = plan.estimatedDuration
  const estimatedDowntime = dataMigration.requiresDowntime ? dataMigration.duration : 0
  
  // Determine if safe to execute
  const blockingFailures = failures.filter(f => f.blocking)
  const safeToExecute = blockingFailures.length === 0
  
  console.log('[Dry Run] Simulation complete:', {
    success: safeToExecute,
    failures: failures.length,
    changes: simulatedChanges.length,
  })
  
  return {
    success: failures.length === 0,
    simulatedChanges,
    failures,
    estimatedTime,
    estimatedDowntime,
    apiDiff,
    dataMigration,
    warnings,
    safeToExecute,
  }
}

/**
 * Simulate single execution step
 */
async function simulateStep(
  step: ExecutionStep,
  sandboxGraph: BackendStateGraph
): Promise<{
  failure?: SimulationFailure
  change?: SimulatedChange
  apiChanges?: ApiDiff[]
  warnings?: string[]
}> {
  const warnings: string[] = []
  
  switch (step.action) {
    case 'CREATE_TABLE':
      return simulateCreateTable(step, sandboxGraph)
      
    case 'ADD_TABLE_COLUMN':
      return simulateAddColumn(step, sandboxGraph)
      
    case 'DROP_COLUMN':
      return simulateDropColumn(step, sandboxGraph, warnings)
      
    case 'CREATE_STORAGE_BUCKET':
      return simulateCreateBucket(step, sandboxGraph)
      
    case 'GENERATE_API_ENDPOINT':
      return simulateGenerateApi(step, sandboxGraph)
      
    case 'UPDATE_AUTH_CONFIG':
      return simulateUpdateAuth(step, sandboxGraph)
      
    case 'BACKFILL_DEFAULTS':
      return simulateBackfill(step, sandboxGraph, warnings)
      
    default:
      return {
        change: {
          step: step.stepId,
          type: 'config',
          before: null,
          after: null,
          impact: step.description,
        },
      }
  }
}

/**
 * Simulate table creation
 */
function simulateCreateTable(
  step: ExecutionStep,
  graph: BackendStateGraph
): {
  failure?: SimulationFailure
  change?: SimulatedChange
} {
  const tableName = step.target
  
  // Idempotency: If table already exists, it's not a failure for the simulation
  if (graph.entities[tableName]) {
    return {
      change: {
        step: step.stepId,
        type: 'schema',
        before: graph.entities[tableName],
        after: graph.entities[tableName],
        impact: `Table ${tableName} already exists, skipping creation.`,
      },
    }
  }
  
  // Simulate creation with invariants
  graph.entities[tableName] = {
    name: tableName,
    reason: step.description,
    fields: {},
    relationships: [],
    createdAt: new Date().toISOString(),
    createdBy: step.stepId,
    dependencies: [],
    // PRODUCTION-GRADE INVARIANTS: Transfer ALL from step params (1-15)
    uniqueConstraints: step.params.uniqueConstraints,
    quotas: step.params.quotas,
    ownership: step.params.ownership,
    readIsolation: step.params.readIsolation,
    softDelete: step.params.softDelete,
    capacityLimits: step.params.capacityLimits,
    stateMachine: step.params.stateMachine,
    tierGating: step.params.tierGating,
    conflictDetection: step.params.conflictDetection,
    derivedFields: step.params.derivedFields,
    sideEffects: step.params.sideEffects,
    accessRules: step.params.accessRules,
    storagePermissions: step.params.storagePermissions,
  }
  
  return {
    change: {
      step: step.stepId,
      type: 'schema',
      before: null,
      after: { table: tableName, columns: step.params.columns },
      impact: `Creates new table: ${tableName}`,
    },
  }
}

/**
 * Simulate column addition
 */
function simulateAddColumn(
  step: ExecutionStep,
  graph: BackendStateGraph
): {
  failure?: SimulationFailure
  change?: SimulatedChange
} {
  const tableName = step.target
  const columnName = step.params.columnName
  
  const entity = graph.entities[tableName]
  if (!entity) {
    return {
      failure: {
        step: step.stepId,
        reason: `Table ${tableName} does not exist`,
        errorType: 'dependency',
        blocking: true,
      },
    }
  }
  
  // Idempotency: If column already exists, it's not a failure
  if (entity.fields[columnName]) {
    return {
      change: {
        step: step.stepId,
        type: 'schema',
        before: entity.fields[columnName],
        after: entity.fields[columnName],
        impact: `Column ${columnName} already exists in ${tableName}, skipping.`,
      },
    }
  }
  
  // Simulate addition
  const before = { ...entity.fields }
  entity.fields[columnName] = {
    name: columnName,
    type: step.params.columnType,
    reason: step.description,
    nullable: step.params.nullable ?? true,
    unique: false,
    createdAt: new Date().toISOString(),
    createdBy: step.stepId,
    usedBy: [],
  }
  
  return {
    change: {
      step: step.stepId,
      type: 'schema',
      before,
      after: entity.fields,
      impact: `Adds ${columnName} to ${tableName}`,
    },
  }
}

/**
 * Simulate column drop
 */
function simulateDropColumn(
  step: ExecutionStep,
  graph: BackendStateGraph,
  warnings: string[]
): {
  failure?: SimulationFailure
  change?: SimulatedChange
  warnings: string[]
} {
  const tableName = step.target
  const columnName = step.params.columnName
  
  const entity = graph.entities[tableName]
  if (!entity || !entity.fields[columnName]) {
    return {
      failure: {
        step: step.stepId,
        reason: `Column ${columnName} does not exist in ${tableName}`,
        errorType: 'dependency',
        blocking: true,
      },
      warnings,
    }
  }
  
  // Check if column is used
  const field = entity.fields[columnName]
  if (field.usedBy.length > 0) {
    warnings.push(`Column ${columnName} is used by: ${field.usedBy.join(', ')}`)
  }
  
  // Simulate removal
  const before = { ...entity.fields }
  delete entity.fields[columnName]
  
  return {
    change: {
      step: step.stepId,
      type: 'schema',
      before,
      after: entity.fields,
      impact: `Removes ${columnName} from ${tableName} (data will be lost)`,
    },
    warnings,
  }
}

/**
 * Simulate storage bucket creation
 */
function simulateCreateBucket(
  step: ExecutionStep,
  graph: BackendStateGraph
): {
  failure?: SimulationFailure
  change?: SimulatedChange
} {
  const bucketName = step.params.bucketName
  
  if (graph.storage.buckets[bucketName]) {
    // Idempotent: bucket already exists, treat as no-op (not a failure)
    return {
      change: {
        type: 'storage' as const,
        step: `create_bucket_${bucketName}`,
        before: { exists: true },
        after: { exists: true },
        impact: 'none',
      },
    }
  }
  
  // Simulate creation
  graph.storage.buckets[bucketName] = {
    name: bucketName,
    purpose: step.target,
    reason: step.description,
    allowedTypes: step.params.allowedTypes,
    maxFileSize: parseFileSize(step.params.maxFileSize),
    isPublic: step.params.isPublic,
    createdBy: step.stepId,
    usedBy: [],
  }
  
  return {
    change: {
      step: step.stepId,
      type: 'storage',
      before: null,
      after: { bucket: bucketName },
      impact: `Creates storage bucket: ${bucketName}`,
    },
  }
}

/**
 * Simulate API generation
 */
function simulateGenerateApi(
  step: ExecutionStep,
  graph: BackendStateGraph
): {
  failure?: SimulationFailure
  change?: SimulatedChange
  apiChanges?: ApiDiff[]
} {
  const apiPath = step.target
  
  // Check if API exists
  const existingApi = graph.apis[apiPath]
  const changeType = existingApi ? 'modified' : 'added'
  
  // Simulate creation/update
  graph.apis[apiPath] = {
    path: apiPath,
    methods: Array.isArray(step.params.methods)
      ? step.params.methods.filter((m: any) => m != null)
      : step.params.method
        ? [step.params.method]
        : ['GET'],
    requiresAuth: step.params.requiresAuth ?? true,
    rateLimit: step.params.rateLimit ?? 100,
    reason: step.description,
    createdBy: step.stepId,
    dependsOn: [],
  }
  
  const apiDiff: ApiDiff = {
    endpoint: apiPath,
    method: step.params.method || 'ALL',
    changeType,
    breakingChange: changeType === 'modified',
    details: step.description,
  }
  
  return {
    change: {
      step: step.stepId,
      type: 'api',
      before: existingApi || null,
      after: graph.apis[apiPath],
      impact: changeType === 'added' 
        ? `Creates new API: ${apiPath}`
        : `Modifies API: ${apiPath}`,
    },
    apiChanges: [apiDiff],
  }
}

/**
 * Simulate auth config update
 */
function simulateUpdateAuth(
  step: ExecutionStep,
  graph: BackendStateGraph
): {
  change?: SimulatedChange
} {
  const before = { ...graph.auth.providers }
  
  // Parse target (e.g., "auth.providers.google")
  const parts = step.target.split('.')
  const provider = parts[parts.length - 1] as keyof typeof graph.auth.providers
  
  if (provider) {
    graph.auth.providers[provider] = {
      enabled: step.params.enabled,
      reason: step.description,
      createdBy: step.stepId,
    }
  }
  
  return {
    change: {
      step: step.stepId,
      type: 'auth',
      before,
      after: graph.auth.providers,
      impact: `Updates authentication: ${provider}`,
    },
  }
}

/**
 * Simulate data backfill
 */
function simulateBackfill(
  step: ExecutionStep,
  graph: BackendStateGraph,
  warnings: string[]
): {
  change?: SimulatedChange
  warnings: string[]
} {
  // Estimate rows affected (placeholder)
  const estimatedRows = 1000
  
  warnings.push(`Backfill will update approximately ${estimatedRows} rows`)
  
  return {
    change: {
      step: step.stepId,
      type: 'schema',
      before: null,
      after: { backfilled: step.target },
      impact: `Backfills ${estimatedRows} rows with default values`,
    },
    warnings,
  }
}

/**
 * Analyze migration requirements
 */
function analyzeMigration(
  changes: SimulatedChange[],
  graph: BackendStateGraph
): MigrationSummary {
  const affectedTables = new Set<string>()
  const operations: MigrationOperation[] = []
  let requiresDowntime = false
  let duration = 0
  
  for (const change of changes) {
    if (change.type === 'schema') {
      // Extract table name from impact
      const tableMatch = change.impact.match(/(\w+)\s+(?:to|from)/)
      if (tableMatch) {
        affectedTables.add(tableMatch[1])
      }
      
      // Determine operation type
      if (change.impact.includes('Adds')) {
        operations.push({
          table: tableMatch?.[1] || 'unknown',
          operation: 'add_column',
          safe: true,
          reversible: true,
        })
        duration += 2
      } else if (change.impact.includes('Removes')) {
        operations.push({
          table: tableMatch?.[1] || 'unknown',
          operation: 'drop_column',
          safe: false,
          reversible: false,
        })
        requiresDowntime = true
        duration += 5
      } else if (change.impact.includes('Backfills')) {
        operations.push({
          table: tableMatch?.[1] || 'unknown',
          operation: 'backfill',
          safe: true,
          reversible: false,
        })
        duration += 10
      }
    }
  }
  
  return {
    affectedTables: Array.from(affectedTables),
    estimatedRows: 1000, // Placeholder
    requiresDowntime,
    duration,
    operations,
  }
}

/**
 * Parse file size string to bytes
 */
function parseFileSize(size: string): number {
  const units: Record<string, number> = {
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
  }
  
  const match = size.match(/^(\d+)([A-Z]+)$/)
  if (!match) return 5 * 1024 * 1024 // Default 5MB
  
  const value = parseInt(match[1])
  const unit = match[2]
  
  return value * (units[unit] || 1)
}
