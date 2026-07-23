/**
 * BACKENLY CAPABILITY FRAMEWORK (Foundation)
 * 
 * A declarative layer for extending Backenly's platform features.
 */

import { BackendStateGraph } from './backend-state-graph'

/**
 * Metadata describing a platform capability.
 */
export interface CapabilityDescriptor {
  type: string
  version: string
  ownedGraphSection: string
  description: string
}

/**
 * Result of a capability execution.
 */
export interface CapabilityExecutionResult {
  success: boolean
  message: string
  graphChanges: Partial<BackendStateGraph>
  details?: any
}

/**
 * Base class for capability executors.
 */
export abstract class CapabilityExecutor {
  constructor(protected descriptor: CapabilityDescriptor) {}

  abstract validate(params: any, graph: BackendStateGraph): { valid: boolean; error?: string }
  abstract execute(params: any, graph: BackendStateGraph): Promise<CapabilityExecutionResult>
  
  /**
   * Rollback capability execution by reverting graph changes.
   * By default, it uses the previous state if provided in params.
   */
  async rollback(params: any, graph: BackendStateGraph): Promise<boolean> {
    // Standard rollback logic: if we have the previous section state, restore it.
    if (params.previousSectionState) {
      const section = this.descriptor.ownedGraphSection
      ;(graph as any)[section] = params.previousSectionState
      return true
    }
    return false
  }
}

/**
 * PHASE 10: Internal Documentation & Capability Map
 * 
 * DESIGN PRINCIPLES:
 * 1. Declarative Only: Capabilities must define what they own in the graph.
 * 2. Atomic Rollback: Must support previousState snapshotting.
 * 3. Lineage: Every mutation must update graph.lineageHash.
 * 4. Isolation: No capability can modify core DB/Auth sections directly.
 */
export const CAPABILITY_AVAILABILITY_MAP: Record<string, { supported: boolean; status: string; docs?: string; suggestion?: string }> = {
  'BACKGROUND_JOBS': { supported: true, status: 'GA', docs: 'Internal background task processing with retry logic.', suggestion: "Try: 'Run a background job to process uploads'" },
  'SCHEDULING': { supported: true, status: 'GA', docs: 'Cron-based task triggers built on background jobs.', suggestion: "Try: 'Schedule a task every night'" },
  'WEBHOOKS': { supported: true, status: 'GA', docs: 'Outbound HTTP notifications for external integrations.', suggestion: "Try: 'Send a webhook to Zapier on signup'" },
  'EVENTS': { supported: true, status: 'GA', docs: 'Internal system event bus for decoupled component communication.', suggestion: "Try: 'Trigger an event when an order is shipped'" },
  'EMAIL_MESSAGING': { supported: true, status: 'GA', docs: 'System managed email templates tied to system events.', suggestion: "Try: 'Send welcome email to new users'" },
  'STRIPE_BILLING': { supported: true, status: 'GA', docs: 'Stripe-based subscription billing (no one-off charges).', suggestion: "Try: 'Add a pro plan for $20 a month'" },
  'REALTIME_SYNC': { supported: true, status: 'Beta', docs: 'Pub/sub realtime updates for live features.', suggestion: "Try: 'Enable realtime chat for my users'" },
  'SEARCH_INDEXING': { supported: true, status: 'Beta', docs: 'Read-only entity search indexing.', suggestion: "Try: 'Allow users to search posts'" },
  'USAGE_ANALYTICS': { supported: true, status: 'Beta', docs: 'System usage tracking and metrics visualization.', suggestion: "Try: 'Track usage stats for the dashboard'" },
  
  // Future/Unsupported items for guardrails
  'VIDEO_CALLS': { supported: false, status: 'Roadmap', docs: 'WebRTC based video communication.', suggestion: "Try: 'Enable realtime chat' instead." },
  'FILE_TRANSCODING': { supported: false, status: 'In development', docs: 'Automatic video/image transformation.', suggestion: "Try: 'Allow users to upload videos' instead." },
  'MULTI_REGION_DEPLOY': { supported: false, status: 'Enterprise Roadmap', docs: 'Global infrastructure distribution.', suggestion: "Try: 'Make my app live' for standard deployment." },
  'AI_IMAGE_GEN': { supported: false, status: 'Not supported yet', docs: 'DALL-E/Stable Diffusion integration.', suggestion: "Try: 'Allow users to upload images' instead." },
}

/**
 * Global registry for platform capabilities.
 */
export class CapabilityRegistry {
  private static instance: CapabilityRegistry
  private capabilities: Map<string, CapabilityExecutor> = new Map()

  private constructor() {}

  static getInstance(): CapabilityRegistry {
    if (!CapabilityRegistry.instance) {
      CapabilityRegistry.instance = new CapabilityRegistry()
    }
    return CapabilityRegistry.instance
  }

  register(executor: CapabilityExecutor) {
    const type = (executor as any).descriptor.type
    this.capabilities.set(type, executor)
    console.log(`[Capability Registry] Registered capability: ${type}`)
  }

  get(type: string): CapabilityExecutor | undefined {
    return this.capabilities.get(type)
  }

  list(): string[] {
    return Array.from(this.capabilities.keys())
  }
}
