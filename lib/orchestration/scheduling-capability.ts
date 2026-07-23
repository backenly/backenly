/**
 * SCHEDULING & CRON CAPABILITY
 */

import { BackendStateGraph, ScheduleState } from './backend-state-graph'
import { CapabilityExecutor, CapabilityDescriptor, CapabilityExecutionResult } from './capabilities'

export const SCHEDULING_DESCRIPTOR: CapabilityDescriptor = {
  type: 'SCHEDULING',
  version: '1.0.0',
  ownedGraphSection: 'schedules',
  description: 'Enables cron-based job scheduling.',
}

export class SchedulingExecutor extends CapabilityExecutor {
  constructor() {
    super(SCHEDULING_DESCRIPTOR)
  }

  validate(params: any, graph: BackendStateGraph): { valid: boolean; error?: string } {
    if (!params.jobRef) return { valid: false, error: 'Job reference is required' }
    if (!params.cron) return { valid: false, error: 'Cron expression is required' }
    
    // Check if job exists
    const jobExists = Object.values(graph.jobs).some(j => j.id === params.jobRef || j.name === params.jobRef)
    if (!jobExists) return { valid: false, error: `Job "${params.jobRef}" not found` }
    
    return { valid: true }
  }

  async execute(params: any, graph: BackendStateGraph): Promise<CapabilityExecutionResult> {
    const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
    
    // Find job ID if name was provided
    const job = Object.values(graph.jobs).find(j => j.id === params.jobRef || j.name === params.jobRef)
    
    const newSchedule: ScheduleState = {
      id: scheduleId,
      name: params.name || `Schedule for ${job?.name || params.jobRef}`,
      jobRef: job?.id || params.jobRef,
      cron: params.cron,
      timezone: params.timezone || 'UTC',
      reason: params.reason || 'Automated scheduling requested',
      createdBy: params.createdBy || 'intent_engine',
      createdAt: new Date().toISOString(),
      enabled: true,
    }

    return {
      success: true,
      message: `Schedule "${newSchedule.name}" registered for job "${job?.name}".`,
      graphChanges: {
        schedules: {
          ...graph.schedules,
          [scheduleId]: newSchedule
        }
      },
      details: { scheduleId }
    }
  }

  async rollback(params: any, graph: BackendStateGraph): Promise<boolean> {
    return true
  }
}
