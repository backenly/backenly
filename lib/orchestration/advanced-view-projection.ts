/**
 * Phase 9: Advanced View Projection (Read-Only)
 * 
 * Escape hatch without damage - shows internal state but CANNOT mutate.
 * All changes MUST go through intent flow.
 * 
 * This prevents "power user sabotage" while providing transparency.
 */

import { BackendStateGraph, EntityState, FieldState, AuthState, ApiState, BucketState } from './backend-state-graph'

export interface AdvancedView {
  tables: TableProjection[]
  apis: ApiProjection[]
  auth: AuthProjection
  monitoring: MonitoringProjection
  metadata: ViewMetadata
  readonly: true // CRITICAL: This view CANNOT mutate
}

export interface TableProjection {
  name: string
  fieldCount: number
  fields: FieldProjection[]
  relationships: RelationshipProjection[]
  createdAt: string
  reason: string // Why this table exists
  readonly: true
}

export interface FieldProjection {
  name: string
  type: string
  nullable: boolean
  unique: boolean
  isPrimaryKey: boolean
  reason: string // Why this field exists
  readonly: true
}

export interface RelationshipProjection {
  from: string
  to: string
  type: 'one-to-one' | 'one-to-many' | 'many-to-many'
  foreignKey?: string
  readonly: true
}

export interface ApiProjection {
  path: string
  methods: string[]
  requiresAuth: boolean
  rateLimit: number
  reason: string // Why this API exists
  status: 'active' | 'deprecated'
  readonly: true
}

export interface AuthProjection {
  providers: AuthProviderProjection[]
  sessionDuration: string
  requiresAuthByDefault: boolean
  publicRoutes: string[]
  readonly: true
}

export interface AuthProviderProjection {
  name: string
  enabled: boolean
  reason: string
  readonly: true
}

export interface MonitoringProjection {
  metrics: MetricProjection[]
  health: HealthProjection
  usage: UsageProjection
  readonly: true
}

export interface MetricProjection {
  name: string
  value: number | string
  unit: string
  timestamp: string
  readonly: true
}

export interface HealthProjection {
  status: 'healthy' | 'degraded' | 'down'
  uptime: number // seconds
  lastChecked: string
  readonly: true
}

export interface UsageProjection {
  apiCalls: number
  storageUsed: number // bytes
  storageLimit: number // bytes
  databaseRows: number
  readonly: true
}

export interface ViewMetadata {
  projectId: string
  generatedAt: string
  version: number
  warning: string // Always remind user this is read-only
}

/**
 * Project backend state into read-only advanced view
 * 
 * CRITICAL: This is a ONE-WAY projection. No mutations allowed.
 */
export function projectAdvancedView(
  graph: BackendStateGraph
): AdvancedView {
  return {
    tables: projectTables(graph),
    apis: projectApis(graph),
    auth: projectAuth(graph),
    monitoring: projectMonitoring(graph),
    metadata: {
      projectId: graph.projectId,
      generatedAt: new Date().toISOString(),
      version: graph.version,
      warning: 'This view is read-only. All changes must be made through natural language commands.',
    },
    readonly: true,
  }
}

/**
 * Project tables into read-only view
 */
function projectTables(graph: BackendStateGraph): TableProjection[] {
  return Object.values(graph.entities).map(entity => ({
    name: entity.name,
    fieldCount: Object.keys(entity.fields).length,
    fields: projectFields(entity),
    relationships: entity.relationships.map(rel => ({
      from: rel.from,
      to: rel.to,
      type: rel.type,
      foreignKey: rel.foreignKey,
      readonly: true as const,
    })),
    createdAt: entity.createdAt,
    reason: entity.reason,
    readonly: true as const,
  }))
}

/**
 * Project fields into read-only view
 */
function projectFields(entity: EntityState): FieldProjection[] {
  return Object.values(entity.fields).map(field => ({
    name: field.name,
    type: field.type,
    nullable: field.nullable,
    unique: field.unique,
    isPrimaryKey: field.name === 'id', // Convention
    reason: field.reason,
    readonly: true as const,
  }))
}

/**
 * Project APIs into read-only view
 */
function projectApis(graph: BackendStateGraph): ApiProjection[] {
  return Object.values(graph.apis).map(api => ({
    path: api.path,
    methods: api.methods,
    requiresAuth: api.requiresAuth,
    rateLimit: api.rateLimit,
    reason: api.reason,
    status: 'active' as const, // TODO: Track deprecated APIs
    readonly: true as const,
  }))
}

/**
 * Project auth into read-only view
 */
function projectAuth(graph: BackendStateGraph): AuthProjection {
  const providers: AuthProviderProjection[] = []
  
  // Google
  if (graph.auth.providers.google) {
    providers.push({
      name: 'Google',
      enabled: graph.auth.providers.google.enabled,
      reason: graph.auth.providers.google.reason,
      readonly: true as const,
    })
  }
  
  // GitHub
  if (graph.auth.providers.github) {
    providers.push({
      name: 'GitHub',
      enabled: graph.auth.providers.github.enabled,
      reason: graph.auth.providers.github.reason,
      readonly: true as const,
    })
  }
  
  // Email
  if (graph.auth.providers.email) {
    providers.push({
      name: 'Email',
      enabled: graph.auth.providers.email.enabled,
      reason: graph.auth.providers.email.reason,
      readonly: true as const,
    })
  }
  
  return {
    providers,
    sessionDuration: graph.auth.sessionConfig.duration,
    requiresAuthByDefault: graph.auth.requirements.requireAuth,
    publicRoutes: graph.auth.requirements.publicRoutes,
    readonly: true as const,
  }
}

/**
 * Project monitoring into read-only view
 */
function projectMonitoring(graph: BackendStateGraph): MonitoringProjection {
  // Placeholder metrics - in production, fetch from real monitoring
  const metrics: MetricProjection[] = [
    {
      name: 'API Requests (24h)',
      value: 1247,
      unit: 'requests',
      timestamp: new Date().toISOString(),
      readonly: true as const,
    },
    {
      name: 'Average Response Time',
      value: 124,
      unit: 'ms',
      timestamp: new Date().toISOString(),
      readonly: true as const,
    },
    {
      name: 'Error Rate',
      value: 0.2,
      unit: '%',
      timestamp: new Date().toISOString(),
      readonly: true as const,
    },
  ]
  
  const health: HealthProjection = {
    status: 'healthy',
    uptime: 86400 * 7, // 7 days in seconds
    lastChecked: new Date().toISOString(),
    readonly: true as const,
  }
  
  const usage: UsageProjection = {
    apiCalls: 1247,
    storageUsed: graph.storage.totalUsage,
    storageLimit: graph.storage.quotaLimit,
    databaseRows: Object.keys(graph.entities).length * 100, // Estimate
    readonly: true as const,
  }
  
  return {
    metrics,
    health,
    usage,
    readonly: true as const,
  }
}

/**
 * Validate that a mutation request is BLOCKED
 * 
 * Advanced View CANNOT mutate - always reject
 */
export function validateAdvancedViewMutation(
  action: string
): {
  allowed: false
  reason: string
  redirectToIntent: true
} {
  // ALWAYS reject mutations from Advanced View
  return {
    allowed: false,
    reason: 'Advanced Mode is read-only. Describe your change in natural language instead.',
    redirectToIntent: true,
  }
}

/**
 * Generate human-readable summary for Advanced View
 */
export function generateAdvancedViewSummary(view: AdvancedView): string {
  const parts: string[] = []
  
  if (view.tables.length > 0) {
    parts.push(`${view.tables.length} ${view.tables.length === 1 ? 'collection' : 'collections'}`)
  }
  
  if (view.apis.length > 0) {
    parts.push(`${view.apis.length} ${view.apis.length === 1 ? 'endpoint' : 'endpoints'}`)
  }
  
  const enabledProviders = view.auth.providers.filter(p => p.enabled)
  if (enabledProviders.length > 0) {
    parts.push(`${enabledProviders.length} auth ${enabledProviders.length === 1 ? 'method' : 'methods'}`)
  }
  
  if (parts.length === 0) {
    return 'Your backend is empty. Describe what you want to build.'
  }
  
  return `Your backend has ${parts.join(', ')}.`
}

/**
 * Format storage usage for display
 */
export function formatStorageUsage(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = 0
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  
  return `${size.toFixed(2)} ${units[unitIndex]}`
}

/**
 * Format uptime for display
 */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  
  if (days > 0) {
    return `${days} ${days === 1 ? 'day' : 'days'}`
  }
  
  if (hours > 0) {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

/**
 * Get table schema as human-readable text
 */
export function getTableSchemaText(table: TableProjection): string {
  const lines: string[] = []
  
  lines.push(`Collection: ${table.name}`)
  lines.push(`Created: ${new Date(table.createdAt).toLocaleDateString()}`)
  lines.push(`Reason: ${table.reason}`)
  lines.push('')
  lines.push('Fields:')
  
  table.fields.forEach(field => {
    const attributes: string[] = []
    if (field.isPrimaryKey) attributes.push('primary key')
    if (field.unique) attributes.push('unique')
    if (!field.nullable) attributes.push('required')
    
    const attrString = attributes.length > 0 ? ` (${attributes.join(', ')})` : ''
    lines.push(`  • ${field.name}: ${field.type}${attrString}`)
    lines.push(`    ${field.reason}`)
  })
  
  if (table.relationships.length > 0) {
    lines.push('')
    lines.push('Relationships:')
    table.relationships.forEach(rel => {
      lines.push(`  • ${rel.from} → ${rel.to} (${rel.type})`)
    })
  }
  
  return lines.join('\n')
}

/**
 * Get API details as human-readable text
 */
export function getApiDetailsText(api: ApiProjection): string {
  const lines: string[] = []
  
  lines.push(`Endpoint: ${api.path}`)
  lines.push(`Methods: ${api.methods.join(', ')}`)
  lines.push(`Authentication: ${api.requiresAuth ? 'Required' : 'Public'}`)
  lines.push(`Rate Limit: ${api.rateLimit} requests/minute`)
  lines.push(`Reason: ${api.reason}`)
  
  return lines.join('\n')
}

/**
 * Export advanced view as JSON
 * 
 * For user data ownership - allow full export
 */
export function exportAdvancedView(view: AdvancedView): string {
  return JSON.stringify(view, null, 2)
}

/**
 * Check if user is attempting to bypass read-only restriction
 */
export function detectBypassAttempt(
  action: string,
  context: 'advanced_view' | 'inspector' | 'monitoring'
): {
  isAttempt: boolean
  suggestion: string
} {
  const mutationKeywords = [
    'update',
    'delete',
    'create',
    'modify',
    'change',
    'edit',
    'add',
    'remove',
    'drop',
    'alter',
  ]
  
  const isAttempt = mutationKeywords.some(keyword => 
    action.toLowerCase().includes(keyword)
  )
  
  if (isAttempt) {
    return {
      isAttempt: true,
      suggestion: 'Go to the main page and describe your change in plain English. Backenly will handle it safely.',
    }
  }
  
  return {
    isAttempt: false,
    suggestion: '',
  }
}
