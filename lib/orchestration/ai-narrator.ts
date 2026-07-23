import { CanonicalIntent } from './types'
import { ExecutionPlan, ExecutionStep } from './execution-plan-generator'
import { ExecutionResult, ExecutionChange } from './atomic-executor'

/**
 * PHASE 11: DIFF-DERIVED NARRATION LAYER (Truth-Preserving PM Voice)
 * 
 * Generates narration EXCLUSIVELY from verified execution diffs.
 * 
 * CRITICAL RULES:
 * 1. Narration CANNOT describe changes that did not occur
 * 2. Pre-narration derives from execution PLAN diff (not raw intent)
 * 3. Post-narration derives from execution RESULT diff
 * 4. NO LLM speculation based on user input
 * 5. NO backend jargon (database, API, schema, etc.)
 * 6. FOCUS on user behavior
 * 
 * This eliminates PM voice hallucination while preserving warmth.
 */

/**
 * Generate narration from execution PLAN (before execution)
 * 
 * CRITICAL: Derives from verified plan steps, not user intent.
 * If execution fails, this narration won't have claimed success.
 */
export function generatePreExecutionNarration(
  intent: CanonicalIntent,
  plan: ExecutionPlan
): string {
  // MANDATORY: Narration is execution-adjacent, not guidance-adjacent
  if (intent.intent_type === 'QUERY' || intent.intent_type === 'ROLLBACK') {
    return ''
  }
  
  // Derive what will change from the execution plan
  const planSummary = summarizePlanChanges(plan)
  
  if (!planSummary) {
    return "Got it. I'll handle that for you now."
  }
  
  // Convert technical plan into behavior-focused language
  return convertPlanToUserBehavior(planSummary)
}

/**
 * Generate narration from execution RESULT (after execution)
 * 
 * CRITICAL: Derives ONLY from verified changes that actually occurred.
 */
export function generatePostExecutionNarration(
  result: ExecutionResult
): string {
  // If execution failed, be honest
  if (!result.success) {
    return "Something didn't work. Nothing was changed."
  }
  
  // If no changes, don't claim changes
  if (result.changes.length === 0) {
    return "Got it. Nothing needed to change."
  }
  
  // Derive what changed from actual execution results
  const changeSummary = summarizeExecutionChanges(result.changes)
  
  return changeSummary || "Here's what changed."
}

/**
 * Summarize execution plan into structured change description
 */
interface PlanSummary {
  tables: string[]      // Table names being created/modified
  auth: string[]        // Auth providers being enabled
  storage: string[]     // Storage buckets being created
  capabilities: string[] // Capabilities being enabled
  policies: string[]    // Policies being applied
}

function summarizePlanChanges(plan: ExecutionPlan): PlanSummary | null {
  const summary: PlanSummary = {
    tables: [],
    auth: [],
    storage: [],
    capabilities: [],
    policies: [],
  }
  
  // Extract changes from plan steps (skip snapshot step)
  for (const step of plan.steps) {
    if (step.action === 'CREATE_SNAPSHOT') continue
    
    switch (step.action) {
      case 'CREATE_TABLE':
      case 'ADD_TABLE_COLUMN':
        if (!summary.tables.includes(step.target)) {
          summary.tables.push(step.target)
        }
        break
        
      case 'UPDATE_AUTH_CONFIG':
        const provider = step.params.provider || 'authentication'
        if (!summary.auth.includes(provider)) {
          summary.auth.push(provider)
        }
        break
        
      case 'CREATE_STORAGE_BUCKET':
        const bucketName = step.params.bucketName || step.target
        if (!summary.storage.includes(bucketName)) {
          summary.storage.push(bucketName)
        }
        break
        
      case 'APPLY_CAPABILITY':
        const capability = step.target || step.params.capability
        if (capability && !summary.capabilities.includes(capability)) {
          summary.capabilities.push(capability)
        }
        break
        
      case 'APPLY_POLICY':
        const policy = step.target || step.params.policyName
        if (policy && !summary.policies.includes(policy)) {
          summary.policies.push(policy)
        }
        break
    }
  }
  
  // If nothing substantive, return null
  const hasChanges = summary.tables.length > 0 || 
                     summary.auth.length > 0 || 
                     summary.storage.length > 0 ||
                     summary.capabilities.length > 0 ||
                     summary.policies.length > 0
  
  return hasChanges ? summary : null
}

/**
 * Convert plan summary into warm, behavior-focused language
 * 
 * CRITICAL: This is DETERMINISTIC - no LLM, no hallucination
 */
function convertPlanToUserBehavior(summary: PlanSummary): string {
  const parts: string[] = []
  
  // Start with acknowledgment
  parts.push("Got it.")
  
  // Describe what users will be able to do
  if (summary.tables.length > 0) {
    const tableNames = summary.tables.map(t => t.toLowerCase().replace(/_/g, ' '))
    if (tableNames.length === 1) {
      parts.push(`Your users will be able to work with ${tableNames[0]}.`)
    } else {
      parts.push(`Your users will be able to work with ${tableNames.join(', ')}.`)
    }
  }
  
  if (summary.auth.length > 0) {
    parts.push(`People will be able to sign in.`)
  }
  
  if (summary.storage.length > 0) {
    parts.push(`People will be able to upload files.`)
  }
  
  if (summary.capabilities.length > 0) {
    const capabilityNames = summary.capabilities.map(c => {
      if (c.includes('email') || c.includes('notification')) return 'send messages'
      if (c.includes('payment') || c.includes('billing')) return 'process payments'
      if (c.includes('job') || c.includes('background')) return 'run background tasks'
      if (c.includes('webhook')) return 'integrate with other services'
      return c.toLowerCase().replace(/_/g, ' ')
    })
    if (capabilityNames.length > 0) {
      parts.push(`Your app will ${capabilityNames[0]}.`)
    }
  }
  
  // Nothing is live yet
  parts.push("Nothing is live yet—I'll show you exactly what changes.")
  
  return parts.join(' ')
}

/**
 * Summarize execution changes into user-friendly language
 * 
 * CRITICAL: Derives ONLY from verified ExecutionChange[] array
 */
function summarizeExecutionChanges(changes: ExecutionChange[]): string {
  if (changes.length === 0) {
    return "Got it. Nothing needed to change."
  }
  
  const created = changes.filter(c => c.action === 'created')
  const modified = changes.filter(c => c.action === 'modified')
  const deleted = changes.filter(c => c.action === 'deleted')
  
  const parts: string[] = []
  
  if (created.length > 0) {
    // Deduplicate tables first
    const tableNames = created
      .filter(c => c.type === 'table')
      .map(c => c.target.toLowerCase().replace(/_/g, ' '))
    const uniqueTables = Array.from(new Set(tableNames))
    
    const apis = created.filter(c => c.type === 'api').length
    const storage = created.filter(c => c.type === 'storage').length
    const auth = created.filter(c => c.type === 'auth').length
    
    if (uniqueTables.length > 0) {
      // Professional summary instead of entity spam
      if (uniqueTables.length === 1) {
        parts.push(`Your ${uniqueTables[0]} system is ready.`)
      } else if (uniqueTables.length === 2) {
        parts.push(`Your ${uniqueTables[0]} and ${uniqueTables[1]} systems are ready.`)
      } else {
        parts.push(`Created ${uniqueTables.length} data systems for your backend.`)
      }
    }
    
    if (auth > 0) {
      parts.push(`People can now sign in.`)
    }
    
    if (storage > 0) {
      parts.push(`File uploads are ready.`)
    }
  }
  
  if (modified.length > 0) {
    parts.push(`I updated how things work behind the scenes.`)
  }
  
  if (deleted.length > 0) {
    parts.push(`I removed what you no longer need.`)
  }
  
  return parts.length > 0 ? parts.join(' ') : "Here's what changed."
}
