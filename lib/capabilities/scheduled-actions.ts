/**
 * SCHEDULED ACTIONS (Time-Based Execution)
 * 
 * Purpose: Let user apps execute time-based logic without managing cron
 * 
 * User says: "Every day, send reminders" or "After 7 days, expire trial"
 * System does: Translates to execution, ensures idempotency, retries
 * 
 * ⚠️ CRITICAL: Users must NEVER see:
 * - Cron expressions
 * - Job queues
 * - Worker processes
 * - Retry configuration
 * - Execution logs
 */

import { BackendStateGraph } from '../orchestration/backend-state-graph'

/**
 * Scheduled action definition
 * Maps time intent to internal actions
 */
export interface ScheduledAction {
  id: string
  name: string                      // User-friendly name
  
  // Time intent
  timeIntent: string                // "daily", "weekly", "after 7 days"
  scheduleType: 'recurring' | 'delayed'
  
  // For recurring schedules
  cronExpression?: string           // Internal only, NEVER shown to users
  
  // For delayed schedules
  delayMs?: number                  // Delay from trigger event
  triggerOn?: string                // Event that starts countdown
  
  // What happens (maps to sideEffects or stateMachines)
  action: {
    type: 'update_field' | 'create_record' | 'state_transition' | 'send_email' | 'cleanup'
    targetEntity: string
    targetField?: string
    operation?: 'set' | 'increment' | 'append' | 'delete'
    value?: any
    condition?: string               // SQL-like condition for filtering
  }
  
  // Idempotency strategy
  idempotencyStrategy: 'per-run' | 'per-record'
  
  // Retry policy
  retryPolicy: {
    maxAttempts: number
    backoffMs: number
  }
  
  // Execution tracking
  _internal: {
    lastRun?: Date
    nextRun?: Date
    totalRuns: number
    failedRuns: number
    recordsProcessed: number
  }
  
  enabled: boolean
  createdAt: Date
}

/**
 * Scheduled action state for project
 */
export interface ScheduledActionState {
  enabled: boolean
  actions: Record<string, ScheduledAction>
  
  // Execution history for idempotency
  executionHistory: Record<string, {
    scheduleId: string
    executionId: string
    timestamp: Date
    status: 'success' | 'failed' | 'running'
    recordsProcessed: number
    duration: number
  }>
  
  reason: string
}

/**
 * Parse scheduled action from natural language
 * 
 * User says: "Every day, send reminders"
 * System generates: Complete scheduled action
 */
export function parseScheduledActionIntent(userMessage: string): ScheduledAction | null {
  const lower = userMessage.toLowerCase()
  
  // Check if this is scheduled action intent
  const isScheduledAction = (
    (/\bevery\b|\bonce\b|\bafter\b/i.test(lower) &&
     /\b(day|week|month|hour|night|morning)\b/i.test(lower)) ||
    /\b(daily|weekly|monthly|nightly)\b/i.test(lower)
  )
  
  if (!isScheduledAction) {
    return null
  }
  
  // Determine schedule type
  let scheduleType: 'recurring' | 'delayed' = 'recurring'
  if (/\bafter\b/i.test(lower)) {
    scheduleType = 'delayed'
  }
  
  // Extract time intent and cron expression
  let timeIntent = 'daily'
  let cronExpression = '0 0 * * *'  // Default: daily at midnight
  let delayMs: number | undefined
  let triggerOn: string | undefined
  
  if (scheduleType === 'recurring') {
    // Recurring schedules
    if (/\bevery\s+day\b|\bdaily\b/i.test(lower)) {
      timeIntent = 'daily'
      cronExpression = '0 0 * * *'
    } else if (/\bevery\s+week\b|\bweekly\b/i.test(lower)) {
      timeIntent = 'weekly'
      cronExpression = '0 0 * * 0'  // Sunday midnight
    } else if (/\bevery\s+month\b|\bmonthly\b/i.test(lower)) {
      timeIntent = 'monthly'
      cronExpression = '0 0 1 * *'  // 1st of month
    } else if (/\bevery\s+hour\b|\bhourly\b/i.test(lower)) {
      timeIntent = 'hourly'
      cronExpression = '0 * * * *'
    } else if (/\bnightly\b|\bevery\s+night\b/i.test(lower)) {
      timeIntent = 'nightly'
      cronExpression = '0 0 * * *'
    }
  } else {
    // Delayed schedules
    const delayMatch = lower.match(/after\s+(\d+)\s+(day|week|month|hour)s?/)
    if (delayMatch) {
      const amount = parseInt(delayMatch[1])
      const unit = delayMatch[2]
      
      switch (unit) {
        case 'day':
          delayMs = amount * 24 * 60 * 60 * 1000
          timeIntent = `after ${amount} days`
          break
        case 'week':
          delayMs = amount * 7 * 24 * 60 * 60 * 1000
          timeIntent = `after ${amount} weeks`
          break
        case 'month':
          delayMs = amount * 30 * 24 * 60 * 60 * 1000
          timeIntent = `after ${amount} months`
          break
        case 'hour':
          delayMs = amount * 60 * 60 * 1000
          timeIntent = `after ${amount} hours`
          break
      }
    }
    
    // Extract trigger event
    if (/signup|sign up|registration|user.*?created/i.test(lower)) {
      triggerOn = 'user.created'
    } else if (/trial|account.*?created/i.test(lower)) {
      triggerOn = 'user.trial_started'
    } else {
      triggerOn = 'record.created'
    }
  }
  
  // Extract action
  let action: any = {
    type: 'send_email',
    targetEntity: 'users',
    condition: 'active = true'
  }
  
  // Pattern: "send reminders/emails"
  if (/send.*?(reminder|email|notification)/i.test(lower)) {
    action = {
      type: 'send_email',
      targetEntity: 'users',
      condition: extractCondition(lower)
    }
  }
  
  // Pattern: "expire trial/subscription"
  if (/expire.*?(trial|subscription|account)/i.test(lower)) {
    action = {
      type: 'state_transition',
      targetEntity: 'users',
      targetField: 'status',
      operation: 'set',
      value: 'expired'
    }
  }
  
  // Pattern: "generate reports"
  if (/generate.*?report/i.test(lower)) {
    action = {
      type: 'create_record',
      targetEntity: 'reports'
    }
  }
  
  // Pattern: "cleanup/delete old"
  if (/cleanup|delete.*?old|remove.*?expired/i.test(lower)) {
    action = {
      type: 'cleanup',
      targetEntity: extractEntityName(lower) || 'records',
      condition: 'created_at < now() - interval \'30 days\''
    }
  }
  
  return {
    id: `sched_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    name: `${timeIntent}: ${action.type}`,
    timeIntent,
    scheduleType,
    cronExpression: scheduleType === 'recurring' ? cronExpression : undefined,
    delayMs: scheduleType === 'delayed' ? delayMs : undefined,
    triggerOn: scheduleType === 'delayed' ? triggerOn : undefined,
    action,
    idempotencyStrategy: scheduleType === 'recurring' ? 'per-run' : 'per-record',
    retryPolicy: {
      maxAttempts: 3,
      backoffMs: 5000
    },
    _internal: {
      totalRuns: 0,
      failedRuns: 0,
      recordsProcessed: 0
    },
    enabled: true,
    createdAt: new Date()
  }
}

/**
 * Execute scheduled action
 * 
 * This is called by the cron runner
 * Completely invisible to users
 */
export async function executeScheduledAction(
  projectId: string,
  scheduleId: string,
  action: ScheduledAction
): Promise<{ success: boolean; recordsProcessed: number }> {
  
  const executionId = `exec_${Date.now()}_${scheduleId}`
  const startTime = Date.now()
  
  console.log(`[Scheduled Action] Starting: ${action.name} (${scheduleId})`)
  
  try {
    // Check idempotency
    if (action.idempotencyStrategy === 'per-run') {
      const today = new Date().toISOString().split('T')[0]
      const idempotencyKey = `${scheduleId}_${today}`
      
      const existing = await getExecutionHistory(projectId, idempotencyKey)
      if (existing?.status === 'success') {
        console.log(`[Scheduled Action] Already executed today: ${scheduleId}`)
        return { success: true, recordsProcessed: 0 }
      }
    }
    
    // Find matching records (if condition specified)
    const records = await findMatchingRecords(projectId, action)
    
    // Process each record
    let processed = 0
    for (const record of records) {
      // Per-record idempotency check
      if (action.idempotencyStrategy === 'per-record') {
        const idempotencyKey = `${scheduleId}_${record.id}`
        const existing = await getExecutionHistory(projectId, idempotencyKey)
        if (existing?.status === 'success') {
          continue  // Already processed this record
        }
        
        await logExecution(projectId, idempotencyKey, scheduleId, executionId, 'running', 0)
      }
      
      // Execute action
      await executeAction(projectId, action, record)
      
      // Log success
      if (action.idempotencyStrategy === 'per-record') {
        const idempotencyKey = `${scheduleId}_${record.id}`
        await logExecution(projectId, idempotencyKey, scheduleId, executionId, 'success', 1)
      }
      
      processed++
    }
    
    // Log execution
    const duration = Date.now() - startTime
    console.log(`[Scheduled Action] Complete: ${action.name} (${processed} records, ${duration}ms)`)
    
    // Update internal stats
    await updateActionStats(projectId, scheduleId, {
      lastRun: new Date(),
      totalRuns: action._internal.totalRuns + 1,
      recordsProcessed: action._internal.recordsProcessed + processed
    })
    
    // Log per-run success
    if (action.idempotencyStrategy === 'per-run') {
      const today = new Date().toISOString().split('T')[0]
      const idempotencyKey = `${scheduleId}_${today}`
      await logExecution(projectId, idempotencyKey, scheduleId, executionId, 'success', processed)
    }
    
    return { success: true, recordsProcessed: processed }
    
  } catch (error) {
    console.error(`[Scheduled Action] Failed: ${action.name}`, error)
    
    // Update stats
    await updateActionStats(projectId, scheduleId, {
      failedRuns: action._internal.failedRuns + 1
    })
    
    // Schedule retry
    await scheduleRetry(projectId, scheduleId, action, 1)
    
    return { success: false, recordsProcessed: 0 }
  }
}

/**
 * Execute action against record
 */
async function executeAction(projectId: string, action: ScheduledAction, record: any) {
  switch (action.action.type) {
    case 'update_field':
      await updateField(projectId, action.action, record)
      break
      
    case 'create_record':
      await createRecord(projectId, action.action, record)
      break
      
    case 'state_transition':
      await transitionState(projectId, action.action, record)
      break
      
    case 'send_email':
      await sendEmail(projectId, action.action, record)
      break
      
    case 'cleanup':
      await cleanupRecord(projectId, action.action, record)
      break
      
    default:
      throw new Error(`Unknown action type: ${action.action.type}`)
  }
}

/**
 * Find records matching condition
 */
async function findMatchingRecords(projectId: string, action: ScheduledAction): Promise<any[]> {
  // TODO: Query project's isolated database
  // SELECT * FROM {targetEntity} WHERE {condition}
  console.log(`[Scheduled Action] Finding records: ${action.action.targetEntity}`)
  return []  // Placeholder
}

/**
 * Update field in record
 */
async function updateField(projectId: string, actionSpec: any, record: any) {
  // TODO: Execute against project's isolated database
  console.log(`[Scheduled Action] Update ${actionSpec.targetEntity}.${actionSpec.targetField}`)
}

/**
 * Create new record
 */
async function createRecord(projectId: string, actionSpec: any, record: any) {
  // TODO: Execute against project's isolated database
  console.log(`[Scheduled Action] Create ${actionSpec.targetEntity}`)
}

/**
 * Transition state
 */
async function transitionState(projectId: string, actionSpec: any, record: any) {
  // TODO: Execute state machine transition
  console.log(`[Scheduled Action] Transition ${actionSpec.targetEntity}`)
}

/**
 * Send email
 */
async function sendEmail(projectId: string, actionSpec: any, record: any) {
  // TODO: Send email via email service
  console.log(`[Scheduled Action] Send email to ${record.email}`)
}

/**
 * Cleanup/delete record
 */
async function cleanupRecord(projectId: string, actionSpec: any, record: any) {
  // TODO: Delete or soft-delete record
  console.log(`[Scheduled Action] Cleanup ${actionSpec.targetEntity}`)
}

/**
 * Get execution history entry
 */
async function getExecutionHistory(projectId: string, idempotencyKey: string): Promise<any | null> {
  // TODO: Load from project state
  return null
}

/**
 * Log execution
 */
async function logExecution(
  projectId: string,
  idempotencyKey: string,
  scheduleId: string,
  executionId: string,
  status: 'success' | 'failed' | 'running',
  recordsProcessed: number
) {
  // TODO: Store in project state
  console.log(`[Scheduled Log] ${idempotencyKey} → ${status} (${recordsProcessed} records)`)
}

/**
 * Update action stats
 */
async function updateActionStats(projectId: string, scheduleId: string, updates: any) {
  // TODO: Update in BackendStateGraph
  console.log(`[Scheduled Stats] ${scheduleId}`, updates)
}

/**
 * Schedule retry
 */
async function scheduleRetry(
  projectId: string,
  scheduleId: string,
  action: ScheduledAction,
  currentAttempt: number
) {
  if (currentAttempt >= action.retryPolicy.maxAttempts) {
    console.error(`[Scheduled Retry] Max attempts reached for ${scheduleId}`)
    return
  }
  
  const delayMs = action.retryPolicy.backoffMs * Math.pow(2, currentAttempt - 1)
  console.log(`[Scheduled Retry] Retry ${currentAttempt + 1} in ${delayMs}ms`)
  
  // TODO: Schedule retry execution
}

/**
 * Extract condition from natural language
 */
function extractCondition(text: string): string {
  // Pattern: "users who haven't logged in"
  if (/haven't|not.*?logged in|inactive/i.test(text)) {
    return 'last_login < now() - interval \'24 hours\''
  }
  
  // Pattern: "expired trials"
  if (/expired|past due/i.test(text)) {
    return 'status = \'expired\''
  }
  
  // Default: active records
  return 'active = true'
}

/**
 * Extract entity name from natural language
 */
function extractEntityName(text: string): string | null {
  const entities = ['users', 'posts', 'comments', 'products', 'orders', 'records', 'files', 'sessions']
  for (const entity of entities) {
    if (text.includes(entity)) {
      return entity
    }
  }
  return null
}
