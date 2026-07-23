/**
 * WEBHOOK TRIGGERS (External Events → Internal Actions)
 * 
 * Purpose: Let user apps respond to external events without managing webhooks
 * 
 * User says: "When payment succeeds, unlock premium features"
 * System does: Creates endpoint, verifies signatures, executes side effects
 * 
 * ⚠️ CRITICAL: Users must NEVER see:
 * - Webhook URLs
 * - Secret keys
 * - Signature verification
 * - Retry logic
 * - Provider dashboards
 */

import { BackendStateGraph } from '../orchestration/backend-state-graph'

/**
 * Webhook trigger definition
 * Maps external events to internal side effects
 */
export interface WebhookTrigger {
  id: string
  name: string                      // User-friendly name
  externalEvent: string             // "payment.succeeded", "form.submitted"
  provider: 'stripe' | 'paddle' | 'generic'
  
  // What happens internally (maps to sideEffects invariant)
  internalAction: {
    type: 'update_field' | 'create_record' | 'state_transition' | 'send_email'
    targetEntity: string
    targetField?: string
    operation?: 'set' | 'increment' | 'append'
    value?: any
    condition?: string               // SQL-like condition
  }
  
  // Idempotency
  idempotencyKey: string            // Field in event to use as key
  
  // Retry policy
  retryPolicy: {
    maxAttempts: number
    backoffMs: number
  }
  
  // System-managed (NEVER exposed)
  _internal: {
    webhookEndpoint: string          // /api/webhooks/external/{projectId}/{hash}
    webhookSecret: string            // For signature verification
    lastTriggered?: Date
    totalExecutions: number
    failedExecutions: number
  }
  
  enabled: boolean
  createdAt: Date
}

/**
 * Webhook policy state for project
 */
export interface WebhookPolicyState {
  enabled: boolean
  triggers: Record<string, WebhookTrigger>
  
  // Execution log for idempotency
  executionLog: Record<string, {
    idempotencyKey: string
    triggerId: string
    timestamp: Date
    status: 'success' | 'failed' | 'retrying'
    attempts: number
    lastError?: string
  }>
  
  reason: string
}

/**
 * Parse webhook trigger from natural language
 * 
 * User says: "When payment succeeds, unlock premium features"
 * System generates: Complete webhook trigger
 */
export function parseWebhookTriggerIntent(userMessage: string): WebhookTrigger | null {
  const lower = userMessage.toLowerCase()
  
  // Check if this is webhook trigger intent
  const isWebhookTrigger = (
    /\bwhen\b/i.test(lower) &&
    (/\b(payment|subscription|form|event|webhook)\b/i.test(lower) ||
     /\b(succeeds|fails|submitted|created|updated|deleted|canceled)\b/i.test(lower))
  )
  
  if (!isWebhookTrigger) {
    return null
  }
  
  // Extract provider
  let provider: 'stripe' | 'paddle' | 'generic' = 'generic'
  if (/\bstripe\b/i.test(lower)) provider = 'stripe'
  if (/\bpaddle\b/i.test(lower)) provider = 'paddle'
  if (/\bpayment\b/i.test(lower) || /\bsubscription\b/i.test(lower)) {
    provider = 'stripe'  // Default to Stripe for payments
  }
  
  // Extract external event
  let externalEvent = 'custom.event'
  if (/payment.*?succeed/i.test(lower)) externalEvent = 'payment.succeeded'
  if (/payment.*?fail/i.test(lower)) externalEvent = 'payment.failed'
  if (/subscription.*?creat/i.test(lower)) externalEvent = 'subscription.created'
  if (/subscription.*?cancel/i.test(lower)) externalEvent = 'subscription.canceled'
  if (/form.*?submit/i.test(lower)) externalEvent = 'form.submitted'
  
  // Extract internal action
  let internalAction: any = {
    type: 'update_field',
    targetEntity: 'users',
    targetField: 'status',
    operation: 'set',
    value: 'active'
  }
  
  // Pattern: "unlock premium" → update tier
  if (/unlock|enable|activate.*?(premium|pro|paid)/i.test(lower)) {
    internalAction = {
      type: 'update_field',
      targetEntity: 'users',
      targetField: 'tier',
      operation: 'set',
      value: 'premium'
    }
  }
  
  // Pattern: "create record" → create entity
  if (/create|add.*?(record|entry|item)/i.test(lower)) {
    internalAction = {
      type: 'create_record',
      targetEntity: extractEntityName(lower) || 'records'
    }
  }
  
  // Pattern: "send email" → email action
  if (/send.*?email|email.*?notification/i.test(lower)) {
    internalAction = {
      type: 'send_email',
      targetEntity: 'users'
    }
  }
  
  return {
    id: `wh_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    name: `${externalEvent} → ${internalAction.type}`,
    externalEvent,
    provider,
    internalAction,
    idempotencyKey: provider === 'stripe' ? 'id' : 'event_id',
    retryPolicy: {
      maxAttempts: 3,
      backoffMs: 1000
    },
    _internal: {
      webhookEndpoint: '',  // Set during creation
      webhookSecret: '',    // Set during creation
      totalExecutions: 0,
      failedExecutions: 0
    },
    enabled: true,
    createdAt: new Date()
  }
}

/**
 * Handle external webhook
 * 
 * This is the entry point for all external events
 * Completely invisible to users
 */
export async function handleExternalWebhook(
  projectId: string,
  triggerHash: string,
  event: any,
  signature: string,
  headers: Record<string, string>
): Promise<{ status: number; message: string }> {
  
  // Find trigger by hash
  const trigger = await findTriggerByHash(projectId, triggerHash)
  if (!trigger) {
    console.error(`[Webhook] Trigger not found: ${triggerHash}`)
    return { status: 404, message: 'Trigger not found' }
  }
  
  // Verify signature
  const isValid = await verifyWebhookSignature(
    trigger.provider,
    event,
    signature,
    trigger._internal.webhookSecret
  )
  
  if (!isValid) {
    console.error(`[Webhook] Invalid signature for ${trigger.id}`)
    return { status: 401, message: 'Invalid signature' }
  }
  
  // Extract idempotency key
  const idempotencyKey = extractIdempotencyKey(event, trigger.idempotencyKey)
  if (!idempotencyKey) {
    console.error(`[Webhook] Missing idempotency key: ${trigger.idempotencyKey}`)
    return { status: 400, message: 'Missing idempotency key' }
  }
  
  // Check if already processed
  const existing = await getExecutionLog(projectId, idempotencyKey)
  if (existing?.status === 'success') {
    console.log(`[Webhook] Duplicate event ${idempotencyKey}, skipping`)
    return { status: 200, message: 'Already processed' }
  }
  
  // Execute internal action (with retry)
  try {
    await executeInternalAction(projectId, trigger, event)
    
    // Mark as success
    await logExecution(projectId, idempotencyKey, trigger.id, 'success', 1)
    
    console.log(`[Webhook] Success: ${trigger.externalEvent} → ${trigger.internalAction.type}`)
    return { status: 200, message: 'Processed' }
    
  } catch (error) {
    console.error(`[Webhook] Execution failed:`, error)
    
    // Log failure
    await logExecution(projectId, idempotencyKey, trigger.id, 'failed', 1)
    
    // Schedule retry
    await scheduleWebhookRetry(projectId, trigger, event, 1)
    
    // Return 500 so provider retries
    return { status: 500, message: 'Execution failed, will retry' }
  }
}

/**
 * Execute internal action based on trigger
 */
async function executeInternalAction(
  projectId: string,
  trigger: WebhookTrigger,
  event: any
) {
  const { internalAction } = trigger
  
  switch (internalAction.type) {
    case 'update_field':
      await updateField(projectId, internalAction, event)
      break
      
    case 'create_record':
      await createRecord(projectId, internalAction, event)
      break
      
    case 'state_transition':
      await transitionState(projectId, internalAction, event)
      break
      
    case 'send_email':
      await sendEmail(projectId, internalAction, event)
      break
      
    default:
      throw new Error(`Unknown action type: ${internalAction.type}`)
  }
}

/**
 * Update field in entity
 */
async function updateField(projectId: string, action: any, event: any) {
  // TODO: Execute against project's isolated database
  // UPDATE {targetEntity} SET {targetField} = {value} WHERE {condition}
  console.log(`[Webhook Action] Update ${action.targetEntity}.${action.targetField} = ${action.value}`)
}

/**
 * Create new record
 */
async function createRecord(projectId: string, action: any, event: any) {
  // TODO: Execute against project's isolated database
  // INSERT INTO {targetEntity} (field1, field2) VALUES (val1, val2)
  console.log(`[Webhook Action] Create ${action.targetEntity}`)
}

/**
 * Transition state machine
 */
async function transitionState(projectId: string, action: any, event: any) {
  // TODO: Execute state machine transition
  console.log(`[Webhook Action] Transition ${action.targetEntity}`)
}

/**
 * Send email
 */
async function sendEmail(projectId: string, action: any, event: any) {
  // TODO: Send email via email service
  console.log(`[Webhook Action] Send email to ${action.targetEntity}`)
}

/**
 * Find trigger by hash
 */
async function findTriggerByHash(projectId: string, hash: string): Promise<WebhookTrigger | null> {
  // TODO: Load from BackendStateGraph
  return null
}

/**
 * Verify webhook signature based on provider
 */
async function verifyWebhookSignature(
  provider: string,
  event: any,
  signature: string,
  secret: string
): Promise<boolean> {
  switch (provider) {
    case 'stripe':
      return verifyStripeSignature(event, signature, secret)
    case 'paddle':
      return verifyPaddleSignature(event, signature, secret)
    case 'generic':
      return verifyGenericSignature(event, signature, secret)
    default:
      return false
  }
}

/**
 * Verify Stripe signature
 */
function verifyStripeSignature(event: any, signature: string, secret: string): boolean {
  // TODO: Implement Stripe signature verification
  // Uses crypto.createHmac('sha256', secret)
  return true  // Placeholder
}

/**
 * Verify Paddle signature
 */
function verifyPaddleSignature(event: any, signature: string, secret: string): boolean {
  // TODO: Implement Paddle signature verification
  return true  // Placeholder
}

/**
 * Verify generic HMAC signature
 */
function verifyGenericSignature(event: any, signature: string, secret: string): boolean {
  // TODO: Implement generic HMAC verification
  return true  // Placeholder
}

/**
 * Extract idempotency key from event
 */
function extractIdempotencyKey(event: any, keyName: string): string | null {
  if (typeof event === 'object' && event !== null) {
    return event[keyName] || event.data?.[keyName] || null
  }
  return null
}

/**
 * Get execution log entry
 */
async function getExecutionLog(
  projectId: string,
  idempotencyKey: string
): Promise<any | null> {
  // TODO: Load from project state
  return null
}

/**
 * Log webhook execution
 */
async function logExecution(
  projectId: string,
  idempotencyKey: string,
  triggerId: string,
  status: 'success' | 'failed' | 'retrying',
  attempts: number
) {
  // TODO: Store in project state
  console.log(`[Webhook Log] ${idempotencyKey} → ${status} (${attempts} attempts)`)
}

/**
 * Schedule webhook retry
 */
async function scheduleWebhookRetry(
  projectId: string,
  trigger: WebhookTrigger,
  event: any,
  currentAttempt: number
) {
  if (currentAttempt >= trigger.retryPolicy.maxAttempts) {
    console.error(`[Webhook Retry] Max attempts reached for ${trigger.id}`)
    return
  }
  
  const delayMs = trigger.retryPolicy.backoffMs * Math.pow(2, currentAttempt - 1)
  console.log(`[Webhook Retry] Scheduled retry ${currentAttempt + 1} in ${delayMs}ms`)
  
  // TODO: Schedule retry (could use delayed job system)
}

/**
 * Extract entity name from natural language
 */
function extractEntityName(text: string): string | null {
  const entities = ['users', 'posts', 'comments', 'products', 'orders', 'records', 'items']
  for (const entity of entities) {
    if (text.includes(entity)) {
      return entity
    }
  }
  return null
}
