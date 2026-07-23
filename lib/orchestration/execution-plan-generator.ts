/**
 * Phase 4: Deterministic Execution Plan Generator
 * 
 * Generates step-by-step execution plan BEFORE touching anything.
 * No improvisation. Plan must be identical every time.
 * 
 * This is closer to CI/CD than chat.
 */

import { CanonicalIntent } from './types'
import { BackendStateGraph } from './backend-state-graph'
import { detectCapability, parseCapabilityConfig, generateCapabilitySteps, validateCapabilityConfig } from '../capabilities/capability-orchestrator'

export interface ExecutionPlan {
  planId: string
  intentId: string
  steps: ExecutionStep[]
  estimatedDuration: number // seconds
  rollbackPlan: RollbackStep[]
  createdAt: string
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'rolled_back'
}

export interface ExecutionStep {
  stepId: string
  order: number
  action: StepAction
  target: string
  params: Record<string, any>
  description: string // Human-readable
  dependencies: string[] // Other step IDs
  reversible: boolean
  estimatedTime: number // seconds
}

export type StepAction =
  | 'CREATE_STORAGE_BUCKET'
  | 'ADD_TABLE_COLUMN'
  | 'CREATE_TABLE'
  | 'DROP_TABLE'
  | 'DROP_COLUMN'
  | 'ALTER_COLUMN'
  | 'ADD_UNIQUE_CONSTRAINT'
  | 'GENERATE_API_ENDPOINT'
  | 'UPDATE_AUTH_CONFIG'
  | 'APPLY_MIGRATION'
  | 'BACKFILL_DEFAULTS'
  | 'CREATE_SNAPSHOT'
  | 'UPDATE_SECURITY_RULES'
  | 'APPLY_POLICY'
  | 'APPLY_CAPABILITY'
  | 'DEPLOY_CHANGES'

export interface RollbackStep {
  stepId: string
  action: StepAction
  params: Record<string, any>
  description: string
}

/**
 * Generate deterministic execution plan from intent
 * 
 * CRITICAL: Same intent → same plan (always)
 */
export function generateExecutionPlan(
  intent: CanonicalIntent,
  graph: BackendStateGraph
): ExecutionPlan {
  const planId = generatePlanId(intent)
  const steps: ExecutionStep[] = []
  let stepOrder = 0

  // Always start with snapshot
  steps.push({
    stepId: `${planId}_snapshot`,
    order: stepOrder++,
    action: 'CREATE_SNAPSHOT',
    target: 'backend_state',
    params: {
      intentId: intent.timestamp,
      reason: intent.source_text,
    },
    description: 'Create rollback snapshot',
    dependencies: [],
    reversible: false,
    estimatedTime: 1,
  })

  // Generate steps based on intent type
  if (intent.intent_type === 'FEATURE_ADD') {
    if (intent.domain === 'STORAGE') {
      steps.push(...generateStorageSteps(intent, graph, planId, stepOrder))
    } else if (intent.domain === 'AUTH') {
      steps.push(...generateAuthSteps(intent, graph, planId, stepOrder))
    } else if (intent.domain === 'API') {
      steps.push(...generateApiSteps(intent, graph, planId, stepOrder))
    } else if (intent.domain === 'MONITORING') {
      steps.push(...generateMonitoringSteps(intent, graph, planId, stepOrder))
    }
  } else if (intent.intent_type === 'DATA_MODEL_ADD') {
    steps.push(...generateTableSteps(intent, graph, planId, stepOrder))
  } else if (intent.intent_type === 'DATA_MODEL_MODIFY') {
    steps.push(...generateTableModifySteps(intent, graph, planId, stepOrder))
  } else if (intent.intent_type === 'ACCESS_CONTROL') {
    // Check if this is a capability (payment policy, admin moderation, etc.)
    const capability = detectCapability(intent.source_text, intent.feature)
    
    if (capability && intent.constraints.isCapability) {
      steps.push(...generateCapabilityExecutionSteps(intent, graph, planId, stepOrder, capability))
    } else if (intent.constraints.isPolicy) {
      steps.push(...generatePolicySteps(intent, graph, planId, stepOrder))
    } else {
      steps.push(...generateAccessControlSteps(intent, graph, planId, stepOrder))
    }
  } else if (intent.intent_type === 'DEPLOYMENT') {
    steps.push(...generateDeploymentSteps(intent, graph, planId, stepOrder))
  } else if (intent.intent_type === 'INFRASTRUCTURE') {
    // Check if this is a capability (scheduled actions, webhooks, email, etc.)
    const capability = detectCapability(intent.source_text, intent.feature)
    
    if (capability && intent.constraints.isCapability) {
      steps.push(...generateCapabilityExecutionSteps(intent, graph, planId, stepOrder, capability))
    } else {
      steps.push(...generateInfrastructureSteps(intent, graph, planId, stepOrder))
    }
  } else if (intent.intent_type === 'INTEGRATION') {
    // Check if this is a capability (secrets & integrations)
    const capability = detectCapability(intent.source_text, intent.feature)
    
    if (capability && intent.constraints.isCapability) {
      steps.push(...generateCapabilityExecutionSteps(intent, graph, planId, stepOrder, capability))
    } else {
      steps.push(...generateIntegrationSteps(intent, graph, planId, stepOrder))
    }
  }

  // Fallback for weird prompts (Category 5)
  if (steps.length <= 1 && intent.confidence >= 0.5) {
     steps.push({
        stepId: `${planId}_generic_update`,
        order: stepOrder++,
        action: 'UPDATE_SECURITY_RULES',
        target: 'system.configuration',
        params: { intent: intent.feature || 'general_optimization' },
        description: `Apply architectural optimization: ${intent.source_text}`,
        dependencies: [`${planId}_snapshot`],
        reversible: true,
        estimatedTime: 1,
     })
  }

  // Generate rollback plan (reverse order)
  const rollbackPlan = generateRollbackPlan(steps)

  return {
    planId,
    intentId: intent.timestamp,
    steps,
    estimatedDuration: steps.reduce((sum, step) => sum + step.estimatedTime, 0),
    rollbackPlan,
    createdAt: new Date().toISOString(),
    status: 'pending',
  }
}

/**
 * Generate steps for file storage
 */
function generateStorageSteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  startOrder: number
): ExecutionStep[] {
  const steps: ExecutionStep[] = []
  let order = startOrder

  // Step 1: Create storage bucket
  const bucketStep: ExecutionStep = {
    stepId: `${planId}_create_bucket`,
    order: order++,
    action: 'CREATE_STORAGE_BUCKET',
    target: intent.target || 'general_uploads',
    params: {
      bucketName: intent.target ? `user_${intent.target}` : 'user_general_uploads',
      isPublic: intent.constraints.isPublic || false,
      maxFileSize: intent.constraints.maxSize || '10MB',
      allowedTypes: intent.constraints.fileTypes || ['*/*'],
      features: intent.constraints.features || {},
    },
    description: `Provision storage bucket for ${intent.target || 'general uploads'}`,
    dependencies: [],
    reversible: true,
    estimatedTime: 2,
  }
  steps.push(bucketStep)

  // Step 2: Add linkage to users/entities if applicable
  const needsLinkage = intent.target === 'profile_pictures' || intent.target === 'documents'
  let linkageStepId: string | null = null
  if (needsLinkage) {
    const targetTable = 'users'
    const tableExists = !!graph.entities[targetTable]
    
    // If table doesn't exist, create it first
    if (!tableExists) {
      const createTableStep: ExecutionStep = {
        stepId: `${planId}_create_linkage_table`,
        order: order++,
        action: 'CREATE_TABLE',
        target: targetTable,
        params: {
          columns: [
            { name: 'id', type: 'UUID', primaryKey: true },
            { name: 'email', type: 'TEXT', unique: true },
          ],
        },
        description: `Create ${targetTable} table for storage linkage`,
        dependencies: [],
        reversible: true,
        estimatedTime: 2,
      }
      steps.push(createTableStep)
    }

    const columnName = intent.target === 'profile_pictures' ? 'avatar_url' : 'document_urls'
    const columnStep: ExecutionStep = {
      stepId: `${planId}_add_linkage_column`,
      order: order++,
      action: 'ADD_TABLE_COLUMN',
      target: targetTable,
      params: {
        columnName,
        columnType: intent.target === 'profile_pictures' ? 'TEXT' : 'JSONB',
        nullable: true,
      },
      description: `Add ${columnName} to ${targetTable} for storage linkage`,
      dependencies: !tableExists ? [`${planId}_create_linkage_table`] : [bucketStep.stepId],
      reversible: true,
      estimatedTime: 3,
    }
    steps.push(columnStep)
    linkageStepId = columnStep.stepId
  }

  // Step 3: Add security rules for the bucket
  const securityStep: ExecutionStep = {
    stepId: `${planId}_bucket_security`,
    order: order++,
    action: 'UPDATE_SECURITY_RULES',
    target: `storage.buckets.${bucketStep.params.bucketName}`,
    params: {
      rule: 'owner_only',
      access: intent.constraints.isPublic ? 'public_read' : 'private',
    },
    description: `Attach ${intent.constraints.isPublic ? 'public' : 'owner-only'} access rules to bucket`,
    dependencies: [bucketStep.stepId],
    reversible: true,
    estimatedTime: 1,
  }
  steps.push(securityStep)

  // Step 4: Generate upload endpoint
  const apiStep: ExecutionStep = {
    stepId: `${planId}_generate_api`,
    order: order++,
    action: 'GENERATE_API_ENDPOINT',
    target: '/users/:id/avatar',
    params: {
      method: 'POST',
      requiresAuth: true,
      rateLimit: 10,
      storageTarget: intent.target ? `user_${intent.target}` : 'user_general_uploads',
    },
    description: 'Generate upload endpoint',
    dependencies: linkageStepId ? [linkageStepId] : [bucketStep.stepId],
    reversible: true,
    estimatedTime: 2,
  }
  steps.push(apiStep)

  // Step 4: Apply auth rules
  const authStep: ExecutionStep = {
    stepId: `${planId}_apply_auth`,
    order: order++,
    action: 'UPDATE_SECURITY_RULES',
    target: '/users/:id/avatar',
    params: {
      rule: 'user_owns_resource',
      check: 'params.id === user.id',
    },
    description: 'Apply auth rules',
    dependencies: [apiStep.stepId],
    reversible: true,
    estimatedTime: 1,
  }
  steps.push(authStep)

  // Step 5: Backfill defaults (optional)
  if (intent.constraints.backfillDefaults) {
    const backfillStep: ExecutionStep = {
      stepId: `${planId}_backfill`,
      order: order++,
      action: 'BACKFILL_DEFAULTS',
      target: 'users.avatar_url',
      params: {
        defaultValue: 'https://api.dicebear.com/7.x/avataaars/svg?seed={{user.id}}',
      },
      description: 'Backfill defaults',
      dependencies: linkageStepId ? [linkageStepId] : [bucketStep.stepId],
      reversible: false,
      estimatedTime: 5,
    }
    steps.push(backfillStep)
  }

  return steps
}

/**
 * Generate steps for auth changes
 */
function generateAuthSteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  startOrder: number
): ExecutionStep[] {
  const steps: ExecutionStep[] = []
  let order = startOrder

  const provider = intent.constraints.provider || 'email'

  // Step 0: Ensure users table exists
  if (!graph.entities['users']) {
    steps.push({
      stepId: `${planId}_create_users_table`,
      order: order++,
      action: 'CREATE_TABLE',
      target: 'users',
      params: {
        columns: [
          { name: 'id', type: 'UUID', primaryKey: true },
          { name: 'email', type: 'TEXT', unique: true },
          { name: 'createdAt', type: 'TIMESTAMP', default: 'now()' },
        ],
      },
      description: 'Create users table for authentication',
      dependencies: [],
      reversible: true,
      estimatedTime: 3,
    })
  }

  // Step 1: Update auth config
  steps.push({
    stepId: `${planId}_update_auth`,
    order: order++,
    action: 'UPDATE_AUTH_CONFIG',
    target: `auth.providers.${provider}`,
    params: {
      enabled: true,
      clientId: 'env.GOOGLE_CLIENT_ID',
      clientSecret: 'env.GOOGLE_CLIENT_SECRET',
      redirectUri: '/auth/callback/google',
    },
    description: `Enable ${provider} authentication`,
    dependencies: [],
    reversible: true,
    estimatedTime: 2,
  })

  // Step 2: Generate callback endpoint
  steps.push({
    stepId: `${planId}_generate_callback`,
    order: order++,
    action: 'GENERATE_API_ENDPOINT',
    target: `/auth/callback/${provider}`,
    params: {
      method: 'GET',
      handler: 'oauth_callback',
    },
    description: `Generate OAuth callback endpoint`,
    dependencies: [`${planId}_update_auth`],
    reversible: true,
    estimatedTime: 1,
  })

  return steps
}

/**
 * Generate steps for action-based API endpoints
 * 
 * CRITICAL: This creates APIDefinitions with custom endpoints from batch planner
 * NO CRUD generation - endpoints come from user intent derivation
 */
function generateApiSteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  startOrder: number
): ExecutionStep[] {
  const steps: ExecutionStep[] = []
  let order = startOrder

  const tableName = intent.target
  const customEndpoints = intent.constraints.customEndpoints || []
  const basePath = intent.constraints.basePath || `/${tableName}`

  console.log(`[API Steps] Generating API for ${tableName} with ${customEndpoints.length} endpoints`)

  // Generate API definition with custom endpoints
  steps.push({
    stepId: `${planId}_generate_api`,
    order: order++,
    action: 'GENERATE_API_ENDPOINT',
    target: tableName,
    params: {
      tableName,
      basePath,
      customEndpoints,
      operations: intent.constraints.operations || {
        list: false,
        get: false,
        create: false,
        update: false,
        delete: false,
        search: false,
        bulk: false,
      },
    },
    description: `Generate action-based API for ${tableName}`,
    dependencies: [],
    reversible: true,
    estimatedTime: 2,
  })

  return steps
}

/**
 * Generate steps for table creation
 */
function generateTableSteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  startOrder: number
): ExecutionStep[] {
  const steps: ExecutionStep[] = []
  let order = startOrder

  const tableName = intent.target || 'entity'

  // CRITICAL FIX: Use fields from intent.constraints.fields (from batch planner)
  // This was the bug causing field extraction to fail - fields were extracted but ignored!
  const userFields = intent.constraints.fields || []
  
  // 🔴 DEBUG: Log final entities before plan generation to catch semantic bridge override
  console.log("[FINAL ENTITIES BEFORE PLAN]", JSON.stringify({
    tableName,
    userFields: userFields.map((f: any) => ({ name: f.name, type: f.type })),
    source: {
      fromInference: Boolean((intent as any).metadata?.inference?.normalizedEntities?.length),
      fromSemanticBridge: !(intent as any).metadata?.inference?.normalizedEntities?.length
    }
  }, null, 2))
  
  // Convert field definitions to column definitions
  const userColumns = userFields.map((field: any) => {
    // Handle reference fields
    if (field.type === 'reference' && field.referenceTo) {
      // Use the field name as-is if provided (e.g., 'userId'), otherwise construct default (e.g., 'users_id')
      const columnName = field.name || `${field.referenceTo}_id`
      return {
        name: columnName,
        type: 'UUID',
        required: field.required ?? false,
        referenceTo: field.referenceTo,
      }
    }
    
    // Map semantic types to SQL types
    let sqlType = 'VARCHAR(255)' // Default
    switch (field.type) {
      case 'string':
      case 'email':
        sqlType = 'VARCHAR(255)'
        break
      case 'text':
        sqlType = 'TEXT'
        break
      case 'number':
        sqlType = 'INTEGER'
        break
      case 'boolean':
        sqlType = 'BOOLEAN'
        break
      case 'date':
        sqlType = 'DATE'
        break
      case 'datetime':
        sqlType = 'TIMESTAMP'
        break
      case 'url':
      case 'image':
        sqlType = 'VARCHAR(2048)'
        break
    }
    
    return {
      name: field.name,
      type: sqlType,
      required: field.required ?? false,
      unique: field.unique ?? false,
    }
  })
  
  // Always include id and timestamps
  const systemColumns = [
    { name: 'id', type: 'UUID', primaryKey: true },
    { name: 'createdAt', type: 'TIMESTAMP', default: 'now()' },
    { name: 'updatedAt', type: 'TIMESTAMP', default: 'now()' },
  ]
  
  // Merge system columns with user-defined columns
  const allColumns = [...systemColumns, ...userColumns]

  // Step 1: Create table with invariants
  steps.push({
    stepId: `${planId}_create_table`,
    order: order++,
    action: 'CREATE_TABLE',
    target: tableName,
    params: {
      columns: allColumns,
      // PRODUCTION-GRADE INVARIANTS: Pass ALL from intent constraints (1-15)
      uniqueConstraints: intent.constraints.uniqueConstraints,
      quotas: intent.constraints.quotas,
      ownership: intent.constraints.ownership,
      readIsolation: intent.constraints.readIsolation,
      softDelete: intent.constraints.softDelete,
      capacityLimits: intent.constraints.capacityLimits,
      stateMachine: intent.constraints.stateMachine,
      tierGating: intent.constraints.tierGating,
      conflictDetection: intent.constraints.conflictDetection,
      derivedFields: intent.constraints.derivedFields,
      sideEffects: intent.constraints.sideEffects,
      accessRules: intent.constraints.accessRules,
      storagePermissions: intent.constraints.storagePermissions,
    },
    description: `Create ${tableName} table with ${userColumns.length} custom fields`,
    dependencies: [],
    reversible: true,
    estimatedTime: 3,
  })

  // Step 2: Generate CRUD APIs
  steps.push({
    stepId: `${planId}_generate_crud`,
    order: order++,
    action: 'GENERATE_API_ENDPOINT',
    target: `/${tableName}`,
    params: {
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      requiresAuth: true,
    },
    description: `Generate CRUD APIs for ${tableName}`,
    dependencies: [`${planId}_create_table`],
    reversible: true,
    estimatedTime: 2,
  })

  return steps
}

/**
 * Generate steps for policies
 * 
 * CRITICAL: Ensures canonical execution plans by checking for existing policies
 */
function generatePolicySteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  startOrder: number
): ExecutionStep[] {
  const steps: ExecutionStep[] = []
  let order = startOrder

  // Build semantic policy representation
  const newPolicy = {
    domain: 'access',
    action: intent.action === 'RESTRICT' ? 'restrict' : 'allow',
    target: intent.target || 'system',
    rule: intent.source_text,
    enabled: true,
    role: intent.constraints.role,
    resource: intent.constraints.resource,
    operation: intent.constraints.operation,
  }

  // CRITICAL: Check if semantically identical policy already exists in graph
  const existingPolicy = Object.values(graph.policies || {}).find(
    (policy: any) =>
      policy.domain === newPolicy.domain &&
      policy.action === newPolicy.action &&
      policy.target === newPolicy.target &&
      policy.rule === newPolicy.rule &&
      policy.enabled === newPolicy.enabled &&
      policy.role === newPolicy.role &&
      policy.resource === newPolicy.resource &&
      policy.operation === newPolicy.operation
  )

  if (existingPolicy) {
    // Policy already exists - return empty steps (canonical planning)
    return steps
  }

  // If policy mentions a resource that doesn't exist, create it
  if (intent.constraints.resource && !graph.entities[intent.constraints.resource]) {
    steps.push({
      stepId: `${planId}_create_policy_resource`,
      order: order++,
      action: 'CREATE_TABLE',
      target: intent.constraints.resource,
      params: {
        columns: [
          { name: 'id', type: 'UUID', primaryKey: true },
          { name: 'createdAt', type: 'TIMESTAMP', default: 'now()' },
        ],
      },
      description: `Auto-create ${intent.constraints.resource} for policy enforcement`,
      dependencies: [],
      reversible: true,
      estimatedTime: 2,
    })
  }

  steps.push({
    stepId: `${planId}_apply_policy`,
    order: order++,
    action: 'APPLY_POLICY',
    target: intent.target || 'system',
    params: {
      policyName: intent.feature,
      domain: 'access', // Use 'access' domain for RBAC policies
      action: intent.action === 'RESTRICT' ? 'restrict' : 'allow',
      rule: intent.source_text,
      enabled: true,
      role: intent.constraints.role,
      resource: intent.constraints.resource,
      operation: intent.constraints.operation,
    },
    description: `Apply first-class policy: ${intent.source_text}`,
    dependencies: steps.length > 0 ? [steps[steps.length - 1].stepId] : [],
    reversible: true,
    estimatedTime: 1,
  })

  return steps
}

/**
 * Generate steps for access control
 */
function generateAccessControlSteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  startOrder: number
): ExecutionStep[] {
  const steps: ExecutionStep[] = []
  let order = startOrder

  steps.push({
    stepId: `${planId}_update_access`,
    order: order++,
    action: 'UPDATE_SECURITY_RULES',
    target: 'api.global',
    params: {
      requiresAuth: intent.action === 'RESTRICT',
      condition: intent.constraints.condition,
    },
    description: intent.action === 'RESTRICT' 
      ? 'Restrict access to paid users'
      : 'Allow public access',
    dependencies: [],
    reversible: true,
    estimatedTime: 1,
  })

  return steps
}

/**
 * Generate steps for deployment
 * 
 * INVARIANT:
 * Deployment steps must never mutate BackendStateGraph.
 * They only read canonical state and publish to provider.
 * Use lib/deployment/atomic-deployment-executor.ts for actual deployment.
 */
/**
 * Generate steps for infrastructure and capabilities
 */
function generateInfrastructureSteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  startOrder: number
): ExecutionStep[] {
  const steps: ExecutionStep[] = []
  let order = startOrder

  if (intent.constraints.isCapability) {
    const isScheduling = intent.feature === 'SCHEDULING'
    
    if (isScheduling) {
      const jobName = 'general_task'
      const jobExists = Object.values(graph.jobs).some(j => j.name === jobName)
      
      let jobStepId: string | null = null
      if (!jobExists) {
        const jobStep: ExecutionStep = {
          stepId: `${planId}_create_background_job`,
          order: order++,
          action: 'APPLY_CAPABILITY',
          target: 'BACKGROUND_JOBS',
          params: {
            capabilityType: 'BACKGROUND_JOBS',
            config: {
              name: jobName,
              trigger: 'schedule',
              handler: `process_${intent.target || 'cleanup'}`,
              reason: `Automatic job creation for schedule: ${intent.source_text}`,
            }
          },
          description: `Create background job for schedule: ${jobName}`,
          dependencies: [],
          reversible: true,
          estimatedTime: 2,
        }
        steps.push(jobStep)
        jobStepId = jobStep.stepId
      }

      steps.push({
        stepId: `${planId}_apply_capability`,
        order: order++,
        action: 'APPLY_CAPABILITY',
        target: intent.feature || 'system',
        params: {
          capabilityType: intent.feature,
          config: {
            jobRef: jobName,
            cron: intent.constraints.cron,
            name: `Schedule_${intent.target}`,
            reason: intent.source_text,
          },
        },
        description: `Apply platform capability: ${intent.feature} for ${intent.target || 'general task'}`,
        dependencies: jobStepId ? [jobStepId] : [],
        reversible: true,
        estimatedTime: 2,
      })
    } else {
      steps.push({
        stepId: `${planId}_apply_capability`,
        order: order++,
        action: 'APPLY_CAPABILITY',
        target: intent.feature || 'system',
        params: {
          capabilityType: intent.feature,
          config: {
            name: intent.target,
            trigger: intent.constraints.trigger,
            handler: `process_${intent.target || 'task'}`,
            reason: intent.source_text,
          },
        },
        description: `Apply platform capability: ${intent.feature} for ${intent.target || 'general task'}`,
        dependencies: [],
        reversible: true,
        estimatedTime: 2,
      })
    }
  }

  return steps
}

/**
 * Generate steps for integrations
 */
function generateIntegrationSteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  startOrder: number
): ExecutionStep[] {
  const steps: ExecutionStep[] = []
  let order = startOrder

  if (intent.feature === 'WEBHOOKS') {
    // 1. Register Webhook
    const webhookStep: ExecutionStep = {
      stepId: `${planId}_register_webhook`,
      order: order++,
      action: 'APPLY_CAPABILITY',
      target: 'webhooks',
      params: {
        capabilityType: 'WEBHOOKS',
        config: {
          name: intent.constraints.subscriber,
          url: intent.constraints.url,
          reason: intent.source_text,
        }
      },
      description: `Register webhook for ${intent.constraints.subscriber}`,
      dependencies: [],
      reversible: true,
      estimatedTime: 2,
    }
    steps.push(webhookStep)

    // 2. Register/Update Event with subscriber
    steps.push({
      stepId: `${planId}_subscribe_to_event`,
      order: order++,
      action: 'APPLY_CAPABILITY',
      target: 'events',
      params: {
        capabilityType: 'EVENTS',
        config: {
          name: intent.constraints.eventName,
          subscribers: [intent.constraints.subscriber],
          reason: `Subscribe ${intent.constraints.subscriber} to ${intent.constraints.eventName}`,
        }
      },
      description: `Subscribe ${intent.constraints.subscriber} to ${intent.constraints.eventName}`,
      dependencies: [webhookStep.stepId],
      reversible: true,
      estimatedTime: 1,
    })
  } else if (intent.feature === 'EVENTS') {
    steps.push({
      stepId: `${planId}_register_event`,
      order: order++,
      action: 'APPLY_CAPABILITY',
      target: 'events',
      params: {
        capabilityType: 'EVENTS',
        config: {
          name: intent.target,
          reason: intent.source_text,
        }
      },
      description: `Register system event: ${intent.target}`,
      dependencies: [],
      reversible: true,
      estimatedTime: 1,
    })
  } else if (intent.feature === 'EMAIL_MESSAGING') {
    steps.push({
      stepId: `${planId}_enable_email`,
      order: order++,
      action: 'APPLY_CAPABILITY',
      target: 'notifications',
      params: {
        capabilityType: 'EMAIL_MESSAGING',
        config: {
          templateName: intent.constraints.templateName,
          triggerEvent: intent.constraints.triggerEvent,
          reason: intent.source_text,
        }
      },
      description: `Enable email template: ${intent.constraints.templateName}`,
      dependencies: [],
      reversible: true,
      estimatedTime: 2,
    })
  } else if (intent.feature === 'STRIPE_BILLING') {
    steps.push({
      stepId: `${planId}_enable_billing`,
      order: order++,
      action: 'APPLY_CAPABILITY',
      target: 'billing',
      params: {
        capabilityType: 'STRIPE_BILLING',
        config: {
          planName: intent.constraints.planName,
          amount: intent.constraints.amount,
          currency: intent.constraints.currency,
          interval: intent.constraints.interval,
          reason: intent.source_text,
        }
      },
      description: `Enable Stripe billing: ${intent.constraints.planName}`,
      dependencies: [],
      reversible: true,
      estimatedTime: 5,
    })
  } else if (intent.feature === 'REALTIME_SYNC') {
    steps.push({
      stepId: `${planId}_enable_realtime`,
      order: order++,
      action: 'APPLY_CAPABILITY',
      target: 'realtime',
      params: {
        capabilityType: 'REALTIME_SYNC',
        config: {
          channelName: intent.constraints.channelName,
          permissions: intent.constraints.permissions,
          reason: intent.source_text,
        }
      },
      description: `Enable realtime channel: ${intent.constraints.channelName}`,
      dependencies: [],
      reversible: true,
      estimatedTime: 3,
    })
  } else if (intent.feature === 'SEARCH_INDEXING') {
    steps.push({
      stepId: `${planId}_enable_search`,
      order: order++,
      action: 'APPLY_CAPABILITY',
      target: 'search',
      params: {
        capabilityType: 'SEARCH_INDEXING',
        config: {
          entity: intent.constraints.entity,
          reason: intent.source_text,
        }
      },
      description: `Enable search indexing for: ${intent.constraints.entity}`,
      dependencies: [],
      reversible: true,
      estimatedTime: 5,
    })
  } else if (intent.feature === 'USAGE_ANALYTICS') {
    steps.push({
      stepId: `${planId}_enable_analytics`,
      order: order++,
      action: 'APPLY_CAPABILITY',
      target: 'analytics',
      params: {
        capabilityType: 'USAGE_ANALYTICS',
        config: {
          metric: intent.constraints.metric,
          retention: intent.constraints.retention,
          reason: intent.source_text,
        }
      },
      description: `Enable analytics tracking for: ${intent.constraints.metric}`,
      dependencies: [],
      reversible: true,
      estimatedTime: 2,
    })
  }

  return steps
}

/**
 * Generate steps for deployment
 */
function generateDeploymentSteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  startOrder: number
): ExecutionStep[] {
  return [{
    stepId: `${planId}_deploy`,
    order: startOrder,
    action: 'DEPLOY_CHANGES',
    target: 'production',
    params: {
      environment: intent.constraints.environment || 'production',
      strategy: intent.constraints.strategy || 'rolling',
    },
    description: 'Deploy to production',
    dependencies: [],
    reversible: false,
    estimatedTime: 30,
  }]
}

/**
 * Generate steps for monitoring
 */
function generateMonitoringSteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  startOrder: number
): ExecutionStep[] {
  return [{
    stepId: `${planId}_enable_monitoring`,
    order: startOrder,
    action: 'UPDATE_SECURITY_RULES',
    target: 'monitoring.config',
    params: { enabled: true, tracking: ['errors', 'latency', 'usage'] },
    description: 'Enable system health monitoring',
    dependencies: [],
    reversible: true,
    estimatedTime: 1,
  }]
}

/**
 * Generate steps for modifying tables
 */
function generateTableModifySteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  startOrder: number
): ExecutionStep[] {
  const steps: ExecutionStep[] = []
  let order = startOrder
  const tableName = intent.target || 'entity'
  
  // Step 0: Ensure table exists
  if (!graph.entities[tableName] && intent.action !== 'DELETE') {
    steps.push({
      stepId: `${planId}_create_missing_table`,
      order: order++,
      action: 'CREATE_TABLE',
      target: tableName,
      params: {
        columns: [
          { name: 'id', type: 'UUID', primaryKey: true },
          { name: 'createdAt', type: 'TIMESTAMP', default: 'now()' },
        ],
      },
      description: `Create missing table ${tableName} for schema update`,
      dependencies: [],
      reversible: true,
      estimatedTime: 2,
    })
  }

  if (intent.action === 'DELETE') {
    steps.push({
      stepId: `${planId}_drop_table`,
      order: order++,
      action: 'DROP_TABLE',
      target: tableName,
      params: { cascade: true },
      description: `Drop ${tableName} table`,
      dependencies: [],
      reversible: true,
      estimatedTime: 2,
    })
    return steps
  }
  
  // Add specified fields or default updatedAt
  const fields = intent.constraints.fields || ['updatedAt']
  fields.forEach((field: string) => {
    steps.push({
      stepId: `${planId}_add_col_${field}`,
      order: order++,
      action: 'ADD_TABLE_COLUMN',
      target: tableName,
      params: { 
        columnName: field, 
        columnType: field.toLowerCase().includes('count') ? 'INTEGER' : 'TEXT',
        nullable: true 
      },
      description: `Add ${field} to ${tableName}`,
      dependencies: steps.length > 0 ? [steps[steps.length - 1].stepId] : [],
      reversible: true,
      estimatedTime: 1,
    })
  })

  return steps
}

/**
 * Generate rollback plan (reverse execution)
 */
function generateRollbackPlan(steps: ExecutionStep[]): RollbackStep[] {
  return steps
    .filter(step => step.reversible)
    .reverse()
    .map(step => ({
      stepId: `rollback_${step.stepId}`,
      action: getReverseAction(step.action),
      params: step.params,
      description: `Undo: ${step.description}`,
    }))
}

/**
 * Generate capability-specific execution steps
 * Maps to the 10 core capabilities
 */
function generateCapabilityExecutionSteps(
  intent: CanonicalIntent,
  graph: BackendStateGraph,
  planId: string,
  order: number,
  capabilityType: any
): ExecutionStep[] {
  const steps: ExecutionStep[] = []
  
  // Parse capability configuration
  const config = parseCapabilityConfig(capabilityType, intent.source_text)
  
  if (!config) {
    console.error(`[Execution Plan] Failed to parse capability config for ${capabilityType}`)
    return steps
  }
  
  // Validate configuration
  const validation = validateCapabilityConfig(capabilityType, config)
  if (!validation.valid) {
    console.error(`[Execution Plan] Invalid capability config:`, validation.errors)
    return steps
  }
  
  // Generate capability-specific steps
  const capabilitySteps = generateCapabilitySteps(capabilityType, config)
  
  for (const capStep of capabilitySteps) {
    steps.push({
      stepId: `${planId}_${capStep.step.toLowerCase()}`,
      order: order++,
      action: 'APPLY_CAPABILITY',
      target: capabilityType,
      params: {
        capabilityType,
        capabilityStep: capStep.step,
        config,
        userMessage: intent.source_text,
      },
      description: capStep.description,
      dependencies: steps.length > 0 ? [steps[steps.length - 1].stepId] : [`${planId}_snapshot`],
      reversible: true,
      estimatedTime: 2,
    })
  }
  
  return steps
}

/**
 * Get reverse action for rollback
 */
function getReverseAction(action: StepAction): StepAction {
  const reverseMap: Record<StepAction, StepAction> = {
    CREATE_STORAGE_BUCKET: 'DROP_TABLE', // Delete bucket
    ADD_TABLE_COLUMN: 'DROP_COLUMN',
    ALTER_COLUMN: 'ALTER_COLUMN', // Self-inverse
    ADD_UNIQUE_CONSTRAINT: 'ADD_UNIQUE_CONSTRAINT', // Remove unique constraint
    CREATE_TABLE: 'DROP_TABLE',
    DROP_TABLE: 'CREATE_TABLE',
    DROP_COLUMN: 'ADD_TABLE_COLUMN',
    GENERATE_API_ENDPOINT: 'DROP_TABLE', // Remove endpoint
    UPDATE_AUTH_CONFIG: 'UPDATE_AUTH_CONFIG', // Revert config
    APPLY_MIGRATION: 'APPLY_MIGRATION', // Rollback migration
    BACKFILL_DEFAULTS: 'BACKFILL_DEFAULTS', // Not reversible
    CREATE_SNAPSHOT: 'CREATE_SNAPSHOT', // Not reversible
    UPDATE_SECURITY_RULES: 'UPDATE_SECURITY_RULES', // Revert rules
    APPLY_POLICY: 'APPLY_POLICY', // Revert policy
    APPLY_CAPABILITY: 'APPLY_CAPABILITY', // Revert capability
    DEPLOY_CHANGES: 'DEPLOY_CHANGES', // Redeploy previous
  }
  
  return reverseMap[action] || action
}

/**
 * Generate deterministic plan ID
 */
function generatePlanId(intent: CanonicalIntent): string {
  // Create stable hash from intent properties
  const hash = `${intent.intent_type}_${intent.domain}_${intent.action}_${intent.timestamp.slice(0, 13)}`
  return hash.replace(/[^a-z0-9_]/gi, '_').toLowerCase()
}

/**
 * Validate plan completeness
 */
export function validatePlan(plan: ExecutionPlan): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (plan.steps.length === 0) {
    errors.push('Plan has no steps')
  }

  // Check for circular dependencies
  const visited = new Set<string>()
  const checkCircular = (stepId: string, path: Set<string>) => {
    if (path.has(stepId)) {
      errors.push(`Circular dependency detected: ${stepId}`)
      return
    }
    if (visited.has(stepId)) return

    visited.add(stepId)
    path.add(stepId)

    const step = plan.steps.find(s => s.stepId === stepId)
    if (step) {
      step.dependencies.forEach(depId => checkCircular(depId, new Set(path)))
    }
  }

  plan.steps.forEach(step => checkCircular(step.stepId, new Set()))

  return {
    valid: errors.length === 0,
    errors,
  }
}
