/**
 * BACKGROUND JOBS CAPABILITY
 */

import { BackendStateGraph, JobState } from './backend-state-graph'
import { CapabilityExecutor, CapabilityDescriptor, CapabilityExecutionResult } from './capabilities'

export const BACKGROUND_JOB_DESCRIPTOR: CapabilityDescriptor = {
  type: 'BACKGROUND_JOBS',
  version: '1.0.0',
  ownedGraphSection: 'jobs',
  description: 'Enables background job processing and scheduling.',
}

export class BackgroundJobExecutor extends CapabilityExecutor {
  constructor() {
    super(BACKGROUND_JOB_DESCRIPTOR)
  }

  validate(params: any, graph: BackendStateGraph): { valid: boolean; error?: string } {
    if (!params.name) return { valid: false, error: 'Job name is required' }
    if (!params.handler) return { valid: false, error: 'Job handler is required' }
    return { valid: true }
  }

  async execute(params: any, graph: BackendStateGraph): Promise<CapabilityExecutionResult> {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
    
    const newJob: JobState = {
      id: jobId,
      name: params.name,
      trigger: params.trigger || 'manual',
      handler: params.handler,
      retryPolicy: params.retryPolicy || { maxRetries: 3, backoff: 'exponential' },
      visibility: params.visibility || 'internal',
      reason: params.reason || 'Background processing requested',
      createdBy: params.createdBy || 'intent_engine',
      createdAt: new Date().toISOString(),
      enabled: true,
    }

    return {
      success: true,
      message: `Background job "${params.name}" registered.`,
      graphChanges: {
        jobs: {
          ...graph.jobs,
          [jobId]: newJob
        }
      },
      details: { jobId }
    }
  }

  async rollback(params: any, graph: BackendStateGraph): Promise<boolean> {
    // In production: Cancel scheduled jobs or clean up workers
    return true
  }
}
