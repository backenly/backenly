/**
 * BILLING CAPABILITY (Stripe-Only)
 */

import { BackendStateGraph, BillingPlan } from './backend-state-graph'
import { CapabilityExecutor, CapabilityDescriptor, CapabilityExecutionResult } from './capabilities'

export const BILLING_DESCRIPTOR: CapabilityDescriptor = {
  type: 'STRIPE_BILLING',
  version: '1.0.0',
  ownedGraphSection: 'billing',
  description: 'Enables Stripe-based subscription billing.',
}

export class BillingExecutor extends CapabilityExecutor {
  constructor() {
    super(BILLING_DESCRIPTOR)
  }

  validate(params: any, graph: BackendStateGraph): { valid: boolean; error?: string } {
    if (!params.planName) return { valid: false, error: 'Plan name is required' }
    if (typeof params.amount !== 'number') return { valid: false, error: 'Plan amount must be a number' }
    return { valid: true }
  }

  async execute(params: any, graph: BackendStateGraph): Promise<CapabilityExecutionResult> {
    const planId = `plan_${params.planName.toLowerCase().replace(/\s+/g, '_')}`
    
    const newPlan: BillingPlan = {
      id: planId,
      name: params.planName,
      amount: params.amount,
      currency: params.currency || 'USD',
      interval: params.interval || 'month',
      reason: params.reason || 'Billing plan created via intent',
    }

    return {
      success: true,
      message: `Billing plan "${params.planName}" created for ${newPlan.amount} ${newPlan.currency}/${newPlan.interval}.`,
      graphChanges: {
        billing: {
          ...graph.billing,
          enabled: true,
          plans: {
            ...graph.billing.plans,
            [planId]: newPlan
          }
        }
      },
      details: { planId }
    }
  }

  async rollback(params: any, graph: BackendStateGraph): Promise<boolean> {
    return true
  }
}
