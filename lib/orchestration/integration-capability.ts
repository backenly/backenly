/**
 * INTEGRATION CAPABILITIES (Webhooks & Events)
 */

import { BackendStateGraph, WebhookState, EventState } from './backend-state-graph'
import { CapabilityExecutor, CapabilityDescriptor, CapabilityExecutionResult } from './capabilities'

/**
 * WEBHOOK CAPABILITY
 */
export const WEBHOOK_DESCRIPTOR: CapabilityDescriptor = {
  type: 'WEBHOOKS',
  version: '1.0.0',
  ownedGraphSection: 'webhooks',
  description: 'Enables outbound webhooks to external services.',
}

export class WebhookExecutor extends CapabilityExecutor {
  constructor() {
    super(WEBHOOK_DESCRIPTOR)
  }

  validate(params: any, graph: BackendStateGraph): { valid: boolean; error?: string } {
    if (!params.url) return { valid: false, error: 'Webhook URL is required' }
    return { valid: true }
  }

  async execute(params: any, graph: BackendStateGraph): Promise<CapabilityExecutionResult> {
    const webhookId = `wh_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
    
    const newWebhook: WebhookState = {
      id: webhookId,
      name: params.name || 'External Service',
      url: params.url,
      retries: params.retries || 3,
      reason: params.reason || 'Outbound integration requested',
      createdBy: params.createdBy || 'intent_engine',
      createdAt: new Date().toISOString(),
      enabled: true,
    }

    return {
      success: true,
      message: `Webhook for "${newWebhook.name}" registered.`,
      graphChanges: {
        webhooks: {
          ...graph.webhooks,
          [webhookId]: newWebhook
        }
      },
      details: { webhookId }
    }
  }

  async rollback(params: any, graph: BackendStateGraph): Promise<boolean> {
    return true
  }
}

/**
 * EVENT CAPABILITY
 */
export const EVENT_DESCRIPTOR: CapabilityDescriptor = {
  type: 'EVENTS',
  version: '1.0.0',
  ownedGraphSection: 'events',
  description: 'Enables event-driven orchestration.',
}

export class EventExecutor extends CapabilityExecutor {
  constructor() {
    super(EVENT_DESCRIPTOR)
  }

  validate(params: any, graph: BackendStateGraph): { valid: boolean; error?: string } {
    if (!params.name) return { valid: false, error: 'Event name is required' }
    return { valid: true }
  }

  async execute(params: any, graph: BackendStateGraph): Promise<CapabilityExecutionResult> {
    const eventId = `ev_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
    
    // Check if event already exists
    const existing = Object.values(graph.events).find(e => e.name === params.name)
    
    if (existing) {
      // Update subscribers if new ones provided
      if (params.subscribers) {
        const updatedSubscribers = Array.from(new Set([...existing.subscribers, ...params.subscribers]))
        return {
          success: true,
          message: `Subscribers added to event "${params.name}".`,
          graphChanges: {
            events: {
              ...graph.events,
              [existing.id]: {
                ...existing,
                subscribers: updatedSubscribers
              }
            }
          },
          details: { eventId: existing.id }
        }
      }
      return { success: true, message: `Event "${params.name}" already exists.`, graphChanges: {} }
    }

    const newEvent: EventState = {
      id: eventId,
      name: params.name,
      subscribers: params.subscribers || [],
      reason: params.reason || 'Event orchestration requested',
      createdBy: params.createdBy || 'intent_engine',
      createdAt: new Date().toISOString(),
    }

    return {
      success: true,
      message: `Event "${params.name}" registered.`,
      graphChanges: {
        events: {
          ...graph.events,
          [eventId]: newEvent
        }
      },
      details: { eventId }
    }
  }

  async rollback(params: any, graph: BackendStateGraph): Promise<boolean> {
    return true
  }
}
