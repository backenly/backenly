/**
 * PAYMENT POLICY SYSTEM (Inner Layer)
 * 
 * This is NOT Backenly's billing (Paddle).
 * This is the Merchant-of-Record engine for USER APPS.
 * 
 * Purpose: Enable user apps to charge THEIR users without touching Stripe.
 * 
 * User says: "Free users can create 3 projects. Paid users unlimited."
 * System does: Everything (customers, subscriptions, webhooks, enforcement)
 * 
 * ⚠️ CRITICAL: This layer must NEVER expose:
 * - Stripe dashboard
 * - Webhook URLs
 * - Price IDs
 * - Customer IDs
 * - Payment configuration
 */

import { BackendStateGraph } from '../orchestration/backend-state-graph'

/**
 * Payment policy state for a user app
 * 
 * This defines business rules, not payment infrastructure
 */
export interface PaymentPolicyState {
  enabled: boolean
  
  // Tier definitions (maps to tierGating + quotas invariants)
  tiers: {
    [tierName: string]: {
      displayName: string           // "Free Plan", "Pro Plan"
      quotas: Record<string, number>  // entity → limit (-1 = unlimited)
      blockedActions: string[]         // operations not allowed
      unlockedActions: string[]        // operations only this tier can do
    }
  }
  
  // Enforcement rules
  enforcement: {
    blockOnPastDue: boolean          // Block if payment fails?
    gracePeriodDays: number          // Days before blocking
    refusalMessages: {
      quotaExceeded: string          // Message when limit hit
      subscriptionInactive: string    // Message when payment failed
      tierRequired: string            // Message when action requires upgrade
    }
  }
  
  // System-managed (NEVER exposed to users)
  _internal: {
    stripeConnected: boolean
    webhookEndpoint: string          // /api/webhooks/payments/{projectId}/{hash}
    webhookSecret: string            // For signature verification
    customersTracked: number         // Stats only
    subscriptionsActive: number      // Stats only
  }
  
  reason: string
}

/**
 * Customer state for end-user of the app
 * 
 * This tracks THEIR users' subscription state
 * Stored per-project, scoped to user app
 */
export interface AppCustomerState {
  id: string                         // Our internal ID
  projectId: string                  // Which user app this belongs to
  appUserId: string                  // User ID in THEIR app
  
  // Current tier and state
  tier: string                       // "free", "pro", etc.
  subscriptionState: 'active' | 'past_due' | 'canceled' | 'unpaid' | 'trial'
  
  // Grace period tracking
  gracePeriodEnds?: Date
  
  // System-managed (NEVER exposed)
  _internal: {
    stripeCustomerId?: string
    stripeSubscriptionId?: string
    lastPaymentAttempt?: Date
    paymentFailures: number
  }
  
  createdAt: Date
  updatedAt: Date
}

/**
 * Parse payment policy from natural language
 * 
 * User says: "Free users can create 3 posts. Pro users unlimited."
 * System generates: Complete payment policy state
 */
export function parsePaymentPolicyIntent(userMessage: string): PaymentPolicyState | null {
  const lower = userMessage.toLowerCase()
  
  // Check if this is payment policy intent
  const isPaymentPolicy = (
    /\b(free|paid|pro|premium|basic|tier|plan)\b/i.test(lower) &&
    /\b(users|user|customers|can|cannot|allowed|limited|unlimited)\b/i.test(lower) &&
    /\b(create|add|upload|post|publish|access|view|edit|delete)\b/i.test(lower)
  )
  
  if (!isPaymentPolicy) {
    return null
  }
  
  // Extract tier names
  const tiers: Record<string, any> = {}
  
  // Common tier patterns
  const tierPatterns = [
    { name: 'free', patterns: ['free', 'basic', 'trial'] },
    { name: 'pro', patterns: ['pro', 'paid', 'premium', 'standard'] },
    { name: 'enterprise', patterns: ['enterprise', 'business', 'unlimited'] }
  ]
  
  tierPatterns.forEach(({ name, patterns }) => {
    const mentioned = patterns.some(p => lower.includes(p))
    if (mentioned) {
      tiers[name] = {
        displayName: name.charAt(0).toUpperCase() + name.slice(1) + ' Plan',
        quotas: {},
        blockedActions: [],
        unlockedActions: []
      }
    }
  })
  
  // Extract quotas
  // Pattern: "free users can create 3 posts" or "can create up to 5 projects"
  const quotaRegex = /(?:free|basic|trial).*?(?:create|add|upload).*?(?:up to |maximum of )?(\d+)\s+(\w+)/gi
  let match
  while ((match = quotaRegex.exec(lower)) !== null) {
    const limit = parseInt(match[1])
    const entity = match[2]
    
    if (tiers.free) {
      tiers.free.quotas[entity] = limit
    }
  }
  
  // Pattern: "paid/pro users can create unlimited"
  const unlimitedRegex = /(?:paid|pro|premium).*?(?:unlimited|infinite|no limit)/gi
  if (unlimitedRegex.test(lower)) {
    if (tiers.pro) {
      // Extract what entity is unlimited
      const entityMatch = lower.match(/unlimited\s+(\w+)|(\w+).*?unlimited/)
      if (entityMatch) {
        const entity = entityMatch[1] || entityMatch[2]
        tiers.pro.quotas[entity] = -1  // -1 = unlimited
      }
    }
  }
  
  // If no tiers found, not a payment policy
  if (Object.keys(tiers).length === 0) {
    return null
  }
  
  return {
    enabled: true,
    tiers,
    enforcement: {
      blockOnPastDue: true,
      gracePeriodDays: 3,
      refusalMessages: {
        quotaExceeded: 'You\'ve reached your plan limit. Upgrade to continue.',
        subscriptionInactive: 'Your subscription is inactive. Please update payment.',
        tierRequired: 'This action requires a paid plan. Upgrade to unlock.'
      }
    },
    _internal: {
      stripeConnected: false,
      webhookEndpoint: '',
      webhookSecret: '',
      customersTracked: 0,
      subscriptionsActive: 0
    },
    reason: `Payment policy: ${Object.keys(tiers).join(', ')} tiers`
  }
}

/**
 * Enforce payment policy at execution time
 * 
 * This runs BEFORE every operation in the user app
 * Returns: { allowed: boolean, reason?: string }
 */
export async function enforcePaymentPolicy(
  projectId: string,
  appUserId: string,
  operation: string,
  entity: string,
  policy: PaymentPolicyState
): Promise<{ allowed: boolean; reason?: string; upgradeRequired?: boolean }> {
  
  // Get customer state from database
  const customer = await getAppCustomerState(projectId, appUserId)
  
  if (!customer) {
    // First-time user - create as free tier
    await createAppCustomer(projectId, appUserId, 'free')
    const freeTier = policy.tiers.free || policy.tiers[Object.keys(policy.tiers)[0]]
    
    // Check free tier quotas
    return checkTierQuotas(projectId, appUserId, entity, freeTier, policy)
  }
  
  // Check subscription state
  if (policy.enforcement.blockOnPastDue) {
    if (customer.subscriptionState === 'past_due' || 
        customer.subscriptionState === 'canceled' ||
        customer.subscriptionState === 'unpaid') {
      
      // Check grace period
      if (customer.gracePeriodEnds && new Date() < customer.gracePeriodEnds) {
        // Still in grace period - allow but track
        console.log(`[Payment Policy] User ${appUserId} in grace period until ${customer.gracePeriodEnds}`)
      } else {
        // Grace period expired - BLOCK
        return {
          allowed: false,
          reason: policy.enforcement.refusalMessages.subscriptionInactive,
          upgradeRequired: false
        }
      }
    }
  }
  
  // Get tier rules
  const tier = policy.tiers[customer.tier]
  if (!tier) {
    // Unknown tier - block
    return {
      allowed: false,
      reason: 'Invalid subscription tier',
      upgradeRequired: true
    }
  }
  
  // Check tier quotas
  return checkTierQuotas(projectId, appUserId, entity, tier, policy)
}

/**
 * Check if user has exceeded quota for entity
 */
async function checkTierQuotas(
  projectId: string,
  appUserId: string,
  entity: string,
  tier: any,
  policy: PaymentPolicyState
): Promise<{ allowed: boolean; reason?: string; upgradeRequired?: boolean }> {
  
  const quota = tier.quotas[entity]
  
  if (quota === undefined) {
    // No quota defined - allow
    return { allowed: true }
  }
  
  if (quota === -1) {
    // Unlimited - allow
    return { allowed: true }
  }
  
  // Count current records
  const current = await countAppUserRecords(projectId, appUserId, entity)
  
  if (current >= quota) {
    // Quota exceeded - BLOCK
    return {
      allowed: false,
      reason: policy.enforcement.refusalMessages.quotaExceeded.replace(
        'plan limit',
        `${tier.displayName} limit (${quota} ${entity})`
      ),
      upgradeRequired: true
    }
  }
  
  return { allowed: true }
}

/**
 * Get customer state from database
 * (Implementation will query project-scoped customer table)
 */
async function getAppCustomerState(
  projectId: string,
  appUserId: string
): Promise<AppCustomerState | null> {
  // TODO: Query from project's isolated database
  // SELECT * FROM _backenly_customers WHERE app_user_id = $1
  return null
}

/**
 * Create new app customer (default to free tier)
 */
async function createAppCustomer(
  projectId: string,
  appUserId: string,
  tier: string
): Promise<AppCustomerState> {
  // TODO: Insert into project's isolated database
  // INSERT INTO _backenly_customers (app_user_id, tier, subscription_state)
  return {
    id: `cus_${Date.now()}`,
    projectId,
    appUserId,
    tier,
    subscriptionState: 'trial',
    _internal: {
      paymentFailures: 0
    },
    createdAt: new Date(),
    updatedAt: new Date()
  }
}

/**
 * Count records for user in entity
 */
async function countAppUserRecords(
  projectId: string,
  appUserId: string,
  entity: string
): Promise<number> {
  // TODO: Query from project's isolated database
  // SELECT COUNT(*) FROM {entity} WHERE user_id = $1
  return 0
}

/**
 * Handle payment webhook (Stripe)
 * 
 * This processes events from Stripe for user app subscriptions
 * Completely invisible to the user
 */
export async function handlePaymentWebhook(
  projectId: string,
  event: any,
  signature: string
): Promise<{ success: boolean; message: string }> {
  
  // Verify signature (Stripe)
  const policy = await getPaymentPolicy(projectId)
  if (!policy) {
    return { success: false, message: 'Payment policy not configured' }
  }
  
  const isValid = verifyStripeSignature(
    event,
    signature,
    policy._internal.webhookSecret
  )
  
  if (!isValid) {
    console.error(`[Payment Webhook] Invalid signature for project ${projectId}`)
    return { success: false, message: 'Invalid signature' }
  }
  
  // Handle event type
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(projectId, event.data.object)
      break
      
    case 'invoice.payment_succeeded':
      await handlePaymentSucceeded(projectId, event.data.object)
      break
      
    case 'invoice.payment_failed':
      await handlePaymentFailed(projectId, event.data.object)
      break
      
    case 'customer.subscription.deleted':
      await handleSubscriptionCanceled(projectId, event.data.object)
      break
      
    default:
      console.log(`[Payment Webhook] Unhandled event type: ${event.type}`)
  }
  
  return { success: true, message: 'Processed' }
}

/**
 * Handle subscription update
 */
async function handleSubscriptionUpdated(projectId: string, subscription: any) {
  const appUserId = subscription.metadata?.app_user_id
  if (!appUserId) {
    console.error('[Payment Webhook] Missing app_user_id in subscription metadata')
    return
  }
  
  const tier = subscription.metadata?.tier || 'pro'
  
  await updateAppCustomer(projectId, appUserId, {
    tier,
    subscriptionState: 'active',
    _internal: {
      stripeSubscriptionId: subscription.id,
      paymentFailures: 0
    }
  })
  
  console.log(`[Payment Webhook] Subscription updated: ${appUserId} → ${tier}`)
}

/**
 * Handle successful payment
 */
async function handlePaymentSucceeded(projectId: string, invoice: any) {
  const appUserId = invoice.metadata?.app_user_id
  if (!appUserId) return
  
  await updateAppCustomer(projectId, appUserId, {
    subscriptionState: 'active',
    gracePeriodEnds: undefined,
    _internal: {
      lastPaymentAttempt: new Date(),
      paymentFailures: 0
    }
  })
  
  console.log(`[Payment Webhook] Payment succeeded: ${appUserId}`)
}

/**
 * Handle failed payment
 */
async function handlePaymentFailed(projectId: string, invoice: any) {
  const appUserId = invoice.metadata?.app_user_id
  if (!appUserId) return
  
  const policy = await getPaymentPolicy(projectId)
  const gracePeriodDays = policy?.enforcement.gracePeriodDays || 3
  
  const customer = await getAppCustomerState(projectId, appUserId)
  const failures = (customer?._internal.paymentFailures || 0) + 1
  
  await updateAppCustomer(projectId, appUserId, {
    subscriptionState: 'past_due',
    gracePeriodEnds: new Date(Date.now() + gracePeriodDays * 24 * 60 * 60 * 1000),
    _internal: {
      lastPaymentAttempt: new Date(),
      paymentFailures: failures
    }
  })
  
  console.log(`[Payment Webhook] Payment failed: ${appUserId} (${failures} failures)`)
}

/**
 * Handle subscription cancellation
 */
async function handleSubscriptionCanceled(projectId: string, subscription: any) {
  const appUserId = subscription.metadata?.app_user_id
  if (!appUserId) return
  
  await updateAppCustomer(projectId, appUserId, {
    tier: 'free',
    subscriptionState: 'canceled',
    _internal: {
      stripeSubscriptionId: undefined,
      paymentFailures: 0
    }
  })
  
  console.log(`[Payment Webhook] Subscription canceled: ${appUserId} → free tier`)
}

/**
 * Update app customer state
 */
async function updateAppCustomer(
  projectId: string,
  appUserId: string,
  updates: Partial<AppCustomerState>
) {
  // TODO: Update in project's isolated database
  // UPDATE _backenly_customers SET ... WHERE app_user_id = $1
}

/**
 * Get payment policy for project
 */
async function getPaymentPolicy(projectId: string): Promise<PaymentPolicyState | null> {
  // TODO: Load from BackendStateGraph
  return null
}

/**
 * Verify Stripe webhook signature
 */
function verifyStripeSignature(event: any, signature: string, secret: string): boolean {
  // TODO: Implement Stripe signature verification
  // Uses crypto.createHmac('sha256', secret)
  return true  // Placeholder
}
