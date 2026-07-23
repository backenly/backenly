/**
 * DATA CAPABILITIES (Search & Analytics)
 */

import { BackendStateGraph } from './backend-state-graph'
import { CapabilityExecutor, CapabilityDescriptor, CapabilityExecutionResult } from './capabilities'

/**
 * SEARCH CAPABILITY
 */
export const SEARCH_DESCRIPTOR: CapabilityDescriptor = {
  type: 'SEARCH_INDEXING',
  version: '1.0.0',
  ownedGraphSection: 'search',
  description: 'Enables read-only search indexing for entities.',
}

export class SearchExecutor extends CapabilityExecutor {
  constructor() {
    super(SEARCH_DESCRIPTOR)
  }

  validate(params: any, graph: BackendStateGraph): { valid: boolean; error?: string } {
    if (!params.entity) return { valid: false, error: 'Target entity for indexing is required' }
    if (params.entity === 'all') return { valid: true }
    
    const entityExists = graph.entities[params.entity] || 
                         Object.values(graph.entities).some(e => e.name.toLowerCase() === params.entity.toLowerCase())
    
    if (!entityExists) return { valid: false, error: `Entity "${params.entity}" does not exist` }
    return { valid: true }
  }

  async execute(params: any, graph: BackendStateGraph): Promise<CapabilityExecutionResult> {
    const updatedIndexedEntities = Array.from(new Set([...graph.search.indexedEntities, params.entity]))

    return {
      success: true,
      message: `Search indexing enabled for entity "${params.entity}".`,
      graphChanges: {
        search: {
          ...graph.search,
          enabled: true,
          indexedEntities: updatedIndexedEntities,
          reason: params.reason || 'Search indexing requested',
        }
      },
      details: { entity: params.entity }
    }
  }

  async rollback(params: any, graph: BackendStateGraph): Promise<boolean> {
    return true
  }
}

/**
 * ANALYTICS CAPABILITY
 */
export const ANALYTICS_DESCRIPTOR: CapabilityDescriptor = {
  type: 'USAGE_ANALYTICS',
  version: '1.0.0',
  ownedGraphSection: 'analytics',
  description: 'Enables system usage and behavior tracking.',
}

export class AnalyticsExecutor extends CapabilityExecutor {
  constructor() {
    super(ANALYTICS_DESCRIPTOR)
  }

  validate(params: any, graph: BackendStateGraph): { valid: boolean; error?: string } {
    if (!params.metric) return { valid: false, error: 'Metric name is required' }
    return { valid: true }
  }

  async execute(params: any, graph: BackendStateGraph): Promise<CapabilityExecutionResult> {
    const updatedMetrics = Array.from(new Set([...graph.analytics.metrics, params.metric]))

    return {
      success: true,
      message: `Analytics tracking enabled for metric "${params.metric}".`,
      graphChanges: {
        analytics: {
          ...graph.analytics,
          enabled: true,
          metrics: updatedMetrics,
          retention: params.retention || graph.analytics.retention,
          reason: params.reason || 'Analytics tracking requested',
        }
      },
      details: { metric: params.metric }
    }
  }

  async rollback(params: any, graph: BackendStateGraph): Promise<boolean> {
    return true
  }
}
