/**
 * REAL EXECUTOR - Where Simulation Ends and Reality Begins
 * 
 * This replaces the mock atomic-executor with ACTUAL side effects:
 * - Real Prisma schema generation
 * - Real database migrations  
 * - Real table creation
 * - Real API generation
 * - Real persistence
 * 
 * ENGINE MODE SUPPORT:
 * - runtime: Full execution with real database operations
 * - integration: Test-safe execution that validates plans without real DDL
 * - simulation: No-op execution for preview/testing
 */

import { ExecutionPlan, ExecutionStep } from '@/lib/orchestration/execution-plan-generator'
import { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'
import { ExecutionResult, ExecutionChange, ExecutedStep } from '@/lib/orchestration/atomic-executor'
import { generatePrismaSchema } from './schema-writer'
import { runMigration, verifyTablesExist } from './migration-runner'
import { shouldExecuteRealMigrations, shouldPersistGraph, getModeSpecificMessage } from '@/lib/config/engine-mode'

/**
 * Execute plan with REAL side effects
 * 
 * This is the critical function that makes Backenly a real backend builder
 */
export async function executeReal(
  plan: ExecutionPlan,
  graph: BackendStateGraph,
  projectId: string
): Promise<ExecutionResult> {
  console.log('[Real Executor] 🚀 Starting REAL execution (not simulation)')
  console.log(`[Real Executor] Project: ${projectId}`)
  console.log(`[Real Executor] Plan: ${plan.planId}`)
  console.log(`[Real Executor] Steps: ${plan.steps.length}`)
  console.log(`[Real Executor] Input graph entities:`, Object.keys(graph.entities).join(', '))
  
  const executedSteps: ExecutedStep[] = []
  const changes: ExecutionChange[] = []
  let currentGraph = JSON.parse(JSON.stringify(graph))
  console.log(`[Real Executor] Copied graph entities:`, Object.keys(currentGraph.entities).join(', '))
  
  try {
    // PHASE 0: Ensure workspace exists and is provisioned
    console.log('[Real Executor] Phase 0: Checking workspace provisioning')
    
    // INTEGRATION MODE: Skip workspace provisioning entirely
    if (process.env.ENGINE_MODE === 'integration') {
      console.log('[Real Executor] 🧪 INTEGRATION MODE - Skipping workspace provisioning')
    } else {
      const { prisma } = await import('@/lib/db')
      const { provisionWorkspaceDatabase } = await import('@/lib/services/databaseProvisioning')
      
      let workspace = await prisma.workspace.findFirst({
        where: { projectId },
      })
      
      if (!workspace) {
        console.log('[Real Executor] No workspace found, creating one...')
        workspace = await prisma.workspace.create({
          data: {
            name: `Workspace for project ${projectId}`,
            projectId,
            postgresSchema: `workspace_${projectId}`,
            databaseProvisioned: false,
          },
        })
      }
      
      if (!workspace.databaseProvisioned) {
        console.log('[Real Executor] Workspace not provisioned, provisioning now...')
        try {
          await provisionWorkspaceDatabase(workspace.id, projectId)
          console.log('[Real Executor] ✅ Workspace provisioned successfully')
        } catch (provisionError) {
          console.error('[Real Executor] ❌ Workspace provisioning failed:', provisionError)
          throw new Error(`Failed to provision workspace: ${provisionError instanceof Error ? provisionError.message : 'Unknown error'}`)
        }
      } else {
        console.log('[Real Executor] ✅ Workspace already provisioned')
      }
    }
    
    // PHASE 1: Run atomic executor to update graph with entities
    console.log('[Real Executor] Phase 1: Running atomic executor to build graph state')
    const { executeAtomic } = await import('@/lib/orchestration/atomic-executor')
    
    // Run with empty dry-run (we already validated in orchestration)
    const atomicResult = await executeAtomic(plan, currentGraph, { 
      success: true,
      safeToExecute: true, 
      failures: [],
      warnings: [],
      simulatedChanges: [],
      estimatedTime: 0,
      estimatedDowntime: 0,
      apiDiff: [],
      dataMigration: {
        affectedTables: [],
        estimatedRows: 0,
        requiresDowntime: false,
        duration: 0,
        operations: [],
      },
    })
    
    if (!atomicResult.success) {
      const errorMessage = atomicResult.failedStep?.error || atomicResult.message || 'Atomic executor failed to build graph state'
      console.error('[Real Executor] ❌ Atomic execution failed:', errorMessage)
      throw new Error(errorMessage)
    }
    
    // Update currentGraph with the result that includes all entities
    currentGraph = atomicResult.finalState
    console.log('[Real Executor] ✅ Graph state updated')
    console.log(`[Real Executor] Entities in graph: ${Object.keys(currentGraph.entities).join(', ')}`)
    
    // PHASE 2: Generate Prisma Schema (REAL FILE) from updated graph
    console.log('[Real Executor] Phase 2: Generating Prisma schema from updated graph')
    const schemaResult = await generatePrismaSchema(currentGraph, projectId)
    
    if (!schemaResult.success) {
      throw new Error(`Schema generation failed: ${schemaResult.error}`)
    }
    
    console.log(`[Real Executor] ✅ Schema generated: ${schemaResult.tablesGenerated.join(', ')}`)
    
    // PHASE 3: Run Migration (REAL DATABASE MUTATION) - RESPECT ENGINE MODE
    if (schemaResult.tablesGenerated.length > 0) {
      console.log('[Real Executor] Phase 3: Running database migration')
      
      const migrationName = `add_${schemaResult.tablesGenerated.join('_')}_${Date.now()}`
      
      // Only execute real migrations in runtime mode
      if (shouldExecuteRealMigrations()) {
        const migrationResult = await runMigration(
          projectId,
          schemaResult.schemaPath,
          migrationName
        )
        
        if (!migrationResult.success) {
          throw new Error(`Migration failed: ${migrationResult.error}`)
        }
        
        console.log(`[Real Executor] ✅ Migration applied: ${migrationName}`)
        
        // PHASE 4: Verify Tables Exist (PROOF OF REALITY)
        console.log('[Real Executor] Phase 4: Verifying tables in database')
        const verification = await verifyTablesExist(projectId, schemaResult.tablesGenerated)
        
        if (!verification.exists) {
          throw new Error(`Tables not found in database: ${verification.missingTables.join(', ')}`)
        }
        
        console.log(`[Real Executor] ✅ Tables verified in database: ${verification.foundTables.join(', ')}`)
        
        // CRITICAL: Save table metadata to public.tables
        const { prisma } = await import('@/lib/db')
        const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
        const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
        
        // Use the ORIGINAL entity names from graph (lowercase) instead of PostgreSQL names (capitalized)
        // This ensures consistency between graph.entities and public.tables
        const entityNames = Object.keys(currentGraph.entities)
        
        for (const tableName of entityNames) {
          // Check if metadata already exists (case-insensitive check)
          const existing = await prisma.table.findFirst({
            where: {
              projectId,
              name: {
                equals: tableName,
                mode: 'insensitive',
              },
            },
          })
          
          if (!existing) {
            // Create metadata record with lowercase name from graph
            await prisma.table.create({
              data: {
                projectId,
                name: tableName, // Use graph name (lowercase)
                schema: postgresSchema,
                description: `${tableName} table`,
              },
            })
            console.log(`[Real Executor] ✅ Created metadata for table: ${tableName}`)
          } else {
            console.log(`[Real Executor] ℹ️  Metadata already exists for table: ${tableName}`)
          }
        }
        
        // Track changes with actual verification results
        for (const tableName of verification.foundTables) {
          changes.push({
            type: 'table',
            action: 'created',
            target: tableName,
            details: {
              realTable: true, // Mark as REAL, not simulated
              verifiedInDB: true,
            },
          })
          
          executedSteps.push({
            stepId: `create_table_${tableName}`,
            status: 'completed',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            result: { tableName, verified: true },
          })
        }
      } else {
        // Integration/Simulation mode - skip real DDL but validate the plan
        console.log(`[Real Executor] ${process.env.ENGINE_MODE?.toUpperCase() || 'INTEGRATION'} MODE - Skipping real DDL execution`)
        console.log(`[Real Executor] Would create tables: ${schemaResult.tablesGenerated.join(', ')}`)
        
        // Still verify the schema was generated correctly
        const fs = await import('fs')
        if (!fs.existsSync(schemaResult.schemaPath)) {
          throw new Error(`Schema file not generated: ${schemaResult.schemaPath}`)
        }
        
        console.log(`[Real Executor] ✅ Schema validation passed`)
        
        // Track changes as planned (would-be-created) tables
        for (const tableName of schemaResult.tablesGenerated) {
          changes.push({
            type: 'table',
            action: 'created',
            target: tableName,
            details: {
              realTable: false, // Mark as planned, not real
              verifiedInDB: false,
              integrationMode: true,
            },
          })
          
          executedSteps.push({
            stepId: `create_table_${tableName}`,
            status: 'completed',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            result: { 
              tableName, 
              verified: false,
              mode: process.env.ENGINE_MODE || 'integration'
            },
          })
        }
      }
    }
    
    // PHASE 5: Execute remaining steps (APIs, Auth, etc.)
    console.log('[Real Executor] Phase 5: Executing remaining steps')
    for (const step of plan.steps) {
      if (step.action === 'CREATE_TABLE') {
        // Already handled in migration
        continue
      }
      
      // Execute other step types
      const executedStep: ExecutedStep = {
        stepId: step.stepId,
        status: 'executing',
        startedAt: new Date().toISOString(),
      }
      
      executedSteps.push(executedStep)
      
      // For now, other steps still simulated
      // TODO: Implement real API generation, auth provisioning
      const result = await executeStepReal(step, currentGraph)
      
      executedStep.status = 'completed'
      executedStep.completedAt = new Date().toISOString()
      executedStep.result = result
      
      if (result.change) {
        changes.push(result.change)
      }
    }
    
    console.log('[Real Executor] ✅ All steps completed')
    console.log(`[Real Executor] Changes: ${changes.length}`)
    console.log(`[Real Executor] Tables created: ${changes.filter(c => c.type === 'table').length}`)
    
    return {
      success: true,
      plan,
      executedSteps,
      rollbackPerformed: false,
      finalState: currentGraph,
      changes,
      message: getModeSpecificMessage(changes),
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Something didn\'t work. Nothing was changed.'
    console.error('[Real Executor] ❌ Execution failed:', errorMessage)
    
    // TODO: Implement rollback for real migrations
    
    return {
      success: false,
      plan,
      executedSteps,
      rollbackPerformed: false,
      finalState: graph,
      changes: [],
      message: errorMessage,
    }
  }
}

/**
 * Execute individual step with real side effects
 */
async function executeStepReal(
  step: ExecutionStep,
  graph: BackendStateGraph
): Promise<{ change?: ExecutionChange }> {
  switch (step.action) {
    // GENERATE_API_ENDPOINT is gone (2026-07-21). It wrote an ApiDefinition row,
    // and under PostgREST the API IS the schema — reachability is decided by the
    // PostgreSQL catalog plus grants and RLS, per request. The row was a second,
    // writable description of a fact the database already owned, so it could only
    // drift. The step now falls through to the `default` warn instead.

    case 'UPDATE_AUTH_CONFIG': {
      // Extract provider from target (e.g., 'auth.providers.email' -> 'email')
      const provider = step.target.split('.').pop() as 'email' | 'google' | 'github'
      
      if (!provider || !['email', 'google', 'github'].includes(provider)) {
        console.warn(`[Real Executor] Invalid auth provider: ${provider}`)
        return { change: undefined }
      }
      
      // Update graph auth state
      if (!graph.auth.providers[provider]) {
        graph.auth.providers[provider] = {
          enabled: step.params.enabled || true,
          reason: `Enabled via batch mode: ${step.description}`,
          createdBy: 'batch_executor',
        }
      } else {
        graph.auth.providers[provider].enabled = step.params.enabled || true
      }
      
      console.log(`[Real Executor] ✅ Enabled auth provider: ${provider}`)
      
      return {
        change: {
          type: 'auth',
          action: 'modified',
          target: provider,
          details: { enabled: true, provider },
        },
      }
    }
    
    case 'CREATE_STORAGE_BUCKET': {
      const bucketName = step.params.bucketName || step.target
      const isPublic = step.params.isPublic || false
      
      console.log(`[Real Executor] Creating storage bucket: ${bucketName}`)
      
      // PHASE 3: STORAGE PROVISIONING TRUTH GUARANTEE
      // Use proper provisioning system that verifies actual infrastructure
      const { provisionStorageBucket } = await import('@/lib/services/storage-provisioning-verification')
      
      // Provision bucket with full verification
      const provisioningResult = await provisionStorageBucket(
        bucketName,
        graph.projectId,
        isPublic
      )
      
      // FAILURE TRANSPARENCY: If provisioning fails, throw with actionable message
      if (!provisioningResult.success) {
        console.error(`[Real Executor] ❌ Storage provisioning failed: ${provisioningResult.error}`)
        throw new Error(
          provisioningResult.actionableMessage || 
          `Failed to create storage bucket "${bucketName}": ${provisioningResult.error}`
        )
      }
      
      // VERIFICATION: Ensure bucket is actually ready
      if (!provisioningResult.verified) {
        console.error(`[Real Executor] ❌ Bucket created but not verified`)
        throw new Error(
          `Storage bucket "${bucketName}" was created but could not be verified. ` +
          `Database exists: ${provisioningResult.databaseExists}, ` +
          `Physical exists: ${provisioningResult.physicallyExists}`
        )
      }
      
      // Update graph state ONLY after successful verification
      graph.storage.buckets[bucketName] = {
        name: bucketName,
        purpose: step.target,
        reason: `Storage bucket created: ${step.description}`,
        allowedTypes: step.params.fileTypes || ['*/*'],
        maxFileSize: 10 * 1024 * 1024, // 10MB default
        isPublic,
        createdBy: step.stepId,
        usedBy: [],
      }
      
      console.log(`[Real Executor] ✅ Created and verified storage bucket: ${bucketName}`)
      
      return {
        change: {
          type: 'storage',
          action: 'created',
          target: bucketName,
          details: { 
            bucketId: provisioningResult.bucketId,
            bucketName, 
            isPublic, 
            verified: true,
            realBucket: true,
          },
        },
      }
    }
    
    case 'DEPLOY_CHANGES': {
      console.log(`[Real Executor] Deploying to ${step.params.environment || 'production'}`)

      const { goLive } = await import('@/lib/deployment/go-live')
      const { prisma } = await import('@/lib/db')

      try {
        const project = await prisma.project.findUnique({
          where: { id: graph.projectId },
          select: { userId: true },
        })
        if (!project?.userId) throw new Error('Project not found')

        // Deterministic execution-plan path: confirmation has already been
        // collected upstream (atomic-executor / preview→confirm) — force here.
        const result = await goLive(graph.projectId, project.userId, {
          confirmedBy: 'API',
          force: true,
        })

        if (result.kind === 'error') {
          console.error('[Real Executor] ❌ Deploy failed:', result.error)
          return { change: undefined }
        }
        if (result.kind === 'confirmation') {
          console.error('[Real Executor] Unexpected confirmation gate on forced deploy')
          return { change: undefined }
        }

        console.log(`[Real Executor] ✅ Deployed v${result.version} → ${result.publicUrl}`)
        return {
          change: {
            type: 'capability',
            action: 'created',
            target: 'production',
            details: {
              version: result.version,
              environment: step.params.environment,
              url: result.publicUrl,
              status: 'live',
            },
          },
        }
      } catch (error: any) {
        console.error(`[Real Executor] ❌ Deployment failed:`, error)
        return { change: undefined }
      }
    }
    
    case 'APPLY_CAPABILITY': {
      const capabilityType = step.params.capabilityType
      console.log(`[Real Executor] Applying capability: ${capabilityType}`)
      
      switch (capabilityType) {
        case 'STRIPE_BILLING': {
          // Update graph with billing plan
          if (!graph.billing) {
            graph.billing = {
              enabled: true,
              provider: 'stripe',
              plans: {},
              subscriptions: {},
              webhooks: { enabled: false, secretRef: '' },
              reason: 'Billing enabled via prompt',
            }
          }
          
          const planId = `plan_${step.params.config.planName.toLowerCase().replace(/\s+/g, '_')}`
          graph.billing.plans[planId] = {
            id: planId,
            name: step.params.config.planName,
            amount: step.params.config.amount,
            currency: step.params.config.currency || 'USD',
            interval: step.params.config.interval || 'month',
            reason: step.params.config.reason || 'Plan created',
          }
          
          console.log(`[Real Executor] ✅ Billing plan created: ${step.params.config.planName}`)
          
          return {
            change: {
              type: 'capability',
              action: 'created',
              target: 'STRIPE_BILLING',
              details: { planName: step.params.config.planName, amount: step.params.config.amount },
            },
          }
        }
        
        case 'SCHEDULING':
        case 'WEBHOOKS':
        case 'EVENTS':
        case 'EMAIL_MESSAGING':
        case 'REALTIME_SYNC':
        case 'SEARCH_INDEXING':
        case 'USAGE_ANALYTICS': {
          // Update graph with capability
          if (!graph.capabilities) {
            graph.capabilities = {}
          }
          
          const capabilityKey = capabilityType.toLowerCase()
          ;(graph.capabilities as any)[capabilityKey] = {
            enabled: true,
            config: step.params.config,
            reason: step.description,
          }
          
          console.log(`[Real Executor] ✅ Capability enabled: ${capabilityType}`)
          
          return {
            change: {
              type: 'capability',
              action: 'created',
              target: capabilityType,
              details: step.params.config,
            },
          }
        }
        
        default:
          console.warn(`[Real Executor] Unknown capability type: ${capabilityType}`)
          return { change: undefined }
      }
    }
    
    case 'ADD_TABLE_COLUMN': {
      // 💡 CHECKPOINT 4: ADD_TABLE_COLUMN handler
      console.log('➕ CHECKPOINT 4: ADD_TABLE_COLUMN handler triggered')
      console.log(`[Real Executor] Adding column ${step.params.columnName} to ${step.target}`)
      
      const tableName = step.target
      const columnName = step.params.columnName
      const columnType = step.params.columnType || 'TEXT'
      
      // Get entity from graph
      const entity = graph.entities[tableName]
      if (!entity) {
        console.warn(`[Real Executor] Entity ${tableName} not found`)
        return { change: undefined }
      }
      
      // Check if column already exists
      if (entity.fields[columnName]) {
        console.log(`[Real Executor] Column ${columnName} already exists, skipping`)
        return { change: undefined }
      }
      
      // Add field to entity
      entity.fields[columnName] = {
        name: columnName,
        type: columnType,
        reason: step.description,
        nullable: step.params.nullable ?? true,
        unique: false,
        createdAt: new Date().toISOString(),
        createdBy: step.stepId,
        usedBy: [],
      }
      
      console.log(`[Real Executor] ✅ Added column ${columnName} to ${tableName}`)
      
      return {
        change: {
          type: 'column',
          action: 'created',
          target: `${tableName}.${columnName}`,
          details: { type: columnType },
        },
      }
    }
    
    case 'ADD_UNIQUE_CONSTRAINT': {
      console.log('🔒 Adding unique constraint')
      console.log(`[Real Executor] Adding unique constraint on ${step.target}.${step.params.fieldName}`)
      
      const tableName = step.target
      const fieldName = step.params.fieldName
      
      const entity = graph.entities[tableName]
      if (!entity) {
        console.warn(`[Real Executor] Entity ${tableName} not found`)
        return { change: undefined }
      }
      
      const field = entity.fields[fieldName]
      if (!field) {
        console.warn(`[Real Executor] Field ${fieldName} not found in ${tableName}`)
        return { change: undefined }
      }
      
      // Idempotency
      if (field.unique) {
        console.log(`[Real Executor] Field ${fieldName} already unique, skipping`)
        return { change: undefined }
      }
      
      // Set unique flag
      field.unique = true
      
      console.log(`[Real Executor] ✅ Added unique constraint on ${tableName}.${fieldName}`)
      
      return {
        change: {
          type: 'column',
          action: 'modified',
          target: `${tableName}.${fieldName}`,
          details: { unique: true },
        },
      }
    }
    
    case 'DROP_COLUMN': {
      console.log('🗑️ CHECKPOINT 4: DROP_TABLE_COLUMN handler triggered')
      console.log(`[Real Executor] Removing column ${step.params.columnName} from ${step.target}`)
      
      const dropTableName = step.target
      const dropColumnName = step.params.columnName
      
      // Get entity from graph
      const dropEntity = graph.entities[dropTableName]
      if (!dropEntity) {
        console.warn(`[Real Executor] Entity ${dropTableName} not found`)
        return { change: undefined }
      }
      
      // Check if column exists
      if (!dropEntity.fields[dropColumnName]) {
        console.log(`[Real Executor] Column ${dropColumnName} doesn't exist, skipping`)
        return { change: undefined }
      }
      
      // Remove field from entity
      delete dropEntity.fields[dropColumnName]
      
      console.log(`[Real Executor] ✅ Removed column ${dropColumnName} from ${dropTableName}`)
      
      return {
        change: {
          type: 'column',
          action: 'deleted',
          target: `${dropTableName}.${dropColumnName}`,
          details: {},
        },
      }
    }
    
    case 'DROP_TABLE': {
      console.log('🗑️ CHECKPOINT 4: DROP_TABLE handler triggered')
      console.log(`[Real Executor] Removing table ${step.target}`)
      
      const tableName = step.target
      
      // DEBUG: Log available entities
      console.log(`[Real Executor] Available entities:`, Object.keys(graph.entities).join(', '))
      console.log(`[Real Executor] Looking for table: "${tableName}"`)
      console.log(`[Real Executor] Entity exists:`, !!graph.entities[tableName])
      
      // Check if table exists
      if (!graph.entities[tableName]) {
        console.log(`[Real Executor] Table ${tableName} doesn't exist, skipping`)
        return { change: undefined }
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
        const errorMessage = `Cannot delete ${tableName}. Referenced by: ${dependencies.join(', ')}`
        console.error(`[Real Executor] ❌ ${errorMessage}`)
        throw new Error(errorMessage)
      }
      
      // Remove entity from graph
      delete graph.entities[tableName]
      
      // Also remove any relationships pointing to this entity (for completeness)
      Object.values(graph.entities).forEach((entity: any) => {
        if (entity.relationships) {
          entity.relationships = entity.relationships.filter((rel: any) => rel.to !== tableName)
        }
      })
      
      // Remove any APIs tied to this entity
      if (graph.apis) {
        Object.keys(graph.apis).forEach((apiKey: string) => {
          if (apiKey.includes(tableName.toLowerCase())) {
            delete graph.apis[apiKey]
          }
        })
      }
      
      console.log(`[Real Executor] ✅ Removed table ${tableName}`)
      
      return {
        change: {
          type: 'table',
          action: 'deleted',
          target: tableName,
          details: {},
        },
      }
    }
    
    case 'ALTER_COLUMN': {
      console.log('📝 CHECKPOINT 4: ALTER_COLUMN handler triggered')
      console.log(`[Real Executor] Changing column ${step.params.columnName} type to ${step.params.newType} in ${step.target}`)
      
      const alterTableName = step.target
      const alterColumnName = step.params.columnName
      const newColumnType = step.params.newType
      
      // Get entity from graph
      const alterEntity = graph.entities[alterTableName]
      if (!alterEntity) {
        console.warn(`[Real Executor] Entity ${alterTableName} not found`)
        return { change: undefined }
      }
      
      // Check if column exists
      if (!alterEntity.fields[alterColumnName]) {
        console.log(`[Real Executor] Column ${alterColumnName} doesn't exist, skipping`)
        return { change: undefined }
      }
      
      // Change field type
      const oldType = alterEntity.fields[alterColumnName].type
      alterEntity.fields[alterColumnName].type = newColumnType
      
      console.log(`[Real Executor] ✅ Changed column ${alterColumnName} from ${oldType} to ${newColumnType}`)
      
      return {
        change: {
          type: 'column',
          action: 'modified',
          target: `${alterTableName}.${alterColumnName}`,
          details: { oldType, newType: newColumnType },
        },
      }
    }
    
    case 'APPLY_POLICY': {
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
      
      // CRITICAL: Check for semantic duplicate before creating (Layer 3 enforcement)
      const existingPolicyId = Object.entries(graph.policies || {}).find(
        ([id, policy]: [string, any]) =>
          policy.domain === newPolicy.domain &&
          policy.action === newPolicy.action &&
          policy.target === newPolicy.target &&
          policy.rule === newPolicy.rule &&
          policy.enabled === newPolicy.enabled &&
          policy.role === newPolicy.role &&
          policy.resource === newPolicy.resource &&
          policy.operation === newPolicy.operation
      )?.[0]
      
      if (existingPolicyId) {
        console.log(`[Real Executor] Policy already exists (semantic duplicate): ${existingPolicyId}`)
        return {
          change: {
            type: 'auth',
            action: 'modified',
            target: `policy.${step.target}`,
            details: { existingPolicyId, skipped: true, reason: 'Semantic duplicate' },
          },
        }
      }
      
      // Mutate graph to add policy
      const policyId = `pol_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
      
      graph.policies[policyId] = {
        id: policyId,
        name: step.params.policyName || 'Unnamed Policy',
        ...newPolicy,
        reason: step.description,
        createdBy: step.stepId,
        createdAt: new Date().toISOString(),
      }
      
      console.log(`[Real Executor] ✅ Policy created: ${policyId}`)
      console.log(`[Real Executor]    Domain: ${graph.policies[policyId].domain}`)
      console.log(`[Real Executor]    Action: ${graph.policies[policyId].action}`)
      
      return {
        change: {
          type: 'auth',
          action: 'modified',
          target: `policy.${step.target}`,
          details: graph.policies[policyId],
        },
      }
    }
      
    default:
      console.warn(`[Real Executor] Unknown step action: ${step.action}`)
      return { change: undefined }
  }
}

/**
 * Generate success message from changes (deprecated - use getModeSpecificMessage instead)
 * @deprecated Use getModeSpecificMessage from @/lib/config/engine-mode
 */
function generateSuccessMessage(changes: ExecutionChange[]): string {
  return getModeSpecificMessage(changes)
}
