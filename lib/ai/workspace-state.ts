/**
 * WORKSPACE STATE BUILDER
 * 
 * Builds a clean, summarized state from the backend graph for AI reasoning.
 * This is what makes Backenly AI intelligent like Cursor/Bolt/Replit.
 * 
 * The AI receives structured workspace state and reasons over it,
 * instead of using hardcoded if/else responses.
 */

import { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'

export interface WorkspaceState {
  projectName: string
  tables: TableState[]
  apis: ApiState[]
  auth: WorkspaceAuthState
  storage: WorkspaceStorageState
  relations: RelationState[]
  stats: {
    tables: number
    apis: number
    relations: number
  }
}

export interface TableState {
  name: string
  fields: { name: string; type: string; required?: boolean }[]
}

export interface ApiState {
  method: string
  path: string
  table?: string
}

export interface WorkspaceAuthState {
  enabled: boolean
  type?: string
  providers: string[]
}

export interface WorkspaceStorageState {
  enabled: boolean
  buckets: string[]
}

export interface RelationState {
  from: string
  to: string
  type: string
}

/**
 * Build clean workspace state from backend graph
 */
export function buildWorkspaceState(
  graph: BackendStateGraph,
  projectName: string = 'Untitled Project'
): WorkspaceState {
  // Extract tables with fields
  const tables: TableState[] = Object.entries(graph.entities || {}).map(([name, entity]: [string, any]) => ({
    name,
    fields: Object.entries(entity.fields || {}).map(([fieldName, field]: [string, any]) => ({
      name: fieldName,
      type: field.type || 'unknown',
      required: field.required,
    })),
  }))

  // Extract APIs and deduplicate
  const apiSet = new Set<string>()
  const apis: ApiState[] = []
  
  Object.entries(graph.apis || {}).forEach(([path, api]: [string, any]) => {
    const method = api.method || 'GET'
    const fullPath = path.startsWith('/') ? path : `/${path}`
    const key = `${method} ${fullPath}`
    
    if (!apiSet.has(key)) {
      apiSet.add(key)
      apis.push({
        method,
        path: fullPath,
        table: api.entity,
      })
    }
  })

  // Extract auth - handle nested providers structure
  const providers = (graph.auth as any)?.providers || {}
  const enabledProviders = Object.entries(providers)
    .filter(([_, config]: [string, any]) => {
      return typeof config === 'boolean' ? config : config?.enabled === true
    })
    .map(([name]) => name)

  const auth: WorkspaceAuthState = {
    enabled: enabledProviders.length > 0,
    type: enabledProviders.length > 0 ? 'jwt' : undefined,
    providers: enabledProviders,
  }

  // Extract storage
  const storageBuckets = (graph.storage as any)?.buckets || {}
  const storage: WorkspaceStorageState = {
    enabled: Object.keys(storageBuckets).length > 0,
    buckets: Object.keys(storageBuckets),
  }

  // Extract relations from entities
  const relations: RelationState[] = []
  Object.entries(graph.entities || {}).forEach(([entityName, entity]: [string, any]) => {
    const entityRelations = entity.relationships || []
    entityRelations.forEach((rel: any) => {
      relations.push({
        from: entityName,
        to: rel.to || rel.target,
        type: rel.type,
      })
    })
  })

  return {
    projectName,
    tables,
    apis,
    auth,
    storage,
    relations,
    stats: {
      tables: tables.length,
      apis: apis.length,
      relations: relations.length,
    },
  }
}

/**
 * Format workspace state for LLM context
 * 
 * Sends rich human-readable context including:
 * - Project info
 * - Backend purpose/behavior
 * - Tables with fields
 * - Relationships
 * - APIs
 * - Auth
 * - Storage
 * - Capabilities summary
 * - Missing features suggestions
 */
export function formatWorkspaceStateForLLM(state: WorkspaceState): string {
  const lines: string[] = []

  // 1. Project
  lines.push(`Project: ${state.projectName}`)
  lines.push('')

  // 2. Backend Purpose (inferred from tables)
  lines.push('Backend Purpose:')
  const capabilities = inferCapabilities(state)
  if (capabilities.length > 0) {
    capabilities.forEach(cap => lines.push(`  • ${cap}`))
  } else {
    lines.push('  • No specific features configured yet')
  }
  lines.push('')

  // 3. Tables
  if (state.tables.length > 0) {
    lines.push(`Tables (${state.tables.length}):`)
    state.tables.forEach(table => {
      lines.push(`  • ${table.name}`)
      table.fields.forEach(field => {
        lines.push(`    - ${field.name}: ${field.type}${field.required ? '' : '?'}`)
      })
    })
    lines.push('')
  }

  // 4. Relationships
  if (state.relations.length > 0) {
    lines.push(`Relationships (${state.relations.length}):`)
    state.relations.forEach(rel => {
      lines.push(`  • ${rel.from}.${rel.type} → ${rel.to}`)
    })
    lines.push('')
  }

  // 5. APIs
  if (state.apis.length > 0) {
    lines.push(`APIs (${state.apis.length}):`)
    state.apis.forEach(api => {
      lines.push(`  • ${api.method} ${api.path}`)
    })
    lines.push('')
  }

  // 6. Auth
  lines.push('Authentication:')
  if (state.auth.enabled) {
    lines.push(`  • Enabled: ${state.auth.type?.toUpperCase() || 'JWT'}`)
    if (state.auth.providers.length > 0) {
      lines.push(`  • Providers: ${state.auth.providers.join(', ')}`)
    }
  } else {
    lines.push('  • Disabled')
  }
  lines.push('')

  // 7. Storage
  lines.push('Storage:')
  if (state.storage.enabled) {
    lines.push('  • Enabled')
    if (state.storage.buckets.length > 0) {
      lines.push(`  • Buckets: ${state.storage.buckets.join(', ')}`)
    }
  } else {
    lines.push('  • Disabled')
  }
  lines.push('')

  // 8. Backend Summary
  lines.push('Backend Summary:')
  lines.push(`  • Tables: ${state.stats.tables}`)
  lines.push(`  • APIs: ${state.stats.apis}`)
  lines.push(`  • Auth: ${state.auth.enabled ? 'Enabled' : 'Disabled'}`)
  lines.push(`  • Storage: ${state.storage.enabled ? 'Enabled' : 'Disabled'}`)
  lines.push('')

  // 9. Missing Features (suggestions)
  const missing = inferMissingFeatures(state)
  if (missing.length > 0) {
    lines.push('Possible Improvements:')
    missing.forEach(feature => lines.push(`  • ${feature}`))
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Infer capabilities from backend state
 */
function inferCapabilities(state: WorkspaceState): string[] {
  const caps: string[] = []
  
  // Check for auth
  if (state.auth.enabled) {
    caps.push('User authentication and registration')
  }
  
  // Check for tables that suggest features
  const tableNames = state.tables.map(t => t.name.toLowerCase())
  
  if (tableNames.includes('posts') || tableNames.includes('articles')) {
    caps.push('Content creation and publishing')
  }
  
  if (tableNames.includes('comments')) {
    caps.push('Commenting system')
  }
  
  if (tableNames.includes('products') || tableNames.includes('orders')) {
    caps.push('E-commerce functionality')
  }
  
  if (tableNames.includes('tasks') || tableNames.includes('todos')) {
    caps.push('Task management')
  }
  
  if (state.storage.enabled) {
    caps.push('File upload and storage')
  }
  
  if (state.apis.length > 0) {
    caps.push('REST API endpoints for data access')
  }
  
  return caps
}

/**
 * Infer missing features that could be suggested
 */
function inferMissingFeatures(state: WorkspaceState): string[] {
  const missing: string[] = []
  const tableNames = state.tables.map(t => t.name.toLowerCase())
  
  // Auth suggestions
  if (!state.auth.enabled) {
    missing.push('Add user authentication (email, Google, GitHub)')
  } else if (state.auth.providers.length === 1 && state.auth.providers[0] === 'email') {
    missing.push('Add social login (Google, GitHub)')
  }
  
  // Content suggestions
  if (tableNames.includes('posts') && !tableNames.includes('comments')) {
    missing.push('Add commenting system for posts')
  }
  
  // Storage suggestions
  if (!state.storage.enabled && (tableNames.includes('posts') || tableNames.includes('users'))) {
    missing.push('Enable file storage for uploads')
  }
  
  // API suggestions
  if (state.tables.length > 0 && state.apis.length === 0) {
    missing.push('Create REST APIs for your tables')
  }
  
  return missing
}
