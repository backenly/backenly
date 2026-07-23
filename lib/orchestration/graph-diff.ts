/**
 * Graph Structural Diff
 * 
 * Compares two BackendStateGraph instances for STRUCTURAL equality.
 * Ignores metadata, timestamps, IDs, and ordering differences.
 * 
 * Used by orchestration to prevent duplicate graph versions when
 * execution produces identical structural state.
 */

import { BackendStateGraph } from './backend-state-graph'

/**
 * Normalize graph for structural comparison
 * Removes all non-structural fields and sorts for stable comparison
 */
function normalizeGraph(graph: BackendStateGraph): any {
  // Extract only structural fields
  const normalized: any = {
    entities: {},
    apis: {},
    auth: {},
    storage: {},
    capabilities: {},
    policies: {},
    jobs: {},
    realtime: {},
    analytics: {},
    billing: {},
    integrations: {},
    notifications: {},
  }

  // Normalize entities (sort fields, remove metadata)
  if (graph.entities) {
    const sortedEntityNames = Object.keys(graph.entities).sort()
    for (const name of sortedEntityNames) {
      const entity = graph.entities[name]
      normalized.entities[name] = {
        name: entity.name,
        fields: entity.fields ? sortFields(entity.fields) : {},
        relationships: entity.relationships || [],
        dependencies: entity.dependencies || [],
        // Include structural properties only
        uniqueConstraints: entity.uniqueConstraints || [],
        accessRules: entity.accessRules || [],
        derivedFields: entity.derivedFields || [],
      }
    }
  }

  // Normalize APIs (remove generated IDs and timestamps)
  if (graph.apis) {
    const sortedApiKeys = Object.keys(graph.apis).sort()
    for (const key of sortedApiKeys) {
      const api = graph.apis[key]
      normalized.apis[key] = {
        path: api.path,
        methods: api.methods,
        requiresAuth: api.requiresAuth,
        rateLimit: api.rateLimit,
      }
    }
  }

  // Normalize auth - only structural fields
  if (graph.auth) {
    normalized.auth = {
      providers: graph.auth.providers || {},
      sessionConfig: graph.auth.sessionConfig || {},
      requirements: graph.auth.requirements || {},
    }
  }

  // Normalize storage
  if (graph.storage) {
    normalized.storage = {
      buckets: graph.storage.buckets || {},
      quotaLimit: graph.storage.quotaLimit,
    }
  }

  // Normalize capabilities
  if (graph.capabilities) {
    normalized.capabilities = { ...graph.capabilities }
  }

  // Normalize policies (sort keys, remove timestamps)
  if (graph.policies) {
    const sortedPolicyKeys = Object.keys(graph.policies).sort()
    for (const key of sortedPolicyKeys) {
      const policy = graph.policies[key]
      normalized.policies[key] = {
        name: policy.name,
        domain: policy.domain,
        action: policy.action,
        target: policy.target,
        rule: policy.rule,
        enabled: policy.enabled,
        role: policy.role,
        resource: policy.resource,
        operation: policy.operation,
      }
    }
  }

  // Normalize jobs
  if (graph.jobs) {
    const sortedJobKeys = Object.keys(graph.jobs).sort()
    for (const key of sortedJobKeys) {
      const job = graph.jobs[key]
      normalized.jobs[key] = {
        name: job.name,
        trigger: job.trigger,
        enabled: job.enabled,
      }
    }
  }

  // Normalize realtime
  if (graph.realtime) {
    normalized.realtime = {
      enabled: graph.realtime.enabled,
      channels: graph.realtime.channels || {},
    }
  }

  // Normalize analytics
  if (graph.analytics) {
    normalized.analytics = {
      enabled: graph.analytics.enabled,
      metrics: graph.analytics.metrics || [],
    }
  }

  // Normalize billing
  if (graph.billing) {
    normalized.billing = {
      enabled: graph.billing.enabled,
      plans: graph.billing.plans || {},
    }
  }

  // Normalize integrations
  if (graph.integrations) {
    const sortedIntegrationKeys = Object.keys(graph.integrations).sort()
    for (const key of sortedIntegrationKeys) {
      const integration = graph.integrations[key]
      normalized.integrations[key] = {
        name: integration.name,
        enabled: integration.enabled,
        config: integration.config,
      }
    }
  }

  // Normalize notifications
  if (graph.notifications) {
    normalized.notifications = {
      email: graph.notifications.email,
    }
  }

  return normalized
}

/**
 * Sort fields by name for stable comparison
 */
function sortFields(fields: any): any {
  const sorted: any = {}
  const fieldNames = Object.keys(fields).sort()
  for (const name of fieldNames) {
    sorted[name] = fields[name]
  }
  return sorted
}

/**
 * Sort auth providers by name
 */
function sortProviders(providers: any[]): any[] {
  return [...providers].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Deep equality check for normalized structures
 */
function deepEqual(obj1: any, obj2: any): boolean {
  if (obj1 === obj2) return true
  if (obj1 == null || obj2 == null) return false
  if (typeof obj1 !== typeof obj2) return false

  if (Array.isArray(obj1)) {
    if (!Array.isArray(obj2)) return false
    if (obj1.length !== obj2.length) return false
    for (let i = 0; i < obj1.length; i++) {
      if (!deepEqual(obj1[i], obj2[i])) return false
    }
    return true
  }

  if (typeof obj1 === 'object') {
    const keys1 = Object.keys(obj1).sort()
    const keys2 = Object.keys(obj2).sort()
    if (keys1.length !== keys2.length) return false
    if (!deepEqual(keys1, keys2)) return false
    for (const key of keys1) {
      if (!deepEqual(obj1[key], obj2[key])) return false
    }
    return true
  }

  return obj1 === obj2
}

/**
 * Check if two graphs are structurally equal
 * 
 * Returns true if graphs have identical structural state,
 * ignoring metadata, timestamps, IDs, and field ordering.
 * 
 * Use this BEFORE saveNewGraph() to prevent duplicate versions.
 */
export function isStructurallyEqual(
  g1: BackendStateGraph,
  g2: BackendStateGraph
): boolean {
  console.log('🔍 STRUCTURAL DIFF CHECK STARTING...')
  console.log('🔍 Graph 1 entities:', Object.keys(g1.entities).join(', '))
  console.log('🔍 Graph 2 entities:', Object.keys(g2.entities).join(', '))
  console.log('🔍 Graph 1 policies:', Object.keys(g1.policies || {}).length)
  console.log('🔍 Graph 2 policies:', Object.keys(g2.policies || {}).length)
  
  const norm1 = normalizeGraph(g1)
  const norm2 = normalizeGraph(g2)
  
  console.log('🔍 Normalized Graph 1 entities:', JSON.stringify(norm1.entities, null, 2).substring(0, 500))
  console.log('🔍 Normalized Graph 2 entities:', JSON.stringify(norm2.entities, null, 2).substring(0, 500))
  console.log('🔍 Normalized Graph 1 policies:', JSON.stringify(norm1.policies, null, 2))
  console.log('🔍 Normalized Graph 2 policies:', JSON.stringify(norm2.policies, null, 2))
  
  const result = deepEqual(norm1, norm2)
  console.log('🔍 STRUCTURAL DIFF RESULT:', result)
  
  if (result) {
    console.log('🔍 Graphs are EQUAL - no save needed')
  } else {
    console.log('🔍 Graphs are DIFFERENT - save required')
  }
  
  return result
}
