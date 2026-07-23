/**
 * Phase 2: Backend State Graph
 * 
 * A living, reason-annotated model of the backend state.
 * Stores WHAT exists and WHY it exists.
 * 
 * This is Backenly's architectural moat - context-aware mutations.
 * 
 * INVARIANT:
 * The deployment.deploymentHistory field is DEPRECATED and should not be used.
 * Deployment must never mutate BackendStateGraph.
 * Use lib/deployment/deployment-record.ts for deployment tracking.
 */

export interface BackendStateGraph {
  projectId: string
  version: number
  lastUpdated: string
  entities: Record<string, EntityState>
  auth: AuthState
  storage: StorageState
  apis: Record<string, ApiState>
  policies: Record<string, PolicyState>
  jobs: Record<string, JobState>
  schedules: Record<string, ScheduleState>
  events: Record<string, EventState>
  webhooks: Record<string, WebhookState>
  notifications: NotificationState
  billing: BillingState
  realtime: RealtimeState
  search: SearchState
  analytics: AnalyticsState
  capabilities: Record<string, CapabilityState>
  integrations: IntegrationState[]
  deployment: DeploymentState
  lineageHash: string
  // BLACK-BOX TEST REQUIREMENT: Read-only capability ledger for state-based verification
  capabilityLedger?: CapabilityLedger
}

export interface EntityState {
  name: string
  reason: string // Why this entity exists
  fields: Record<string, FieldState>
  relationships: RelationshipState[]
  createdAt: string
  createdBy: string // Intent ID that created it
  dependencies: string[] // What depends on this
  // PRODUCTION-GRADE INVARIANTS (1-5)
  uniqueConstraints?: Array<{
    fields: string[] // Compound unique constraint (e.g., ['idea_id', 'user_id'])
    reason: string // Human explanation (e.g., 'One vote per user per idea')
  }>
  quotas?: Array<{
    tier: string // 'free' | 'paid'
    limit: number // Max count (-1 = unlimited)
    action: 'create' // What action is limited
    reason: string // Human explanation
  }>
  ownership?: {
    enabled: boolean
    field: string // Field name for owner (e.g., 'created_by', 'user_id')
    writeProtection: boolean // Only owner can edit/delete
  }
  readIsolation?: {
    enabled: boolean
    field: string // Field to filter by (e.g., 'created_by')
    reason: string // Human explanation
  }
  softDelete?: {
    enabled: boolean
    anonymizeFields?: string[] // Fields to anonymize (e.g., ['name', 'email'])
    replacement: string // What to show (e.g., 'Deleted User')
  }
  // PRODUCTION-GRADE INVARIANTS (6-15)
  capacityLimits?: {
    enabled: boolean
    field: string
    checkField?: string
    onExceeded: 'block' | 'waitlist'
    reason: string
  }
  stateMachine?: {
    enabled: boolean
    field: string
    states: Array<{
      name: string
      allowedTransitions: string[]
      isTerminal?: boolean
    }>
    reason: string
  }
  tierGating?: Array<{
    tier: string
    allowedOperations: ('read' | 'write')[]
    blockedFields?: string[]
    reason: string
  }>
  conflictDetection?: {
    enabled: boolean
    type: 'time_overlap' | 'range_overlap'
    fields: string[]
    scope?: string
    reason: string
  }
  derivedFields?: Array<{
    name: string
    sourceEntity: string
    aggregation: 'count' | 'sum' | 'avg'
    condition?: string
    reason: string
  }>
  sideEffects?: Array<{
    trigger: 'create' | 'update' | 'delete'
    targetEntity: string
    targetField: string
    operation: 'increment' | 'decrement' | 'set'
    value?: number | string
    condition?: string
    preventSelfAction?: boolean
    reason: string
  }>
  accessRules?: Array<{
    operation: 'read' | 'write' | 'delete'
    requires: 'ownership' | 'enrollment' | 'permission'
    field?: string
    reason: string
  }>
  storagePermissions?: {
    enabled: boolean
    ownershipField: string
    sharedWith?: string
    deleteRequiresOwnership: boolean
    reason: string
  }
}

export interface FieldState {
  name: string
  type: string
  reason: string // Why this field exists
  nullable: boolean
  unique: boolean
  default?: any
  createdAt: string
  createdBy: string // Intent ID
  usedBy: string[] // Features that use this field
}

export interface RelationshipState {
  from: string
  to: string
  type: 'one-to-one' | 'one-to-many' | 'many-to-many'
  reason: string
  foreignKey?: string
  createdBy: string
}

export interface AuthState {
  providers: {
    google?: { enabled: boolean; reason: string; createdBy: string }
    github?: { enabled: boolean; reason: string; createdBy: string }
    email?: { enabled: boolean; reason: string; createdBy: string }
  }
  sessionConfig: {
    duration: string
    refresh: boolean
    reason: string
  }
  requirements: {
    requireAuth: boolean
    publicRoutes: string[]
    reason: string
  }
}

export interface StorageState {
  buckets: Record<string, BucketState>
  totalUsage: number
  quotaLimit: number
}

export interface BucketState {
  name: string
  purpose: string // "profile_pictures", "documents", etc.
  reason: string // Why this bucket exists
  allowedTypes: string[]
  maxFileSize: number
  isPublic: boolean
  createdBy: string
  usedBy: string[] // Entities/features that use this
}

export interface ApiState {
  path: string
  methods: string[]
  requiresAuth: boolean
  rateLimit: number
  reason: string
  createdBy: string
  dependsOn: string[] // Entities/fields it needs
}

export interface PolicyState {
  id: string
  name: string
  domain: 'auth' | 'data' | 'access' | 'system'
  action: 'enforce' | 'log' | 'track' | 'restrict' | 'allow'
  target: string
  rule: string
  reason: string
  createdBy: string
  createdAt: string
  enabled: boolean
  role?: string        // For RBAC policies
  resource?: string    // For RBAC policies
  operation?: string   // For RBAC policies
}

export interface JobState {
  id: string
  name: string
  trigger: 'event' | 'schedule' | 'manual'
  handler: string // Action or target to run
  retryPolicy: {
    maxRetries: number
    backoff: 'fixed' | 'exponential'
  }
  visibility: 'private' | 'internal'
  reason: string
  createdBy: string
  createdAt: string
  enabled: boolean
}

export interface ScheduleState {
  id: string
  name: string
  jobRef: string // ID of the job to run
  cron: string
  timezone: string
  reason: string
  createdBy: string
  createdAt: string
  enabled: boolean
}

export interface EventState {
  id: string
  name: string // e.g. "user.created"
  subscribers: string[] // IDs of webhooks or other handlers
  reason: string
  createdBy: string
  createdAt: string
}

export interface WebhookState {
  id: string
  name: string
  url: string
  auth?: {
    type: 'header' | 'bearer' | 'basic'
    secretRef: string  // ONLY env var reference, NEVER raw secret
  }
  retries: number
  reason: string
  createdBy: string
  createdAt: string
  enabled: boolean
}

export interface NotificationState {
  email: {
    enabled: boolean
    provider: string
    templates: Record<string, EmailTemplate>
    reason: string
  }
}

export interface EmailTemplate {
  id: string
  name: string
  subject: string
  body: string
  triggerEvent: string
  reason: string
}

export interface BillingState {
  enabled: boolean
  provider: 'stripe'
  plans: Record<string, BillingPlan>
  subscriptions: Record<string, any>
  webhooks: {
    enabled: boolean
    secretRef: string
  }
  reason: string
}

export interface BillingPlan {
  id: string
  name: string
  amount: number
  currency: string
  interval: 'month' | 'year'
  reason: string
}

export interface RealtimeState {
  enabled: boolean
  channels: Record<string, RealtimeChannel>
  reason: string
}

export interface RealtimeChannel {
  id: string
  name: string
  permissions: 'public' | 'private' | 'protected'
  reason: string
}

export interface SearchState {
  enabled: boolean
  indexedEntities: string[]
  reason: string
}

export interface AnalyticsState {
  enabled: boolean
  metrics: string[]
  retention: string
  reason: string
}

export interface CapabilityState {
  id: string
  type: string
  config: any
  reason: string
  createdBy: string
  createdAt: string
  status: 'active' | 'inactive' | 'error'
}

export interface IntegrationState {
  type: 'email' | 'webhook' | 'cron' | 'queue'
  config: any
  reason: string
  createdBy: string
}

/**
 * BLACK-BOX TEST REQUIREMENT: Capability Ledger
 * Read-only record of which capabilities are active
 * Enables state-based test verification instead of log inference
 */
export interface CapabilityLedger {
  OPENAI: { status: 'ENABLED' | 'DISABLED'; grantedAt?: string; prompt?: string }
  EMAIL: { status: 'ENABLED' | 'DISABLED'; grantedAt?: string; prompt?: string }
  PAYMENTS: { status: 'ENABLED' | 'DISABLED'; grantedAt?: string; prompt?: string }
  SMS: { status: 'ENABLED' | 'DISABLED'; grantedAt?: string; prompt?: string }
  WEBHOOKS: { status: 'ENABLED' | 'DISABLED'; grantedAt?: string; prompt?: string }
  ANALYTICS: { status: 'ENABLED' | 'DISABLED'; grantedAt?: string; prompt?: string }
}

export interface DeploymentState {
  environment: 'development' | 'staging' | 'production'
  lastDeployedAt?: string
  lastDeployedBy?: string
  deploymentHistory: {
    timestamp: string
    intentId: string
    changes: string[]
  }[]
}

/**
 * Initialize empty state graph
 */
export function createEmptyGraph(projectId: string): BackendStateGraph {
  return {
    projectId,
    version: 1,
    lastUpdated: new Date().toISOString(),
    entities: {},
    auth: {
      providers: {},
      sessionConfig: {
        duration: '7d',
        refresh: true,
        reason: 'default_configuration',
      },
      requirements: {
        requireAuth: true,
        publicRoutes: [],
        reason: 'secure_by_default',
      },
    },
    storage: {
      buckets: {},
      totalUsage: 0,
      quotaLimit: 10737418240, // 10GB
    },
    apis: {},
    policies: {},
    jobs: {},
    schedules: {},
    events: {},
    webhooks: {},
    notifications: {
      email: {
        enabled: false,
        provider: 'system_default',
        templates: {},
        reason: 'initial_state',
      }
    },
    billing: {
      enabled: false,
      provider: 'stripe',
      plans: {},
      subscriptions: {},
      webhooks: {
        enabled: false,
        secretRef: 'env.STRIPE_WEBHOOK_SECRET',
      },
      reason: 'initial_state',
    },
    realtime: {
      enabled: false,
      channels: {},
      reason: 'initial_state',
    },
    search: {
      enabled: false,
      indexedEntities: [],
      reason: 'initial_state',
    },
    analytics: {
      enabled: false,
      metrics: [],
      retention: '30d',
      reason: 'initial_state',
    },
    capabilities: {},
    integrations: [],
    deployment: {
      environment: 'development',
      deploymentHistory: [],
    },
    lineageHash: 'genesis',
  }
}

/**
 * Add entity to graph with reason
 */
export function addEntity(
  graph: BackendStateGraph,
  name: string,
  reason: string,
  intentId: string
): BackendStateGraph {
  return {
    ...graph,
    entities: {
      ...graph.entities,
      [name]: {
        name,
        reason,
        fields: {},
        relationships: [],
        createdAt: new Date().toISOString(),
        createdBy: intentId,
        dependencies: [],
      },
    },
    version: graph.version + 1,
    lastUpdated: new Date().toISOString(),
  }
}

/**
 * Add field to entity with reason
 */
export function addField(
  graph: BackendStateGraph,
  entityName: string,
  fieldName: string,
  fieldType: string,
  reason: string,
  intentId: string
): BackendStateGraph {
  const entity = graph.entities[entityName]
  if (!entity) {
    throw new Error(`Entity ${entityName} not found`)
  }

  return {
    ...graph,
    entities: {
      ...graph.entities,
      [entityName]: {
        ...entity,
        fields: {
          ...entity.fields,
          [fieldName]: {
            name: fieldName,
            type: fieldType,
            reason,
            nullable: true,
            unique: false,
            createdAt: new Date().toISOString(),
            createdBy: intentId,
            usedBy: [],
          },
        },
      },
    },
    version: graph.version + 1,
    lastUpdated: new Date().toISOString(),
  }
}

/**
 * Remove entity and cascade dependencies
 */
export function removeEntity(
  graph: BackendStateGraph,
  entityName: string
): {
  graph: BackendStateGraph
  affected: string[] // What else was removed/modified
} {
  const entity = graph.entities[entityName]
  if (!entity) {
    return { graph, affected: [] }
  }

  const affected: string[] = []

  // Find all fields used by this entity
  Object.keys(entity.fields).forEach((fieldName) => {
    affected.push(`${entityName}.${fieldName}`)
  })

  // Find APIs that depend on this entity
  Object.entries(graph.apis).forEach(([path, api]) => {
    if (api.dependsOn.includes(entityName)) {
      affected.push(`API: ${path}`)
    }
  })

  // Find storage buckets used by this entity
  Object.entries(graph.storage.buckets).forEach(([bucketName, bucket]) => {
    if (bucket.usedBy.includes(entityName)) {
      affected.push(`Storage: ${bucketName}`)
    }
  })

  // Remove entity
  const newEntities = { ...graph.entities }
  delete newEntities[entityName]

  return {
    graph: {
      ...graph,
      entities: newEntities,
      version: graph.version + 1,
      lastUpdated: new Date().toISOString(),
    },
    affected,
  }
}

/**
 * Find why something exists
 */
export function findReason(
  graph: BackendStateGraph,
  target: string
): string | null {
  // Check entities
  if (graph.entities[target]) {
    return graph.entities[target].reason
  }

  // Check fields
  for (const entity of Object.values(graph.entities)) {
    if (entity.fields[target]) {
      return entity.fields[target].reason
    }
  }

  // Check storage
  if (graph.storage.buckets[target]) {
    return graph.storage.buckets[target].reason
  }

  return null
}

/**
 * Find all dependencies of a target
 */
export function findDependencies(
  graph: BackendStateGraph,
  target: string
): string[] {
  const deps: string[] = []

  // Check if any entities depend on this
  for (const entity of Object.values(graph.entities)) {
    if (entity.dependencies.includes(target)) {
      deps.push(entity.name)
    }
  }

  // Check if any APIs depend on this
  for (const api of Object.values(graph.apis)) {
    if (api.dependsOn.includes(target)) {
      deps.push(api.path)
    }
  }

  return deps
}

/**
 * MIGRATION WRAPPER: Redirects to graph-pointer architecture
 * @deprecated Use getActiveGraph() from graph-pointer.ts directly
 * @throws Error if graph not initialized (should never happen in production)
 */
// STATIC IMPORT FOR DETERMINISTIC ENGINE CORE
import { getActiveGraph } from './graph-pointer'

export async function loadGraph(projectId: string): Promise<BackendStateGraph> {
  const graph = await getActiveGraph(projectId)
  
  if (!graph) {
    throw new Error(`FATAL: BackendGraph not initialized for project ${projectId}. This indicates project creation failed or database corruption.`)
  }
  
  return graph
}
