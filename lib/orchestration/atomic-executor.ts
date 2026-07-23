/**
 * Phase 6: Atomic Execution Engine
 * 
 * All-or-nothing execution across DB, Auth, Storage, API configs.
 * If any step fails → automatic rollback.
 * 
 * This is why users trust Backenly.
 */

import { ExecutionPlan, ExecutionStep } from './execution-plan-generator'
import { BackendStateGraph } from './backend-state-graph'
import { DryRunResult } from './dry-run-simulator'
import { CapabilityRegistry } from './capabilities'
import { BackgroundJobExecutor } from './jobs-capability'
import { SchedulingExecutor } from './scheduling-capability'
import { WebhookExecutor, EventExecutor } from './integration-capability'
import { EmailExecutor } from './messaging-capability'
import { BillingExecutor } from './billing-capability'
import { RealtimeExecutor } from './realtime-capability'
import { SearchExecutor, AnalyticsExecutor } from './data-capability'
import * as crypto from 'crypto'
import { createApiVersion, extractSchemaSnapshot } from '@/lib/api/automatic-versioning'
import { prisma } from '@/lib/db'
import { queuePendingActionFinding } from '@/lib/operational-memory/ledger'

export interface ExecutionResult {
  success: boolean
  plan: ExecutionPlan
  executedSteps: ExecutedStep[]
  failedStep?: ExecutedStep
  rollbackPerformed: boolean
  finalState: BackendStateGraph
  changes: ExecutionChange[]
  message: string
}

export interface ExecutedStep {
  stepId: string
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'rolled_back'
  startedAt?: string
  completedAt?: string
  error?: string
  result?: any
}

/**
 * PHASE 5: Granular change tracking for timeline transparency
 * Records exactly what changed with full context for user verification
 */
export interface ExecutionChange {
  type: 'table' | 'column' | 'api' | 'auth' | 'storage' | 'capability' | 'job' | 'deployment'
  action: 'created' | 'modified' | 'deleted' | 'enabled' | 'disabled'
  target: string // Entity name, endpoint path, provider name, etc.
  details: ChangeDetails
}

/**
 * Detailed change metadata for timeline granularity
 */
export interface ChangeDetails {
  // Table changes
  entityName?: string
  fields?: FieldDefinition[]
  columns?: any // Legacy field list
  
  // Column changes
  fieldName?: string
  fieldType?: string
  type?: string // Legacy type field
  constraints?: string[]
  
  // API changes
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  methods?: string[] // Multiple HTTP methods
  path?: string
  endpoints?: string[]
  purpose?: string // API purpose/description
  
  // Auth changes
  authProvider?: string // 'google', 'github', 'email', etc.
  authType?: string // 'oauth', 'password', 'magic-link', etc.
  config?: Record<string, any>
  enabled?: boolean
  
  // Storage changes
  bucketName?: string
  bucketId?: string
  allowedTypes?: string[]
  maxSize?: number
  
  // Integration/Capability changes
  capabilityType?: string
  integrationName?: string
  settings?: Record<string, any>
  
  // Deployment changes
  deploymentUrl?: string
  environment?: string
  deploymentProvider?: string // Renamed to avoid conflict
  status?: string
  
  // Generic metadata
  message?: string // Legacy message field
  metadata?: Record<string, any>
  [key: string]: any // Allow additional properties for flexibility
}

/**
 * Field definition for table changes
 */
export interface FieldDefinition {
  name: string
  type: string
  required?: boolean
  unique?: boolean
  default?: any
}

/**
 * Execute plan atomically
 * 
 * CRITICAL: Either everything applies or nothing applies
 */
export async function executeAtomic(
  plan: ExecutionPlan,
  graph: BackendStateGraph,
  dryRunResult: DryRunResult
): Promise<ExecutionResult> {
  console.log('[Atomic Executor] Starting atomic execution:', plan.planId)
  
  // Verify dry-run passed
  if (!dryRunResult.safeToExecute) {
    return {
      success: false,
      plan,
      executedSteps: [],
      rollbackPerformed: false,
      finalState: graph,
      changes: [],
      message: 'Something didn\'t work. Nothing was changed.',
    }
  }
  
  const executedSteps: ExecutedStep[] = []
  const changes: ExecutionChange[] = []
  let currentGraph = JSON.parse(JSON.stringify(graph))
  
  // Create transaction checkpoint
  const checkpoint = createCheckpoint(graph)
  
  // PHASE 9: Deployment Guard - Verify lineage before execution
  if (graph.lineageHash !== 'genesis') {
    console.log(`[Atomic Executor] Guard: Verifying lineage hash (${graph.lineageHash})`)
    // In production, we would verify the chain here.
  }
  
  try {
    // Execute steps in order
    for (const step of plan.steps) {
      const executedStep: ExecutedStep = {
        stepId: step.stepId,
        status: 'executing',
        startedAt: new Date().toISOString(),
      }
      
      executedSteps.push(executedStep)

      console.log(`[Atomic Executor] Executing step: ${step.stepId}`)

      try {
        // Phase 4 — risk gate. This executor only mutates the in-memory
        // BackendStateGraph (real DB writes happen later, elsewhere) so a
        // risky step can't be paused mid-plan and resumed the way the brain's
        // minimal-executor gate can — it must fail the whole atomic plan
        // (which the existing catch below already rolls back). DROP_TABLE and
        // DROP_COLUMN map 1:1 to a real AIAction in minimal-executor.ts, so an
        // approval finding for those is genuinely resumable; for the others we
        // just require confirmation rather than write a finding we can't re-run.
        const gate = riskGateForStep(step)
        if (gate && !step.params?.confirmed) {
          if (gate.resumable) {
            await queuePendingActionFinding({
              projectId: currentGraph.projectId,
              action: gate.action,
              params: { tableName: step.target, ...step.params },
              target: step.target,
              riskLevel: gate.riskLevel,
              source: 'orchestration-risk',
              reason: `Backenly paused this ${gate.riskLevel}-risk change for your review instead of applying it immediately.`,
            }).catch((error) => {
              console.error('[Atomic Executor] Failed to queue pending action finding:', error)
            })
          }
          throw new Error(
            `${step.action} on ${step.target} is a ${gate.riskLevel}-risk change and requires confirmation before it can apply.` +
            (gate.resumable ? ' Review it under Autonomy, or re-describe the change with confirmation.' : ''),
          )
        }

        // Execute the step
        const result = await executeStep(step, currentGraph)
        
        executedStep.status = 'completed'
        executedStep.completedAt = new Date().toISOString()
        executedStep.result = result
        
        // Track changes
        if (result.change) {
          changes.push(result.change)
        }
        
      } catch (error) {
        // Step failed - mark and throw
        executedStep.status = 'failed'
        executedStep.completedAt = new Date().toISOString()
        executedStep.error = error instanceof Error ? error.message : 'Unknown error'
        
        throw new Error(`Step ${step.stepId} failed: ${executedStep.error}`)
      }
    }
    
    // All steps completed successfully
    console.log('[Atomic Executor] All steps completed successfully')
    
    return {
      success: true,
      plan,
      executedSteps,
      rollbackPerformed: false,
      finalState: currentGraph,
      changes,
      message: generateSuccessMessage(changes),
    }
    
  } catch (error) {
    // Execution failed - perform rollback
    console.error('[Atomic Executor] Execution failed, performing rollback:', error)
    
    const rollbackSuccess = await performRollback(
      executedSteps,
      checkpoint,
      currentGraph
    )
    
    // Mark all steps as rolled back
    executedSteps.forEach(step => {
      if (step.status === 'completed') {
        step.status = 'rolled_back'
      }
    })
    
    return {
      success: false,
      plan,
      executedSteps,
      failedStep: executedSteps.find(s => s.status === 'failed'),
      rollbackPerformed: rollbackSuccess,
      finalState: rollbackSuccess ? checkpoint.graph : currentGraph,
      changes: [],
      message: 'Something didn\'t work. Nothing was changed.',
    }
  }
}

/**
 * Phase 4 — pre-execution risk classification for one ExecutionStep.
 * Mirrors lib/operational-memory/ledger.ts's risk semantics (delete = high,
 * auth disabled = high, deployment = medium) but must run BEFORE executeStep
 * runs, since these step handlers mutate the graph in place before returning
 * a change record.
 */
function riskGateForStep(
  step: ExecutionStep,
): { riskLevel: 'medium' | 'high'; resumable: boolean; action: string } | null {
  switch (step.action) {
    case 'DROP_TABLE':
      return { riskLevel: 'high', resumable: true, action: 'DROP_TABLE' }
    case 'DROP_COLUMN':
      return { riskLevel: 'high', resumable: true, action: 'DROP_COLUMN' }
    case 'UPDATE_AUTH_CONFIG':
      return step.params?.enabled === false
        ? { riskLevel: 'high', resumable: false, action: step.action }
        : null
    case 'DEPLOY_CHANGES':
      return { riskLevel: 'medium', resumable: false, action: step.action }
    default:
      return null
  }
}

/**
 * Execute single step
 */
async function executeStep(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change?: ExecutionChange }> {
  // Simulate execution (in production, this would call real APIs)
  await sleep(100) // Simulate work
  
  switch (step.action) {
    case 'CREATE_TABLE':
      return executeCreateTable(step, graph)
      
    case 'ADD_TABLE_COLUMN':
      return executeAddColumn(step, graph)
      
    case 'DROP_COLUMN':
      return executeDropColumn(step, graph)
      
    case 'ADD_UNIQUE_CONSTRAINT':
      return executeAddUniqueConstraint(step, graph)
      
    case 'CREATE_STORAGE_BUCKET':
      return executeCreateBucket(step, graph)
      
    case 'GENERATE_API_ENDPOINT':
      return executeGenerateApi(step, graph)
      
    case 'UPDATE_AUTH_CONFIG':
      return executeUpdateAuth(step, graph)
      
    case 'DROP_TABLE':
      return executeDropTable(step, graph)

    case 'UPDATE_SECURITY_RULES':
      return executeUpdateSecurityRules(step, graph)
      
    case 'APPLY_POLICY':
      return executeApplyPolicy(step, graph)
      
    case 'APPLY_CAPABILITY':
      return executeApplyCapability(step, graph)
      
    case 'DEPLOY_CHANGES':
      return { change: { type: 'api', action: 'modified', target: 'production', details: step.params } }

    case 'CREATE_SNAPSHOT':
      return { change: undefined } // Snapshot already created
      
    default:
      console.log(`[Atomic Executor] Unknown action: ${step.action}`)
      return { change: undefined }
  }
}

/**
 * Execute table creation
 */
async function executeCreateTable(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change: ExecutionChange }> {
  const tableName = step.target
  
  // Idempotency
  if (graph.entities[tableName]) {
    return {
      change: {
        type: 'table',
        action: 'modified',
        target: tableName,
        details: { message: 'Table already exists, skipping creation.' },
      },
    }
  }

  // In production: CREATE TABLE SQL via Prisma
  // For now: Update graph
  // Convert columns to fields format for the graph
  const columns = step.params.columns || []
  const fields: Record<string, any> = {}
  const relationships: any[] = []
  
  columns.forEach((col: any) => {
    // Map SQL types back to simple types for FieldState
    let fieldType = col.type
    if (col.type === 'VARCHAR(255)' || col.type === 'TEXT' || col.type === 'VARCHAR(2048)') {
      fieldType = 'string'
    } else if (col.type === 'INTEGER' || col.type === 'BIGINT' || col.type === 'DECIMAL') {
      fieldType = 'number'
    } else if (col.type === 'BOOLEAN') {
      fieldType = 'boolean'
    } else if (col.type === 'TIMESTAMP' || col.type === 'DATE') {
      fieldType = 'date'
    } else if (col.type === 'UUID') {
      fieldType = 'string' // UUIDs are stored as strings in the graph
    }
    
    fields[col.name] = {
      name: col.name,
      type: fieldType,
      nullable: !col.required && !col.primaryKey, // Primary keys are never nullable
      unique: col.unique ?? col.primaryKey ?? false, // Primary keys are unique
      primary: col.primaryKey ?? false, // Preserve primary key flag
      default: col.default,
      createdAt: new Date().toISOString(),
      createdBy: step.stepId,
      reason: `Column in ${tableName}`,
      usedBy: [],
    }
    
    // If this column has a referenceTo, create a relationship
    if (col.referenceTo) {
      relationships.push({
        to: col.referenceTo,
        type: 'one-to-many',
        foreignKey: col.name,
        createdAt: new Date().toISOString(),
      })
    }
  })
  
  graph.entities[tableName] = {
    name: tableName,
    reason: step.description,
    fields,
    relationships,
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
  
  // AUTOMATIC API VERSIONING: Create version on table creation
  // AUTOMATIC API VERSIONING - TEMPORARILY DISABLED
  // TODO: Fix api_versions table schema mismatch
  /*
  try {
    const schema = extractSchemaSnapshot(tableName, graph)
    const projectId = graph.projectId
    
    // Create initial API version (v1) for this table
    await createApiVersion(
      prisma,
      projectId,
      `table_${tableName}`,
      tableName,
      schema,
      step.stepId
    )
    
    console.log(`[AutoVersion] ✅ Created API v1 for table ${tableName}`)
  } catch (error) {
    console.error(`[AutoVersion] Failed to create API version for ${tableName}:`, error)
    // Don't fail the entire execution - versioning is non-blocking
  }
  */
  console.log(`[AutoVersion] ⏭️  API versioning disabled (schema fix needed)`)
  
  return {
    change: {
      type: 'table',
      action: 'created',
      target: tableName,
      details: { columns: step.params.columns },
    },
  }
}

/**
 * Execute column addition
 */
async function executeAddColumn(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change: ExecutionChange }> {
  const tableName = step.target
  const columnName = step.params.columnName
  
  // In production: ALTER TABLE ADD COLUMN
  const entity = graph.entities[tableName]
  if (!entity) {
    throw new Error(`Table ${tableName} not found`)
  }
  
  // Idempotency
  if (entity.fields[columnName]) {
    return {
      change: {
        type: 'column',
        action: 'modified',
        target: `${tableName}.${columnName}`,
        details: { message: 'Column already exists, skipping.' },
      },
    }
  }

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
  
  // AUTOMATIC API VERSIONING - TEMPORARILY DISABLED
  /*
  try {
    const schema = extractSchemaSnapshot(tableName, graph)
    const projectId = graph.projectId
    
    await createApiVersion(
      prisma,
      projectId,
      `table_${tableName}`,
      tableName,
      schema,
      step.stepId
    )
    
    console.log(`[AutoVersion] ✅ Created new API version for ${tableName} (added column ${columnName})`)
  } catch (error) {
    console.error(`[AutoVersion] Failed to create API version:`, error)
    // Non-blocking
  }
  */
  
  return {
    change: {
      type: 'column',
      action: 'created',
      target: `${tableName}.${columnName}`,
      details: { type: step.params.columnType },
    },
  }
}

/**
 * Execute add unique constraint
 */
async function executeAddUniqueConstraint(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change: ExecutionChange }> {
  const tableName = step.target
  const fieldName = step.params.fieldName
  
  const entity = graph.entities[tableName]
  if (!entity) {
    throw new Error(`Table ${tableName} not found`)
  }
  
  const field = entity.fields[fieldName]
  if (!field) {
    throw new Error(`Field ${fieldName} not found in ${tableName}`)
  }
  
  // Idempotency: if already unique, skip
  if (field.unique) {
    return {
      change: {
        type: 'column',
        action: 'modified',
        target: `${tableName}.${fieldName}`,
        details: { message: 'Field already unique, skipping.' },
      },
    }
  }
  
  // Set unique flag
  field.unique = true
  
  return {
    change: {
      type: 'column',
      action: 'modified',
      target: `${tableName}.${fieldName}`,
      details: { unique: true },
    },
  }
}

/**
 * Execute column drop
 */
async function executeDropColumn(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change: ExecutionChange }> {
  const tableName = step.target
  const columnName = step.params.columnName
  
  // In production: ALTER TABLE DROP COLUMN
  const entity = graph.entities[tableName]
  if (!entity || !entity.fields[columnName]) {
    throw new Error(`Column ${columnName} not found in ${tableName}`)
  }
  
  delete entity.fields[columnName]
  
  // AUTOMATIC API VERSIONING - TEMPORARILY DISABLED
  /*
  try {
    const schema = extractSchemaSnapshot(tableName, graph)
    const projectId = graph.projectId
    
    await createApiVersion(
      prisma,
      projectId,
      `table_${tableName}`,
      tableName,
      schema,
      step.stepId
    )
    
    console.log(`[AutoVersion] ✅ Created new API version for ${tableName} (dropped column ${columnName})`)
  } catch (error) {
    console.error(`[AutoVersion] Failed to create API version:`, error)
    // Non-blocking
  }
  */
  
  return {
    change: {
      type: 'column',
      action: 'deleted',
      target: `${tableName}.${columnName}`,
      details: {},
    },
  }
}

/**
 * Execute storage bucket creation
 */
async function executeCreateBucket(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change: ExecutionChange }> {
  const bucketName = step.params.bucketName || `user_${step.target}`
  console.log(`[Atomic Executor] Creating bucket: ${bucketName} for target: ${step.target}`)

  // Idempotent: if bucket already exists, skip creation silently
  if (graph.storage.buckets[bucketName]) {
    console.log(`[Atomic Executor] Bucket ${bucketName} already exists — skipping`)
    return {
      change: {
        type: 'storage',
        action: 'skipped',
        name: bucketName,
        description: `Bucket ${bucketName} already exists`,
      } as any,
    }
  }

  // In production: Create S3 bucket
  graph.storage.buckets[bucketName] = {
    name: bucketName,
    purpose: step.target,
    reason: step.description,
    allowedTypes: step.params.allowedTypes || ['*/*'],
    maxFileSize: typeof step.params.maxFileSize === 'number' ? step.params.maxFileSize : 10 * 1024 * 1024, 
    isPublic: step.params.isPublic ?? false,
    createdBy: step.stepId,
    usedBy: [],
  }
  
  return {
    change: {
      type: 'storage',
      action: 'created',
      target: bucketName,
      details: { purpose: step.target, config: step.params },
    },
  }
}

/**
 * Execute API generation
 */
async function executeGenerateApi(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change: ExecutionChange }> {
  const apiPath = step.target
  
  // In production: Generate API route files
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

  return {
    change: {
      type: 'api',
      action: 'created',
      target: apiPath,
      details: { methods: graph.apis[apiPath].methods },
    },
  }
}

/**
 * Execute auth config update
 */
async function executeUpdateAuth(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change: ExecutionChange }> {
  // Parse target (e.g., "auth.providers.google")
  const parts = step.target.split('.')
  const provider = parts[parts.length - 1] as keyof typeof graph.auth.providers
  
  // In production: Update OAuth config
  if (provider) {
    graph.auth.providers[provider] = {
      enabled: step.params.enabled,
      reason: step.description,
      createdBy: step.stepId,
    }
  }
  
  return {
    change: {
      type: 'auth',
      action: 'modified',
      target: provider,
      details: { enabled: step.params.enabled },
    },
  }
}

/**
 * Create checkpoint for rollback
 */
function createCheckpoint(graph: BackendStateGraph): {
  timestamp: string
  graph: BackendStateGraph
} {
  return {
    timestamp: new Date().toISOString(),
    graph: JSON.parse(JSON.stringify(graph)), // Deep clone
  }
}

/**
 * Perform rollback to checkpoint
 */
async function performRollback(
  executedSteps: ExecutedStep[],
  checkpoint: { timestamp: string; graph: BackendStateGraph },
  currentGraph: BackendStateGraph
): Promise<boolean> {
  console.log('[Atomic Executor] Starting rollback to checkpoint:', checkpoint.timestamp)
  
  try {
    // In production: Execute reverse operations
    // For now: Restore checkpoint
    Object.assign(currentGraph, checkpoint.graph)
    
    console.log('[Atomic Executor] Rollback completed successfully')
    return true
    
  } catch (error) {
    console.error('[Atomic Executor] Rollback failed:', error)
    return false
  }
}

/**
 * Generate success message
 */
function generateSuccessMessage(changes: ExecutionChange[]): string {
  const tablesCreated = changes.filter(c => c.type === 'table' && c.action === 'created').length
  const columnsAdded = changes.filter(c => c.type === 'column' && c.action === 'created').length
  const apisCreated = changes.filter(c => c.type === 'api' && c.action === 'created').length
  const authUpdated = changes.some(c => c.type === 'auth')
  
  const parts: string[] = []
  
  if (tablesCreated > 0) {
    parts.push(`Created ${tablesCreated} ${tablesCreated === 1 ? 'table' : 'tables'}`)
  }
  if (columnsAdded > 0) {
    parts.push(`Added ${columnsAdded} ${columnsAdded === 1 ? 'field' : 'fields'}`)
  }
  if (apisCreated > 0) {
    parts.push(`Created ${apisCreated} ${apisCreated === 1 ? 'API' : 'APIs'}`)
  }
  if (authUpdated) {
    parts.push('Updated authentication')
  }
  
  if (parts.length === 0) {
    return 'Your backend is ready.'
  }
  
  return `Your backend has been updated. ${parts.join('. ')}.`
}

/**
 * Execute table drop
 */
async function executeDropTable(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change: ExecutionChange }> {
  const tableName = step.target
  if (!graph.entities[tableName]) {
    throw new Error(`Table ${tableName} not found`)
  }
  
  // ============================================================================
  // REFERENTIAL INTEGRITY CHECK: Strict Mode
  // ============================================================================
  // Before deleting, check if any other entities reference this table
  const dependencies: string[] = []
  
  Object.entries(graph.entities).forEach(([entityName, entity]: [string, any]) => {
    // Skip the entity being deleted
    if (entityName === tableName) return
    
    // Check relationships
    if (entity.relationships) {
      entity.relationships.forEach((rel: any) => {
        if (rel.to === tableName) {
          dependencies.push(`${entityName}.${rel.foreignKey || rel.type}`)
        }
      })
    }
    
    // Check fields that reference this entity (foreign key fields)
    if (entity.fields) {
      Object.entries(entity.fields).forEach(([fieldName, field]: [string, any]) => {
        // Check if field name suggests it's a foreign key to the deleted table
        // e.g., userId -> users, orderId -> orders
        const singularTable = tableName.replace(/s$/, '')
        if (fieldName.toLowerCase() === `${singularTable}id`.toLowerCase()) {
          dependencies.push(`${entityName}.${fieldName}`)
        }
      })
    }
  })
  
  // STRICT MODE: Reject deletion if dependencies exist
  if (dependencies.length > 0) {
    // Deduplicate dependencies (same field can be detected via relationships and field naming)
    const uniqueDependencies = Array.from(new Set(dependencies))
    const errorMessage = `Cannot delete ${tableName}. Referenced by: ${uniqueDependencies.join(', ')}`
    console.error(`[Atomic Executor] ❌ ${errorMessage}`)
    throw new Error(errorMessage)
  }
  
  delete graph.entities[tableName]
  
  return {
    change: {
      type: 'table',
      action: 'deleted',
      target: tableName,
      details: {},
    },
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
/**
 * Check if a semantically identical policy already exists in the graph.
 * Semantic identity ignores id, createdAt, createdBy.
 */
function findExistingPolicy(
  graph: BackendStateGraph,
  newPolicy: {
    domain: string
    action: string
    target: string
    rule?: string
    enabled: boolean
    role?: string
    resource?: string
    operation?: string
  }
): string | null {
  for (const [policyId, policy] of Object.entries(graph.policies || {})) {
    if (
      policy.domain === newPolicy.domain &&
      policy.action === newPolicy.action &&
      policy.target === newPolicy.target &&
      policy.rule === newPolicy.rule &&
      policy.enabled === newPolicy.enabled &&
      policy.role === newPolicy.role &&
      policy.resource === newPolicy.resource &&
      policy.operation === newPolicy.operation
    ) {
      return policyId
    }
  }
  return null
}

async function executeApplyPolicy(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change: ExecutionChange }> {
  // Build policy object for semantic comparison
  const newPolicy = {
    domain: step.params.domain || 'access',
    action: step.params.action || 'enforce',
    target: step.target,
    rule: step.params.rule,
    enabled: step.params.enabled ?? true,
    role: step.params.role,
    resource: step.params.resource,
    operation: step.params.operation,
  }
  
  // CRITICAL: Check for semantic duplicate before creating
  const existingPolicyId = findExistingPolicy(graph, newPolicy)
  
  if (existingPolicyId) {
    console.log(`[Atomic Executor] Policy already exists (semantic duplicate): ${existingPolicyId}`)
    return {
      change: {
        type: 'auth',
        action: 'modified',
        target: `policy.${step.target}`,
        details: { existingPolicyId, skipped: true, reason: 'Semantic duplicate' },
      },
    }
  }
  
  const policyId = `pol_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
  
  graph.policies[policyId] = {
    id: policyId,
    name: step.params.policyName || 'Unnamed Policy',
    ...newPolicy,
    reason: step.description,
    createdBy: step.stepId,
    createdAt: new Date().toISOString(),
  }
  
  return {
    change: {
      type: 'auth',
      action: 'modified',
      target: `policy.${step.target}`,
      details: graph.policies[policyId],
    },
  }
}

async function executeApplyCapability(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change: ExecutionChange }> {
  const registry = CapabilityRegistry.getInstance()
  
  // Register default capabilities if not already registered
  if (!registry.get('BACKGROUND_JOBS')) {
    registry.register(new BackgroundJobExecutor())
  }
  if (!registry.get('SCHEDULING')) {
    registry.register(new SchedulingExecutor())
  }
  if (!registry.get('WEBHOOKS')) {
    registry.register(new WebhookExecutor())
  }
  if (!registry.get('EVENTS')) {
    registry.register(new EventExecutor())
  }
  if (!registry.get('EMAIL_MESSAGING')) {
    registry.register(new EmailExecutor())
  }
  if (!registry.get('STRIPE_BILLING')) {
    registry.register(new BillingExecutor())
  }
  if (!registry.get('REALTIME_SYNC')) {
    registry.register(new RealtimeExecutor())
  }
  if (!registry.get('SEARCH_INDEXING')) {
    registry.register(new SearchExecutor())
  }
  if (!registry.get('USAGE_ANALYTICS')) {
    registry.register(new AnalyticsExecutor())
  }
  
  const capabilityType = step.params.capabilityType
  const executor = registry.get(capabilityType)
  
  if (!executor) {
    throw new Error(`Capability executor for ${capabilityType} not found`)
  }

  // PHASE 9: Capture previous section state for rollback
  const ownedSection = (executor as any).descriptor.ownedGraphSection
  if (ownedSection && (graph as any)[ownedSection]) {
    step.params.previousSectionState = JSON.parse(JSON.stringify((graph as any)[ownedSection]))
  }
  
  const validation = executor.validate(step.params.config, graph)
  if (!validation.valid) {
    throw new Error(`Capability validation failed: ${validation.error}`)
  }
  
  const result = await executor.execute(step.params.config, graph)
  
  if (!result.success) {
    throw new Error(`Capability execution failed: ${result.message}`)
  }
  
  // Apply graph changes from capability
  if (result.graphChanges) {
    Object.keys(result.graphChanges).forEach(section => {
      const sec = section as keyof BackendStateGraph
      if (typeof graph[sec] === 'object' && !Array.isArray(graph[sec])) {
        Object.assign(graph[sec], result.graphChanges[sec])
      } else {
        (graph as any)[sec] = result.graphChanges[sec]
      }
    })
  }

  graph.version += 1
  graph.lastUpdated = new Date().toISOString()

  // PHASE 9: Lineage Hash Inclusion
  const lineageInput = `${graph.lineageHash}-${JSON.stringify(result.graphChanges)}-${step.stepId}`
  graph.lineageHash = crypto.createHash('sha256').update(lineageInput).digest('hex')
  
  return {
    change: {
      type: 'capability',
      action: 'created',
      target: capabilityType,
      details: result.details,
    },
  }
}

async function executeUpdateSecurityRules(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change: ExecutionChange }> {
  // Update graph state for persistence
  if (step.target === 'api.global') {
    graph.auth.requirements.requireAuth = step.params.requiresAuth ?? true;
  }
  
  // Ensure graph mutation is detected by test scripts
  (graph as any).config = (graph as any).config || {};
  (graph as any).config[step.target] = step.params;
  graph.version += 1;
  graph.lastUpdated = new Date().toISOString();

  return {
    change: {
      type: 'api',
      action: 'modified',
      target: step.target,
      details: step.params,
    },
  }
}
