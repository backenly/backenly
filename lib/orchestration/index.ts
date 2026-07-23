/**
 * Backenly AI Orchestration Engine
 * 
 * Complete 9-phase system for production-grade, safer-than-Replit backend mutations.
 * 
 * This is the moat.
 */

// Observability Layer (Phase 4)
import { 
  logger, 
  withRequestContext, 
  getCurrentRequestId,
  recordDbQuery,
  recordError 
} from '@/lib/observability'

// Phase 1: Intent Canonicalization
export {
  parseIntent,
  validateIntent,
} from './intent-parser'
export {
  type CanonicalIntent,
  type IntentType,
  type Domain,
  type Action,
} from './types'

// Phase 2: Backend State Graph
export {
  createEmptyGraph,
  addEntity,
  addField,
  removeEntity,
  findReason,
  findDependencies,
  type BackendStateGraph,
  type EntityState,
  type FieldState,
  type RelationshipState,
  type AuthState,
  type StorageState,
  type ApiState,
} from './backend-state-graph'

// Phase 3: Intent Safety Validator
export {
  validateIntentSafety,
  detectIntentConflict,
  type SafetyValidationResult,
  type SafetyViolation,
  type ViolationType,
} from './intent-safety-validator'

// Phase 3.2: Structured Intent Schema Validation (CRITICAL GATEWAY)
export {
  validateStructuredIntent,
  isValidStructuredIntent,
  validateIntentBatch,
  migrateToStructuredIntent,
  type StructuredIntent,
  type ValidatedField,
  type ValidatedRelationship,
  type ValidationResult,
  type ValidationSuccess,
  type ValidationFailure,
} from './intent-validation'

// Phase 3.3: Execution Engine Invariants (RELIABILITY MOAT)
export {
  validateAllInvariants,
  validateInvariantsIfEnabled,
  assertGraphImmutability,
  assertAtomicMutation,
  assertSinglePointerSwap,
  assertVersionLineage,
  assertConcurrencySafety,
  assertReferentialIntegrity,
  assertStateConsistency,
  createExecutionContext,
  InvariantViolationError,
  type ExecutionContext,
  STRICT_INVARIANTS,
} from './execution-invariants'

// Phase 3.4: AI Context Security (DATA PRIVACY MOAT)
export {
  sanitizeAIContext,
  enforceSchemaOnlyContext,
  quickDataCheck,
  type SanitizedContext,
} from '@/lib/ai/context-sanitizer'

// Phase 3.5: Schema Invariant Validator (CRITICAL PRODUCTION SAFETY)
export {
  validateSchemaInvariants,
  isIntentSafe,
  getViolationSummary,
  type InvariantViolation,
  type InvariantValidationResult,
} from './schema-invariant-validator'

// Phase 4: Execution Plan Generator
export {
  generateExecutionPlan,
  validatePlan,
  type ExecutionPlan,
  type ExecutionStep,
  type StepAction,
  type RollbackStep,
} from './execution-plan-generator'

// Phase 5: Dry-Run Simulator
export {
  runDryRun,
  type DryRunResult,
  type SimulatedChange,
  type SimulationFailure,
  type ApiDiff,
  type MigrationSummary,
} from './dry-run-simulator'

// Phase 6: Atomic Executor
export {
  executeAtomic,
  type ExecutionResult,
  type ExecutedStep,
  type ExecutionChange,
} from './atomic-executor'

// Phase 7: Silent Migration
export {
  generateMigrationStrategy,
  executeMigration,
  scheduleCleanup,
  type MigrationStrategy,
  type MigrationPhase,
  type MigrationStep,
  type MigrationAction,
  type DataPreservationPlan,
  type CleanupTask,
} from './silent-migration'

// Phase 8: Trust Timeline
export {
  generateTimelineEntry,
  generateTimelineSummary,
  formatTimelineForDisplay,
  generateRollbackEntry,
  type TimelineEntry,
  type TimelineCategory,
  type TimelineDetail,
} from './trust-timeline'

// Phase 9: Advanced View Projection
export {
  projectAdvancedView,
  validateAdvancedViewMutation,
  generateAdvancedViewSummary,
  formatStorageUsage,
  formatUptime,
  getTableSchemaText,
  getApiDetailsText,
  exportAdvancedView,
  detectBypassAttempt,
  type AdvancedView,
  type TableProjection,
  type FieldProjection,
  type ApiProjection,
  type AuthProjection,
  type MonitoringProjection,
} from './advanced-view-projection'

// Phase 11: Diff-Derived PM Narration (Truth-Preserving)
export {
  generatePreExecutionNarration,
  generatePostExecutionNarration,
} from './ai-narrator'

/**
 * Complete orchestration flow
 * 
 * This is how Backenly processes every user intent:
 * 
 * 1. Parse intent (natural language → canonical object)
 * 2. Load backend state graph
 * 3. Validate safety (block dangerous changes)
 * 4. Generate execution plan (deterministic steps)
 * 5. Run dry-run simulation (catch failures)
 * 6. Execute atomically (all or nothing)
 * 7. Handle migrations silently (zero user awareness)
 * 8. Generate timeline entry (plain English)
 * 9. Project to advanced view (read-only transparency)
 */

import { parseIntent, validateIntent } from './intent-parser'
import { isStructurallyEqual } from './graph-diff'
import { classifyMutation, shouldUseIncrementalMode, type MutationIntent } from './mutation-classifier'
import { CanonicalIntent } from './types'
import { BackendStateGraph, createEmptyGraph, addField } from './backend-state-graph'
import { validateIntentSafety } from './intent-safety-validator'
import { generateExecutionPlan, validatePlan } from './execution-plan-generator'
import { runDryRun } from './dry-run-simulator'
import { executeAtomic, ExecutionResult, ExecutionChange } from './atomic-executor'
import { executeReal } from '@/lib/execution/real-executor'
import { generateMigrationStrategy, executeMigration } from './silent-migration'
import { generateTimelineEntry, TimelineEntry } from './trust-timeline'
import { projectAdvancedView, AdvancedView } from './advanced-view-projection'
import { logIntentExecution, saveProjectState, getLastSuccessfulIntent } from './project-scoped-state'
import { createOrchestrationContext } from '@/lib/context/execution-context'
import { recordIntentLineage } from '@/lib/testing/intent-lineage-hash'
import { explainDecision } from './ai-assistant'
import { generatePreExecutionNarration, generatePostExecutionNarration } from './ai-narrator'
import { converseWithUser, generatePostExecutionSummary, shouldBlockAIConversation } from './ai-conversation'
import { BatchPlan } from './batch-planner'
import { prisma } from '@/lib/db/prisma'

// STATIC IMPORTS FOR ORCHESTRATION SUB-COMPONENTS (ELIMINATE DYNAMIC IMPORTS)
import { inferEntities, needsEntityInference, validateInferredEntities } from './entity-inference'
import { normalizeEntities } from './schema-normalizer'
import { evaluateConfidence } from './confidence-evaluator'
import { analyzeInfrastructureImpact } from '../impact-analysis'
import { generateIntegrationOptions } from './integration-planner'
import { shouldUseBatchMode, parseBatchPlan, batchPlanToIntents, createBatchPlanFromNormalizedEntities } from './batch-planner'
import { getActiveGraph, isProjectLive, saveNewGraph, createInitialGraph } from './graph-pointer'

// Smart Relationship Inference - "Bolt/Cursor quality" UX
import {
  inferRelationshipsForNewTable,
  generateSuggestionMessage,
  type RelationshipInferenceResult
} from './smart-relationship-inference'

// Lightweight LLM prompts + small heuristics (NOT heavy rule engines)
import {
  getArchitectSystemPrompt,
  suggestRelationshipHeuristic,
  getFeaturePattern,
  buildWorkspaceContext
} from '@/lib/ai/system-prompts'

import { classifyIntent, isObviousBuildCommand, IntentType } from './intent-classifier'

function buildPromptFromNormalizedEntities(entities: any[]): string {
  const entityDescriptions = entities.map(entity => {
    const fieldDescriptions = entity.fields
      .filter((f: any) => f.name !== 'id' && f.name !== 'created_at' && f.name !== 'updated_at')
      .map((field: any) => {
        if (field.type === 'relation') {
          return `${field.name} (relation to ${field.relationTo})`
        }
        const modifiers = []
        if (field.required) modifiers.push('required')
        if (field.unique) modifiers.push('unique')
        const modStr = modifiers.length > 0 ? ` (${modifiers.join(', ')})` : ''
        return `${field.name}: ${field.type}${modStr}`
      })
      .join(', ')
    
    return `Create a ${entity.name} table with fields: ${fieldDescriptions}`
  }).join('. ')
  
  return entityDescriptions
}

function generateFieldPreservationProposal(normalizedEntities: any[]): string {
  const parts: string[] = []
  
  if (normalizedEntities.length === 1) {
    parts.push(`I'll create a **${normalizedEntities[0].name}** table.`)
  } else {
    const entityNames = normalizedEntities.map(e => `**${e.name}**`).join(', ')
    parts.push(`I'll create ${normalizedEntities.length} tables: ${entityNames}.`)
  }
  
  for (const entity of normalizedEntities) {
    const meaningfulFields = entity.fields.filter((f: any) => 
      f.name !== 'id' && f.name !== 'created_at' && f.name !== 'updated_at'
    )
    
    if (meaningfulFields.length > 0) {
      const fieldDescriptions = meaningfulFields.map((f: any) => {
        if (f.type === 'relation') {
          return `${f.name} (linked to ${f.relationTo})`
        }
        return `${f.name} (${f.type})`
      }).join(', ')
      
      parts.push(`\n**${entity.name}** will include: ${fieldDescriptions}`)
    }
  }
  
  parts.push('\n**Proceed with this structure?** Or tell me what should change.')
  
  return parts.join('\n')
}

function generateDomainLockRefusal(userMessage: string, batchPlan: any): string {
  const baseMessage = "I can't build features yet because I don't know what your app does. Please describe what users do in your app first."
  const examples = [
    "I'm building a SaaS where users create projects",
    "Users can post articles and comment on them",
    "I'm building a booking platform where users schedule appointments"
  ]
  const exampleList = examples.map(e => `• ${e}`).join('\n')
  return `${baseMessage}\n\nFor example:\n${exampleList}`
}
import { recordSchemaChange } from '@/lib/architecture-memory'
import { analyzeSchemaEvolution } from '@/lib/schema-evolution'
import { generateProactiveSuggestions } from '@/lib/autonomous-guidance'
import { generateSuggestions, storeSuggestions } from '@/lib/suggestions'
import { connectFrontend, disconnectFrontend } from '@/lib/services/connectFrontend'
import { getPreviousGraphId, undoToGraph } from './graph-pointer'
import { understandSemanticIntent as semanticUnderstanding } from './semantic-understanding'
import { normalizeTypos } from './typo-normalizer'
import { inferInteractionGraph } from '../flow-reasoning'
import { recordBackendExecutionMemory } from '@/lib/operational-memory/ledger'

// ============================================================================
// INTEGRATION MODE: In-Memory Graph History Store
// ============================================================================
// ⚠️ CRITICAL: This Map is ONLY for integration tests. NEVER use in production.
// Integration tests must NOT persist to database. Keep graph history in memory.
// Map<projectId, BackendStateGraph[]> where array is chronological history
// index 0 = genesis, last index = current active graph
export const integrationGraphStore = new Map<string, BackendStateGraph[]>()

/**
 * Safety guard: Ensure integration graph store is never accessed in production
 */
function getIntegrationGraphStore(): Map<string, BackendStateGraph[]> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CRITICAL: integrationGraphStore must NEVER be used in production. Use database-backed graph storage only.')
  }
  return integrationGraphStore
}

// ============================================================================
// RATE LIMITING (OPERATIONAL HARDENING)
// ============================================================================
// Distributed database-backed rate limiting for horizontal scalability
// Multi-instance safe, no in-memory state, automatic TTL via time windows

interface RateLimitConfig {
  projectLimit: number    // Mutations per minute per project
  userLimit: number       // Mutations per minute per user
  burstAllowance: number  // Extra mutations allowed as burst
  windowMs: number        // Time window in milliseconds
}

const RATE_LIMIT_CONFIG: RateLimitConfig = {
  projectLimit: 30,      // 30 mutations per minute per project
  userLimit: 60,         // 60 mutations per minute per user (across all projects)
  burstAllowance: 5,     // 5 extra mutations as burst
  windowMs: 60000,       // 1 minute window
}

interface RateLimitResult {
  allowed: boolean
  retryAfter?: number
  limitType?: 'project' | 'user'
  remaining?: number
}

/**
 * Check rate limit using database-backed storage
 * Multi-instance safe: uses database as single source of truth
 * 
 * @param projectId - Project being mutated
 * @param userId - User making the request (optional, for per-user limits)
 * @returns Rate limit check result
 */
async function checkRateLimit(
  projectId: string,
  userId?: string
): Promise<RateLimitResult> {
  // Disable rate limiting in test/integration mode
  if (process.env.NODE_ENV === 'test' || process.env.ENGINE_MODE === 'integration') {
    return { allowed: true }
  }
  
  const now = Date.now()
  const windowStart = new Date(now - (now % RATE_LIMIT_CONFIG.windowMs))
  
  try {
    // Check project-level rate limit
    const projectMutationCount = await prisma.intentLog.count({
      where: {
        projectId,
        timestamp: { gte: windowStart },
        success: true, // Only count successful mutations
      },
    })
    
    const projectLimit = RATE_LIMIT_CONFIG.projectLimit + RATE_LIMIT_CONFIG.burstAllowance
    
    if (projectMutationCount >= projectLimit) {
      const retryAfter = Math.ceil((RATE_LIMIT_CONFIG.windowMs - (now % RATE_LIMIT_CONFIG.windowMs)) / 1000)
      return { 
        allowed: false, 
        retryAfter,
        limitType: 'project',
        remaining: 0,
      }
    }
    
    // Check user-level rate limit (if userId provided)
    if (userId) {
      const userMutationCount = await prisma.intentLog.count({
        where: {
          timestamp: { gte: windowStart },
          success: true,
          // Note: intentLog doesn't have userId field directly
          // This would require adding userId to intentLog schema
          // For now, we skip user-level limiting
        },
      })
      
      // User limit check placeholder - requires schema change
      // const userLimit = RATE_LIMIT_CONFIG.userLimit + RATE_LIMIT_CONFIG.burstAllowance
      // if (userMutationCount >= userLimit) { ... }
    }
    
    return { 
      allowed: true,
      remaining: projectLimit - projectMutationCount - 1,
    }
  } catch (error) {
    // Fail open if database is unavailable - don't block mutations due to rate limiter failure
    console.error('[Rate Limit] Database error, failing open:', error)
    return { allowed: true }
  }
}

/**
 * Get graph history for integration mode (simulates Prisma backendGraph.findMany)
 * Returns array of graph snapshots with sequence numbers for undo support
 */
export function getIntegrationGraphHistory(projectId: string): Array<{ id: string; graphData: BackendStateGraph; sequenceNumber: number }> {
  const history = integrationGraphStore.get(projectId) || []
  return history.map((graph, index) => ({
    id: `integration-graph-${projectId}-${index}`,
    graphData: graph,
    sequenceNumber: index + 1,
  })).reverse() // Most recent first (desc order like Prisma)
}

/**
 * DOMAIN VERBS: Actions that define what users DO in the domain
 * These indicate explicit domain declaration
 * 
 * RISK MITIGATION: Synonym Drift (Acceptable)
 * - If a synonym like "build" is used but not in this list, system will refuse
 * - This is GOOD: forces clarity and predictability
 * - List can be safely extended later without breaking existing behavior
 * - Common synonyms included for better UX
 */
const DOMAIN_VERBS = [
  // Core creation verbs
  'create', 'make', 'build', 'generate',
  // Content verbs
  'write', 'publish', 'post', 'compose',
  // Management verbs
  'manage', 'organize', 'track', 'monitor',
  // Sharing/collaboration verbs
  'share', 'collaborate', 'contribute',
  // Action verbs
  'upload', 'submit', 'send', 'deliver',
  // Scheduling verbs
  'book', 'schedule', 'reserve', 'plan'
]

/**
 * FEATURE VERBS: Technical/infrastructure actions that DON'T define domain
 * These NEVER unlock domain - they describe features, not the core app purpose
 */
const FEATURE_VERBS = [
  'pay', 'subscribe', 'summarize',
  'notify', 'email', 'charge',
  'integrate', 'sync', 'enable',
  'add', 'setup', 'configure'
]

/**
 * Detect if user prompt provides explicit domain declaration
 * 
 * DOMAIN LOCK INVARIANT:
 * A prompt is a domain declaration ONLY if it contains:
 * 1. Actor (users/admins/customers)
 * 2. Domain verb (create/write/upload/manage/post)
 * 3. Concrete noun (projects/posts/documents/bookings)
 * 
 * EXAMPLES:
 * ✅ "I'm building a SaaS where users create projects" → DOMAIN DECLARED
 * ✅ "Users can post articles and comment on them" → DOMAIN DECLARED
 * ✅ "Users create projects and tasks" → DOMAIN DECLARED (compound, both entities created)
 * ❌ "Enable subscriptions so users can pay monthly" → FEATURE REQUEST (feature verb: pay)
 * ❌ "Add payment subscription feature" → FEATURE REQUEST (feature verb: add)
 * ❌ "Use OpenAI to summarize content" → FEATURE REQUEST (feature verb: summarize)
 * 
 * RISK MITIGATION: Compound Domain Declarations
 * - "Users create projects and tasks" may create both entities OR ask for clarification
 * - Both outcomes are acceptable and don't violate the invariant
 * - Batch planner handles the entity parsing
 * - This function only validates that domain IS declared (not feature-only)
 */
function detectExplicitDomainDeclaration(userMessage: string, batchPlan: BatchPlan): boolean {
  const lower = userMessage.toLowerCase()
  
  // REQUIREMENT 1: Must contain explicit domain declaration phrases
  const domainDeclarationPhrases = [
    'i am building',
    'i want to build',
    'i need a',
    'create a platform',
    'build a platform',
    'platform for',
    'system for',
    'app for',
    'where users',
    'where people',
    'lets users',
    'allows users',
  ]
  
  const hasDeclarationPhrase = domainDeclarationPhrases.some(phrase => lower.includes(phrase))
  
  // REQUIREMENT 2: Must contain DOMAIN VERB (not feature verb)
  const hasDomainVerb = DOMAIN_VERBS.some(verb => {
    // Check for "users [verb]" pattern
    return lower.includes(`users ${verb}`) || 
           lower.includes(`user ${verb}`) ||
           lower.includes(`people ${verb}`) ||
           lower.includes(`customers ${verb}`)
  })
  
  // REQUIREMENT 3: Must NOT be a feature-only request
  const hasOnlyFeatureVerbs = FEATURE_VERBS.some(verb => lower.includes(verb)) &&
                               !DOMAIN_VERBS.some(verb => lower.includes(verb))
  
  if (hasOnlyFeatureVerbs) {
    console.log('[Domain Lock] ❌ Feature-only request detected, domain NOT declared:', {
      featureVerbs: FEATURE_VERBS.filter(v => lower.includes(v)),
      domainVerbs: DOMAIN_VERBS.filter(v => lower.includes(v)),
    })
    return false
  }
  
  // Domain is declared if: has declaration phrase AND has domain verb
  const isDomainDeclared = hasDeclarationPhrase && hasDomainVerb
  
  if (isDomainDeclared) {
    console.log('[Domain Lock] ✅ DOMAIN DECLARED:', {
      declarationPhrase: domainDeclarationPhrases.find(p => lower.includes(p)),
      domainVerb: DOMAIN_VERBS.find(v => lower.includes(`users ${v}`)),
      entities: batchPlan.entities.map(e => e.name),
    })
  } else {
    console.log('[Domain Lock] ❌ Domain NOT declared:', {
      hasDeclarationPhrase,
      hasDomainVerb,
      prompt: userMessage.substring(0, 100),
    })
  }
  
  return isDomainDeclared
}

/**
 * DEPRECATED: Old heuristic-based detection
 * Replaced by mechanical detectExplicitDomainDeclaration
 */
function detectExplicitDomainContext(userMessage: string, batchPlan: BatchPlan): boolean {
  const lower = userMessage.toLowerCase()
  
  // Check 1: Does prompt explicitly describe what users DO?
  // These phrases indicate domain definition, not just feature requests
  const domainContextPhrases = [
    'i am building',
    'i want to build',
    'i need a',
    'create a platform',
    'build a platform',
    'users can',
    'users create',
    'users manage',
    'users share',
    'users write',
    'users post',
    'users upload',
    'users book',
    'users track',
    'platform for',
    'system for',
    'app for',
    'where users',
    'where people',
    'lets users',
    'allows users',
  ]
  
  const hasExplicitPhrasing = domainContextPhrases.some(phrase => lower.includes(phrase))
  
  // Check 2: Does prompt mention core entities explicitly with context?
  // "users" alone is not enough - need "users create X" or "users manage Y"
  const hasActionableEntityDescription = domainContextPhrases.some(phrase => lower.includes(phrase))
  
  // Check 3: Feature-only keywords (payments, notifications, etc) without domain
  const featureOnlyKeywords = [
    'payment',
    'subscription',
    'notification',
    'email',
    'integration',
    'openai',
    'stripe',
    'authentication',
  ]
  
  const isFeatureOnlyRequest = featureOnlyKeywords.some(keyword => lower.includes(keyword))
  
  // Check 4: Passive mention of "users" without defining what they do
  // "Enable subscriptions so users can pay" = NO context (what do users DO in the app?)
  // "Users create projects" = YES context (explicit behavior)
  const passiveUserMention = lower.includes('users') || lower.includes('user')
  const hasExplicitUserBehavior = [
    'users create',
    'users manage',
    'users share',
    'users write',
    'users post',
    'users upload',
    'users book',
    'users track',
  ].some(phrase => lower.includes(phrase))
  
  // Check 5: Vague entity nouns that need definition on empty projects
  // "content", "items", "data" etc. are meaningless without context
  const vagueEntityNouns = ['content', 'items', 'data', 'information', 'things', 'stuff']
  const hasVagueEntity = vagueEntityNouns.some(noun => lower.includes(noun))
  
  // Check 6: Financial actions that DON'T define domain
  // "users can pay" describes FEATURE behavior, not domain behavior
  const financialActions = ['pay', 'subscribe', 'billing', 'charge', 'purchase']
  const hasFinancialAction = financialActions.some(action => {
    // Match patterns like "users can pay", "users pay", "so users can pay"
    return lower.includes(`can ${action}`) || 
           lower.includes(`to ${action}`) ||
           lower.includes(`users ${action}`)
  })
  
  // REFUSAL LOGIC 1: Feature-only requests WITHOUT domain definition
  if (isFeatureOnlyRequest) {
    if (!hasExplicitPhrasing && !hasExplicitUserBehavior) {
      console.log('[Refusal Check] Feature request without explicit domain behavior:', {
        featureDetected: featureOnlyKeywords.filter(k => lower.includes(k)),
        hasPassiveUserMention: passiveUserMention,
        hasExplicitBehavior: hasExplicitUserBehavior,
        hasFinancialAction,
        entitiesInferred: batchPlan.entities.map(e => e.name),
      })
      return false
    }
  }
  
  // REFUSAL LOGIC 2: Vague entities on empty project
  // If user mentions "content" or "items" but doesn't say what they ARE
  if (hasVagueEntity && !hasExplicitPhrasing) {
    console.log('[Refusal Check] Vague entity without definition:', {
      vagueEntity: vagueEntityNouns.find(n => lower.includes(n)),
      entitiesInferred: batchPlan.entities.map(e => e.name),
    })
    return false
  }
  
  // REFUSAL LOGIC 3: Financial actions without domain context
  // "Enable subscriptions so users can pay" = describes feature, not domain
  if (hasFinancialAction && !hasExplicitPhrasing && !hasExplicitUserBehavior) {
    console.log('[Refusal Check] Financial action without domain context:', {
      financialAction: financialActions.find(a => lower.includes(a)),
      hasPassiveUserMention: passiveUserMention,
    })
    return false
  }
  
  // Allow if user explicitly described domain behavior
  return hasExplicitPhrasing || hasExplicitUserBehavior
}



/**
 * DEPRECATED: Old heuristic-based refusal generation
 * Replaced by mechanical generateDomainLockRefusal
 */
function generateContextRefusalMessage(userMessage: string, batchPlan: BatchPlan): string {
  const lower = userMessage.toLowerCase()
  
  // Detect what feature they're asking for and provide targeted guidance
  
  // Case 1: Payment/Subscription features
  if (lower.includes('payment') || lower.includes('subscription') || lower.includes('billing') || lower.includes('pay')) {
    return "I can't set up payments yet because I don't know what your app does. Could you tell me: What are users doing in your app? For example: 'I'm building a SaaS where users create projects' or 'Users can post articles and comment on them'."
  }
  
  // Case 2: AI/Content features with vague entities
  if (lower.includes('openai') || lower.includes('ai') || lower.includes('summarize')) {
    if (lower.includes('content')) {
      return "I can't add AI features yet because 'content' isn't defined. What kind of content do users work with in your app? For example: 'Users write blog posts' or 'Users upload documents and presentations'."
    }
    return "I can't add AI features yet because I need to understand your app first. What do users create or manage? For example: 'Users write articles' or 'Users upload videos'."
  }
  
  // Case 3: Notifications
  if (lower.includes('notification') || lower.includes('email')) {
    return "I can't set up notifications yet. Could you tell me what your app does first? For example: 'I'm building a task manager where users create tasks' or 'Users can book appointments'."
  }
  
  // Case 4: Integrations
  if (lower.includes('integration')) {
    return "I can't add integrations yet because I don't know what your app does. Could you describe what users do in your app? For example: 'Users manage inventory' or 'Users track expenses'."
  }
  
  // Case 5: Vague entity nouns
  if (lower.includes('content') || lower.includes('items') || lower.includes('data')) {
    const vagueEntity = lower.includes('content') ? 'content' : lower.includes('items') ? 'items' : 'data'
    return `I can't build features around '${vagueEntity}' yet because it's not defined. What kind of ${vagueEntity} exists in your app? For example: 'Users create blog posts' or 'Users manage product listings'.`
  }
  
  // Generic refusal
  return "I need to understand your app before I can add features. Could you tell me what users do in your app? For example: 'I'm building a platform where users can X' or 'Users create and manage Y'."
}

export interface OrchestrationResult {
  success: boolean
  message: string
  timeline: TimelineEntry
  executionResult?: ExecutionResult
  advancedView?: AdvancedView
  errors?: string[]
  suggestions?: string[] // Behavioral suggestions for guidance
  intent?: CanonicalIntent // Pass intent to frontend for commitment handling
  requiresCommitment?: boolean // NEW: Signals frontend to show "Build now" confirmation
  requiresClarification?: boolean // NEW: Signals frontend that context is missing
  clarificationQuestion?: string // NEW: Question to ask user for LOW confidence
  integrationOptions?: any[] // NEW: Architectural options for AWAITING_ARCH_DECISION
  inferenceMetadata?: any // NEW: Metadata from entity inference for transparency
  semanticUnderstanding?: any // NEW: Semantic context for clarification flow
  confidence?: string // NEW: Confidence level (HIGH/MEDIUM/LOW)
  evolutionReport?: any // Elite Agent Phase 4: Schema quality analysis
  impactReport?: any // Elite Agent Phase 5: Infrastructure impact prediction
  interactionGraph?: any // Elite Agent Phase 3: Actor/interaction modeling
  relationshipSuggestions?: RelationshipInferenceResult[] // Smart relationship suggestions (non-blocking)
  narration?: {
    pre?: string
    post?: string
  }
  // Structured build summary for professional UI rendering
  buildSummary?: {
    summary: string // Clean human-readable summary
    entities: string[] // Deduplicated entity names
    capabilities: string[] // Enabled capabilities
  }
  // DRAFT-FIRST: Proposed entities with reasoning (for PREVIEW mode)
  proposedEntities?: any[] // Normalized entities AI proposes to create
  assumptions?: string[] // Explicit assumptions AI made (e.g., "Users exist in the system")
  // BLACK-BOX TEST REQUIREMENT: Machine-verifiable execution state
  executionState?: 'PREVIEW' | 'EXECUTED' | 'REFUSED' | 'CLARIFICATION_NEEDED' | 'AWAITING_CONFIRMATION' | 'AWAITING_ARCH_DECISION' // Makes test outcomes deterministic
  refusalReason?: 'INSUFFICIENT_DOMAIN_CONTEXT' | 'ANTI_PATTERN_BLOCKED' | 'SECRETS_FORBIDDEN' | 'SAFETY_VIOLATION' | 'INPUT_TOO_LARGE' | 'RATE_LIMIT_EXCEEDED' // Explicit refusal type
  // Action plan for build commands (makes AI feel intelligent)
  actionPlan?: {
    summary: string
    steps: string[]
    estimatedTime: string
  }
}

/**
 * Convert mutation intent to execution plan
 */
async function convertMutationToExecutionPlan(
  mutation: MutationIntent,
  graph: BackendStateGraph,
  projectId: string
): Promise<any> {
  const planId = `mutation_${Date.now()}`
  const steps: any[] = []
  
  switch (mutation.type) {
    case 'ADD_FIELD':
      steps.push({
        stepId: `${planId}_add_field`,
        order: 1,
        action: 'ADD_TABLE_COLUMN',
        target: mutation.entity,
        params: {
          columnName: mutation.field!.name,
          columnType: mutation.field!.type || 'TEXT',
          nullable: !mutation.field!.required,
        },
        description: `Add ${mutation.field!.name} field to ${mutation.entity}`,
        dependencies: [],
        reversible: true,
        estimatedTime: 1,
      })
      break
      
    case 'REMOVE_FIELD':
      steps.push({
        stepId: `${planId}_remove_field`,
        order: 1,
        action: 'DROP_COLUMN',
        target: mutation.entity,
        params: {
          columnName: mutation.field!.name,
        },
        description: `Remove ${mutation.field!.name} field from ${mutation.entity}`,
        dependencies: [],
        reversible: true,
        estimatedTime: 1,
      })
      break
      
    case 'CHANGE_FIELD_TYPE':
      steps.push({
        stepId: `${planId}_change_field_type`,
        order: 1,
        action: 'ALTER_COLUMN',
        target: mutation.entity,
        params: {
          columnName: mutation.field!.name,
          newType: mutation.field!.type,
        },
        description: `Change ${mutation.field!.name} type to ${mutation.field!.type} in ${mutation.entity}`,
        dependencies: [],
        reversible: true,
        estimatedTime: 1,
      })
      break
      
    case 'ADD_UNIQUE_CONSTRAINT':
      steps.push({
        stepId: `${planId}_add_unique_constraint`,
        order: 1,
        action: 'ADD_UNIQUE_CONSTRAINT',
        target: mutation.entity,
        params: {
          fieldName: mutation.field!.name,
        },
        description: `Add unique constraint on ${mutation.entity}.${mutation.field!.name}`,
        dependencies: [],
        reversible: true,
        estimatedTime: 1,
      })
      break
      
    case 'RENAME_ENTITY':
      steps.push({
        stepId: `${planId}_rename_entity`,
        order: 1,
        action: 'RENAME_TABLE',
        target: mutation.entity,
        params: {
          newName: mutation.field!.name,
        },
        description: `Rename ${mutation.entity} to ${mutation.field!.name}`,
        dependencies: [],
        reversible: true,
        estimatedTime: 2,
      })
      break
      
    case 'REMOVE_TABLE':
      steps.push({
        stepId: `${planId}_drop_table`,
        order: 1,
        action: 'DROP_TABLE',
        target: mutation.entity,
        params: {
          cascade: true,
        },
        description: `Remove ${mutation.entity} table`,
        dependencies: [],
        reversible: true,
        estimatedTime: 2,
      })
      break
  }
  
  return {
    planId,
    steps,
    intent: {
      type: 'FEATURE_ADD',
      feature: mutation.rawIntent,
      confidence: mutation.confidence,
    },
    graph,
    projectId,
  }
}

/**
 * Phase 1: Resolve pronouns in user message using recent conversation history.
 * e.g. "add a bio field to it" → "add a bio field to profile_pictures"
 */
function resolveMessageWithHistory(
  userMessage: string,
  history: Array<{ role: 'user' | 'ai'; content: string }>
): string {
  if (!history || history.length === 0) return userMessage

  const lower = userMessage.toLowerCase()
  // Only resolve if message contains a pronoun reference
  const hasPronouns = /\b(it|that|the table|the one|the last one|this table)\b/i.test(lower)
  if (!hasPronouns) return userMessage

  // Extract the most recently mentioned table name from the AI's last response
  const lastAiMessage = [...history].reverse().find(h => h.role === 'ai')?.content || ''
  const tableMatches = lastAiMessage.match(/\b(created|added|built|table(?:s)?)[:\s]+([a-z_]+)/gi)
  if (!tableMatches) return userMessage

  // Get the last table name mentioned
  const lastTableMatch = tableMatches[tableMatches.length - 1]
  const tableNameMatch = lastTableMatch.match(/([a-z_]+)$/)
  if (!tableNameMatch) return userMessage

  const tableName = tableNameMatch[1]
  // Replace the pronoun with the actual table name
  return userMessage.replace(/\b(it|that table|the table|the one|the last one|this table)\b/gi, tableName)
}

/**
 * Master orchestration function
 *
 * Takes user message → returns complete result
 *
 * @param forceCommit - If true, bypass READY check and treat intent as COMMITTED
 */
export async function orchestrateBackendChange(
  userMessage: string,
  projectId: string,
  options?: {
    forceCommit?: boolean // When user clicks "Build now", this is true
    requestId?: string // For observability tracking
    conversationHistory?: Array<{ role: 'user' | 'ai'; content: string }> // Phase 1: conversation context
  }
): Promise<OrchestrationResult> {
  // Wrap execution in request context for observability
  return withRequestContext(options?.requestId, async () => {
    return await executeOrchestration(userMessage, projectId, options)
  })
}

/**
 * Internal orchestration execution with full observability
 */
async function executeOrchestration(
  userMessage: string,
  projectId: string,
  options?: {
    forceCommit?: boolean
    requestId?: string
    conversationHistory?: Array<{ role: 'user' | 'ai'; content: string }>
  }
): Promise<OrchestrationResult> {
  const errors: string[] = []
  const startTime = Date.now()
  
  logger.info('Mutation started', {
    projectId: projectId.substring(0, 8),
    messageLength: userMessage.length,
    forceCommit: options?.forceCommit,
  })
  
  // ============================================================================
  // OPERATIONAL GUARDRAILS (PRODUCTION HARDENING)
  // ============================================================================
  // These checks run before any processing to prevent abuse and ensure safety.
  
  // 1. Input Size Cap (prevent memory abuse, pathological parsing)
  const MAX_PROMPT_LENGTH = 16384 // 16 KB
  if (userMessage.length > MAX_PROMPT_LENGTH) {
    logger.warn('Input size limit exceeded', {
      projectId: projectId.substring(0, 8),
      inputLength: userMessage.length,
      maxLength: MAX_PROMPT_LENGTH,
    })
    return {
      success: false,
      message: `Input too long. Maximum ${MAX_PROMPT_LENGTH} characters allowed.`,
      executionState: 'REFUSED',
      refusalReason: 'INPUT_TOO_LARGE',
      timeline: {
        id: `refused_input_size_${Date.now()}`,
        timestamp: new Date().toISOString(),
        title: 'Input Rejected',
        description: 'Input size exceeds safety limit',
        category: 'configuration',
        userVisible: true,
      },
    }
  }
  
  // 2. Rate Limiting (prevent abuse and runaway automation)
  const rateLimitResult = await checkRateLimit(projectId)
  if (!rateLimitResult.allowed) {
    const durationMs = Date.now() - startTime
    
    logger.mutation('Mutation refused - rate limit exceeded', {
      projectId,
      intent: userMessage.substring(0, 100),
      success: false,
      durationMs,
      graphVersion: 0,
      refusalReason: 'RATE_LIMIT_EXCEEDED',
      executionState: 'REFUSED',
    })
    
    return {
      success: false,
      message: `Too many requests. Please try again in ${rateLimitResult.retryAfter} seconds.`,
      executionState: 'REFUSED',
      refusalReason: 'RATE_LIMIT_EXCEEDED',
      timeline: {
        id: `refused_rate_limit_${Date.now()}`,
        timestamp: new Date().toISOString(),
        title: 'Rate Limit Exceeded',
        description: `Too many mutations. Retry after ${rateLimitResult.retryAfter}s`,
        category: 'configuration',
        userVisible: true,
      },
    }
  }
  
  // 3. Execution Timeout Guard (prevent hanging operations)
  const EXECUTION_TIMEOUT_MS = 180000 // 180 seconds (supports large 6+ entity builds)
  const executionStartTime = Date.now()
  const checkTimeout = () => {
    if (Date.now() - executionStartTime > EXECUTION_TIMEOUT_MS) {
      throw new Error(`Execution timeout: Operation exceeded ${EXECUTION_TIMEOUT_MS}ms`)
    }
  }
  
  // ============================================================================
  // PERFORMANCE INSTRUMENTATION
  // ============================================================================
  const perfStart = Date.now()
  const perfMarkers: Record<string, number> = {}
  const markTime = (label: string) => {
    perfMarkers[label] = Date.now() - perfStart
    checkTimeout() // Check timeout at each performance marker
  }
  
  // Production-safe logging: never log raw userMessage, only metadata
  const isProduction = process.env.NODE_ENV === 'production'
  if (isProduction) {
    console.log('[Orchestration] Request received', {
      projectId: projectId.substring(0, 8) + '...',
      messageLength: userMessage.length,
      timestamp: new Date().toISOString(),
    })
  } else {
    // Dev mode: truncated logging only
    console.log('🔥🔥🔥 ORCHESTRATE BACKEND CHANGE CALLED 🔥🔥🔥')
    console.log('🔥🔥🔥 Message:', userMessage.substring(0, 50) + (userMessage.length > 50 ? '...' : ''))
    console.log('🔥🔥🔥 Project:', projectId)
  }
  
  try {
    // ============================================================================
    // PHASE -1: FORBIDDEN PATTERN DETECTION (SECURITY LAYER) - MUST BE FIRST
    // ============================================================================
    // CRITICAL: This MUST run before ANY database reads, logging, or side effects.
    // Safety validation occurs before any infrastructure interaction.
    
    // Check for explicitly forbidden requests (secrets exposure, key display, raw secret injection)
    
    // 1. Raw secret injection detection (actual secret values in prompt)
    // Detect known provider prefixes + labeled secrets.
    // IMPORTANT: Known credential prefixes handled by the credential-guard pipeline
    // (whsec_, sk_live_, sk_test_, re_, SG., phc_, r8_) are intentionally EXCLUDED
    // from the generic labeled-secret pattern — they are intercepted and stored
    // securely by the pipeline stages before reaching orchestration.
    const RAW_SECRET_PATTERNS = [
      // AWS keys (not handled by credential pipeline — truly forbidden in prompts)
      /AKIA[0-9A-Z]{16}/,
      // Generic labeled secrets — but only when the value does NOT start with a known
      // provider prefix (those are handled upstream in the credential-guard pipeline).
      /\b(?:secret|key|token|password|credential|apikey|api_key)[\s:=]+(?!whsec_|sk_live_|sk_test_|rk_live_|re_[A-Za-z]|SG\.|phc_|r8_|pika_|key_[A-Za-z0-9]{32})[a-zA-Z0-9_\-]{20,}/i,
    ]
    
    const hasRawSecret = RAW_SECRET_PATTERNS.some(pattern => pattern.test(userMessage))
    
    if (hasRawSecret) {
      console.log('[Orchestration] 🔒 REFUSED: Raw secret detected in prompt')
      // CRITICAL: Do NOT log the actual message (may contain secret)
      return {
        success: false,
        message: "Raw secrets should never be included in prompts. Use environment variables or secure credential stores.",
        executionState: 'REFUSED',
        refusalReason: 'SECRETS_FORBIDDEN',
        timeline: {
          id: `refused_raw_secret_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Request Blocked',
          description: 'Raw secret detected in prompt',  // Do NOT include userMessage
          category: 'configuration',
          userVisible: true,
        },
      }
    }
    
    // 2. Secret exposure requests (show/display/expose secrets in UI)
    const FORBIDDEN_PATTERNS = [
      /expose.{0,20}(api key|secret|token|credential)/i,
      /show.{0,20}(api key|secret|token|credential)/i,
      /display.{0,20}(api key|secret|token|credential)/i,
      /return.{0,20}(api key|secret|token|credential)/i,
      /reveal.{0,20}(api key|secret|token|credential)/i,
      /view.{0,20}(api key|secret|token).{0,20}(ui|interface|dashboard)/i,
      /put.{0,20}(api key|secret|token).{0,20}(ui|interface)/i,
    ]
    
    const hasForbiddenPattern = FORBIDDEN_PATTERNS.some(pattern => pattern.test(userMessage))
    
    if (hasForbiddenPattern) {
      console.log('[Orchestration] 🔒 REFUSED: Forbidden pattern detected (secrets exposure)')
      return {
        success: false,
        message: "Backenly never exposes secrets or API keys in the UI. Credentials are managed internally through capabilities.",
        executionState: 'REFUSED',
        refusalReason: 'SECRETS_FORBIDDEN',
        timeline: {
          id: `refused_secrets_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Request Blocked',
          description: 'Secrets exposure is forbidden',
          category: 'configuration',
          userVisible: true,
        },
      }
    }
    
    // ============================================================================
    // STAGE 1: SIMPLE INTENT CLASSIFICATION
    // ============================================================================
    // Two options: QUESTION or BUILD_CHANGE
    // No overthinking, no doubt - decide fast and act.
    // ============================================================================
    const intentClassification = classifyIntent(userMessage)
    console.log(`[Orchestration] 🎯 Intent classified as: ${intentClassification.type} (${intentClassification.reason})`)
    
    // Shared result variable for potential mutation routing
    let reasoningResult: import('@/lib/ai/reasoning-engine').ReasoningResult | undefined
    
    // STAGE 2: ROUTING
    if (intentClassification.type === 'QUESTION') {
      console.log('[Orchestration] 💬 QUESTION - Using reasoning LLM')
      
      // Load all data in parallel for speed
      const [currentGraph, project] = await Promise.all([
        getActiveGraph(projectId).then(g => g || createEmptyGraph(projectId)),
        prisma.project.findUnique({
          where: { id: projectId },
          select: { name: true, architecturalMemory: true }
        })
      ])
      
      const archMemory = project?.architecturalMemory 
        ? JSON.stringify(project.architecturalMemory, null, 2)
        : undefined

      // Use reasoning engine for intelligent response
      const { generateReasonedResponse } = await import('@/lib/ai/reasoning-engine')
      reasoningResult = await generateReasonedResponse(
        userMessage,
        currentGraph,
        project?.name || 'Untitled Project',
        projectId,
        archMemory
      )
      
      console.log(`[Orchestration] 💬 Response generated${reasoningResult.usedLLM ? ' via LLM' : ' (fallback)'}`)
      console.log(`[Orchestration] 💬 Action: ${reasoningResult.action}`)
      
      // If LLM detected a mutation intent, route to BUILD_CHANGE flow
      if (reasoningResult.action === 'mutate') {
        console.log('[Orchestration] 🔄 LLM detected mutation - routing to BUILD_CHANGE')
        if (reasoningResult.tool) {
          console.log(`[Orchestration] 🔧 Tool: ${reasoningResult.tool.tool}`, reasoningResult.tool.arguments)
        }
        // Continue to BUILD_CHANGE flow below
      } else {
        // Return answer or clarification
        return {
          success: true,
          message: reasoningResult.response,
          executionState: 'PREVIEW' as const,
          timeline: {
            id: `query_${Date.now()}`,
            timestamp: new Date().toISOString(),
            title: reasoningResult.action === 'clarify' ? 'Clarification Needed' : 'Query Response',
            description: reasoningResult.explanation,
            category: 'configuration',
            userVisible: true,
          },
          ...(reasoningResult.action === 'clarify' && {
            requiresClarification: true,
            clarificationQuestion: reasoningResult.response,
          }),
        }
      }
    }
    
    // BUILD_CHANGE - Use LLM's plan directly (LLM is the single planner)
    console.log('[Orchestration] 🔨 BUILD_CHANGE - Using LLM plan')
    
    // If we came from QUESTION flow with mutation action, use that plan
    // Otherwise, we need to call reasoning engine to get the plan
    let llmPlan = reasoningResult?.plan
    let llmExplanation = reasoningResult?.explanation
    let llmResponse = reasoningResult?.response
    
    if (!llmPlan) {
      // Load current graph for reasoning
      const currentGraphForPlanning = await getActiveGraph(projectId) || createEmptyGraph(projectId)
      const projectForPlanning = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true, architecturalMemory: true }
      })
      
      const archMemory = projectForPlanning?.architecturalMemory 
        ? JSON.stringify(projectForPlanning.architecturalMemory, null, 2)
        : undefined
      
      // Get plan from LLM (single source of truth)
      const { generateReasonedResponse } = await import('@/lib/ai/reasoning-engine')
      const reasoningResult = await generateReasonedResponse(
        userMessage,
        currentGraphForPlanning,
        projectForPlanning?.name || 'Untitled Project',
        projectId,
        archMemory
      )
      
      llmPlan = reasoningResult.plan
      llmExplanation = reasoningResult.explanation
      llmResponse = reasoningResult.response
    }
    
    console.log('[Orchestration] 📋 LLM plan:', llmExplanation)
    llmPlan?.forEach((step, i) => {
      console.log(`[Orchestration]   ${i + 1}. ${step}`)
    })
    
    // ============================================================================
    // UNIFIED GRAPH POINTER ARCHITECTURE (After Safety Validation)
    // ============================================================================
    // Now safe to check project state - safety validation already passed
    
    const isLive = await isProjectLive(projectId)
    
    if (isLive) {
      console.log('[Orchestration] 🟢 LIVE PROJECT - Atomic mutation with validation')
    } else {
      console.log('[Orchestration] 📝 PRIVATE PROJECT - Direct immutable mutation')
    }
    
    // ============================================================================
    // SECTION 6: TYPO NORMALIZATION (DETERMINISTIC, NO LLM)
    // ============================================================================
    // Run lightweight typo normalization BEFORE semantic classification.
    // This is pure dictionary-based correction - no LLM involved.
    // Fixes: craete → create, delte → delete, tabel → table, etc.
    // ============================================================================
    // Using static imports now - no dynamic loading
    
    const typoResult = normalizeTypos(userMessage)
    
    if (typoResult.wasModified) {
      console.log('[Typo Normalizer] ✅ Corrected typos:', typoResult.corrections.length)
      typoResult.corrections.forEach(c => {
        console.log(`[Typo Normalizer]   "${c.original}" → "${c.corrected}"`)
      })
    }
    
    // Use normalized message for all downstream processing
    const normalizedUserMessage = typoResult.normalizedMessage
    
    // ============================================================================
    // ============================================================================
    // INTEGRATION MODE: AI-Free Deterministic Path
    // ============================================================================
    // When ENGINE_MODE=integration, skip all LLM calls for deterministic performance
    const isIntegrationMode = process.env.ENGINE_MODE === 'integration'
    
    if (isIntegrationMode) {
      console.log('[Orchestration] 🔧 INTEGRATION MODE - Bypassing AI layers')
    }
    
    // PHASE 0.1: SEMANTIC UNDERSTANDING LAYER
    // ============================================================================
    // Using static imports now - no dynamic loading
    console.log('[Orchestration] Phase 0.1: Semantic Understanding Layer')
    
    // INTEGRATION MODE: Skip LLM, use deterministic parsing
    let semanticUnderstandingResult: any
    if (isIntegrationMode) {
      semanticUnderstandingResult = {
        intentSummary: 'Deterministic schema operation',
        probableEntities: [],
        ambiguityScore: 0,
        domain: 'database',
        requiresClarification: false
      }
      markTime('semantic_understanding_complete')
    } else {
      semanticUnderstandingResult = await semanticUnderstanding(normalizedUserMessage, projectId)
      markTime('semantic_understanding_complete')
    }
    
    console.log('[Semantic Understanding] Intent:', semanticUnderstandingResult.intentSummary)
    console.log('[Semantic Understanding] Entities:', semanticUnderstandingResult.probableEntities)
    console.log('[Semantic Understanding] Ambiguity:', semanticUnderstandingResult.ambiguityScore)
    
    // PHASE 0: AI Conversation Layer (PRE-EVERYTHING)
    // INTEGRATION MODE: Skip AI conversation entirely
    console.log('[Orchestration] Phase 0: AI Conversation Layer')
    let conversation: any
    if (isIntegrationMode) {
      conversation = { needsClarification: false, message: null }
    } else {
      conversation = await converseWithUser(normalizedUserMessage)
    }
    
    // Phase 2: Load backend state for planning
    console.log('[Orchestration] Phase 2: Loading backend state for planning')
    const graphForPlanning = (await getActiveGraph(projectId)) || createEmptyGraph(projectId)
    
    // ============================================================================
    // PHASE 0.15: FLOW REASONING (Elite Agent Phase 3)
    // ============================================================================
    // INTEGRATION MODE: Skip flow reasoning - it's AI-based and not needed for tests
    let interactionGraph: any = null
    if (!isIntegrationMode) {
      try {
        // Using static imports now - no dynamic loading
        console.log('[Flow Reasoning] Analyzing actor interactions...')
        
        interactionGraph = await inferInteractionGraph(
          semanticUnderstandingResult.domain,
          semanticUnderstandingResult.intentSummary,
          graphForPlanning
        )
        
        if (interactionGraph?.actors?.length > 0 && process.env.NODE_ENV !== 'test') {
          console.log('[Flow Reasoning] Actors detected:', interactionGraph.actors.map((a: any) => a.name).join(', '))
          console.log('[Flow Reasoning] Interactions:', interactionGraph.interactions?.length || 0)
        }
      } catch (error: any) {
        if (process.env.NODE_ENV !== 'test') {
          console.log('[Flow Reasoning] Skipped:', error.message)
        }
      }
    }

    // ============================================================================
    // PHASE 0.15: INCREMENTAL MUTATION DETECTION (MUST RUN BEFORE ENTITY INFERENCE)
    // ============================================================================
    // Detect field-level mutations on existing entities BEFORE entity inference
    // Entity inference rewrites intent and destroys mutation semantics
    // ============================================================================
    console.log('[Orchestration] 🔍🔍🔍 CHECKING FOR INCREMENTAL MUTATIONS 🔍🔍🔍')
    console.log('[Orchestration] Message:', normalizedUserMessage)
    const currentGraphForMutation = await getActiveGraph(projectId)
    console.log('[Orchestration] Graph loaded:', currentGraphForMutation ? 'YES' : 'NO')
    if (currentGraphForMutation) {
      console.log('[Orchestration] Graph entities:', Object.keys(currentGraphForMutation.entities).join(', '))
      console.log('[Orchestration] Entity count:', Object.keys(currentGraphForMutation.entities).length)
    }
    
    if (currentGraphForMutation && shouldUseIncrementalMode(normalizedUserMessage, currentGraphForMutation)) {
      console.log('[Orchestration] 🔧 INCREMENTAL MODE DETECTED - Bypassing entity inference')
      const mutationIntent = classifyMutation(normalizedUserMessage, currentGraphForMutation)
      
      // 💡 CHECKPOINT 1: MutationIntent
      console.log('🧠 CHECKPOINT 1: MutationIntent:', JSON.stringify(mutationIntent, null, 2))
      
      if (mutationIntent) {
        console.log('[Orchestration] Mutation type:', mutationIntent.type)
        console.log('[Orchestration] Target entity:', mutationIntent.entity)
        console.log('[Orchestration] Field:', mutationIntent.field)
        
        // 🚨 CRITICAL: Deep clone BEFORE execution to prevent reference mutation
        // executeReal() modifies the graph in-place, so we need a snapshot for comparison
        const graphBeforeMutation = JSON.parse(JSON.stringify(currentGraphForMutation))
        console.log('[Orchestration] 📸 Graph snapshot taken before mutation')
        console.log('[Orchestration] 📸 Snapshot entities:', Object.keys(graphBeforeMutation.entities).join(', '))
        
        // Convert mutation intent to execution plan
        const executionPlan = await convertMutationToExecutionPlan(mutationIntent, currentGraphForMutation, projectId)
        console.log('[Orchestration] 📋 Execution plan created, graph entities now:', Object.keys(currentGraphForMutation.entities).join(', '))
        
        // 💡 CHECKPOINT 2: ExecutionPlan
        console.log('⚙️ CHECKPOINT 2: ExecutionPlan:', JSON.stringify(executionPlan, null, 2))
        
        // Execute mutation
        console.log('[Orchestration] Executing incremental mutation...')
        
        // 💡 CHECKPOINT 3: executeReal() called
        console.log('🚀 CHECKPOINT 3: About to call executeReal()')
        
        const executionResult = await executeReal(executionPlan, currentGraphForMutation, projectId)
        
        // 💡 CHECKPOINT 5: finalGraph after execution
        console.log('📊 CHECKPOINT 5: finalGraph entities:', JSON.stringify(Object.keys(executionResult.finalState.entities), null, 2))
        console.log('📊 CHECKPOINT 5: products fields:', JSON.stringify(executionResult.finalState.entities[mutationIntent.entity]?.fields, null, 2))
        
        console.log('[Orchestration] Mutation execution complete')
        console.log('[Orchestration] Execution success:', executionResult.success)
        console.log('[Orchestration] Changes:', executionResult.changes.length)
        
        // CRITICAL: Check if execution failed before proceeding
        if (!executionResult.success) {
          console.error('[Orchestration] ❌ Mutation execution failed:', executionResult.message)
          return {
            success: false,
            message: executionResult.message || 'Mutation failed: Referential integrity violation or execution error',
            executionState: 'REFUSED',
            timeline: {
              id: `mutation_failed_${Date.now()}`,
              timestamp: new Date().toISOString(),
              title: 'Mutation Failed',
              description: executionResult.failedStep?.error || executionResult.message || 'Execution failed',
              category: 'data_model' as any,
              userVisible: true,
            },
            errors: [executionResult.failedStep?.error || executionResult.message || 'Unknown execution error'],
          }
        }
        
        // Check structural equality before saving
        // Use graphBeforeMutation (deep clone) NOT currentGraphForMutation (mutated by reference)
        const finalGraph = executionResult.finalState
        console.log('[Orchestration] 🔍 Comparing graphBeforeMutation vs finalGraph...')
        console.log('[Orchestration] 📊 Before entities:', Object.keys(graphBeforeMutation.entities).join(', '))
        console.log('[Orchestration] 📊 Before fields:', Object.keys(graphBeforeMutation.entities[mutationIntent.entity]?.fields || {}).join(', '))
        console.log('[Orchestration] 📊 After entities:', Object.keys(finalGraph.entities).join(', '))
        console.log('[Orchestration] 📊 After fields:', Object.keys(finalGraph.entities[mutationIntent.entity]?.fields || {}).join(', '))
        
        // ============================================================================
        // PHASE 4.3: PROJECTION GUARD ASSERTIONS (dev-only, fail-fast)
        // CRITICAL: Run BEFORE structural equality check to catch executor bugs
        // ============================================================================
        const { assertGraphInvariants, assertProjectionConsistency, repairOrphanRelationships } = await import('./projection-assertions')
        const repairs = repairOrphanRelationships(finalGraph)
        if (repairs.length > 0) {
          console.warn('[Orchestration] ⚠️  Repaired orphan relationships before save:', repairs)
        }
        try {
          assertGraphInvariants(finalGraph)
          assertProjectionConsistency(finalGraph)
        } catch (assertionError: any) {
          console.error('[Orchestration] ❌ Projection guard assertion failed:', assertionError.message)
          // Fail fast in development - this indicates a kernel integrity violation
          if (process.env.NODE_ENV !== 'production') {
            throw assertionError
          }
        }
        
        if (isStructurallyEqual(graphBeforeMutation, finalGraph)) {
          console.log('[Orchestration] ⚠️  No structural changes detected. Skipping graph save.')
          return {
            success: true,
            message: 'No structural changes detected',
            timeline: {
              id: `no-change-${Date.now()}`,
              timestamp: new Date().toISOString(),
              title: 'No changes',
              description: normalizedUserMessage,
              category: 'data_model' as any,
              userVisible: false,
            },
            executionState: 'NO_CHANGE' as any,
          }
        }
        
        // ============================================================================
        // INTEGRATION MODE: Skip Prisma persistence for incremental mutations too
        // ============================================================================
        if (isIntegrationMode) {
          console.log('[Orchestration] 🧪 INTEGRATION MODE - Storing incremental mutation in memory only')
          // Push to history stack instead of replacing
          const history = integrationGraphStore.get(projectId) || []
          history.push(finalGraph)
          integrationGraphStore.set(projectId, history)
          
          return {
            success: true,
            message: `${mutationIntent.type} completed successfully (integration mode)`,
            timeline: {
              id: `mutation_${Date.now()}`,
              timestamp: new Date().toISOString(),
              title: `${mutationIntent.type.replace('_', ' ')}`,
              description: mutationIntent.rawIntent,
              category: 'data_model' as any,
              userVisible: true,
            },
            executionResult,
            executionState: 'EXECUTED',
          }
        }
        
        // Save new graph (production path)
        const newGraphRecord = await saveNewGraph(projectId, finalGraph)
        console.log('[Orchestration] ✅ Incremental mutation: New graph saved, seq:', newGraphRecord.sequenceNumber)
        
        return {
          success: true,
          message: `${mutationIntent.type} completed successfully`,
          timeline: {
            id: `mutation-${Date.now()}`,
            timestamp: new Date().toISOString(),
            title: `${mutationIntent.type.replace('_', ' ')}`,
            description: mutationIntent.rawIntent,
            category: 'data_model' as any,
            userVisible: true,
          },
          executionResult,
          executionState: 'EXECUTED',
        }
      }
    }
    
    console.log('[Orchestration] No incremental mutation detected, proceeding to entity inference')

    // ============================================================================
    // PHASE 0.25: ENTITY INFERENCE LAYER (NEW!)
    // ============================================================================
    // Automatically infer entities from high-level SaaS prompts to eliminate refusals
    // Using static imports now - no dynamic loading
    
    let enrichedMessage = normalizedUserMessage
    let inferenceMetadata: any = null
    
    // INTEGRATION MODE: Skip entity inference LLM - use deterministic parsing
    const needsInference = isIntegrationMode ? false : needsEntityInference(normalizedUserMessage)
    console.log('[Orchestration] needsEntityInference result:', needsInference)
    
    if (needsInference) {
      console.log('[Entity Inference] High-level prompt detected, inferring entities...')
      console.log('[Entity Inference] Existing entities in graph:', Object.keys(graphForPlanning.entities).length)
      
      const inferenceResult = await inferEntities(normalizedUserMessage, projectId, graphForPlanning, semanticUnderstandingResult)
      markTime('entity_inference_complete')
      
      if (inferenceResult.success && inferenceResult.entities.length > 0) {
        const validation = validateInferredEntities(inferenceResult.entities)
        
        if (validation.valid) {
          console.log('[Entity Inference] ✅ Successfully inferred', inferenceResult.entities.length, 'entities')
          console.log('[Entity Inference] Confidence:', inferenceResult.confidence)
          console.log('[Entity Inference] Entities:', inferenceResult.entities.map(e => e.name).join(', '))
          console.log('[Entity Inference] Reasoning:', inferenceResult.reasoning)

          // ============================================================================
          // PHASE 0.25: IDEMPOTENCY CHECK — early exit if nothing would change
          // ============================================================================
          // If ALL inferred entities already exist in the graph, there's nothing to do.
          // Skip the full LLM pipeline (impact analysis, integration planning, etc.)
          const existingEntityNames = new Set(Object.keys(graphForPlanning.entities))
          const allAlreadyExist = inferenceResult.entities.every((e: any) => existingEntityNames.has(e.name))
          if (allAlreadyExist && existingEntityNames.size > 0) {
            console.log('[Idempotency] All inferred entities already exist — no structural changes needed')
            return {
              success: true,
              message: `Your backend already has all these components built. Tables: ${Array.from(existingEntityNames).join(', ')}`,
              timeline: {
                id: `idempotent_${Date.now()}`,
                timestamp: new Date().toISOString(),
                title: 'Backend already up to date',
                description: `All ${existingEntityNames.size} tables already exist in your backend.`,
                category: 'conversation' as any,
                userVisible: true,
              },
              executionState: 'NO_CHANGES' as any,
              confidence: 'HIGH' as any,
              semanticUnderstanding: true,
              clarificationQuestion: undefined,
            }
          }

          // ============================================================================
          // PHASE 0.3: SCHEMA NORMALIZATION LAYER (NEW!)
          // ============================================================================
          // Transform inferred entities into engine-safe schema specs
          // Using static imports now - no dynamic loading
          
          console.log('[Schema Normalizer] Normalizing inferred entities...')
          console.log('[DEBUG BEFORE NORMALIZE]', JSON.stringify(inferenceResult.entities, null, 2))
          console.log('[Schema Normalizer] Input entities:', JSON.stringify(inferenceResult.entities.map((e: any) => ({
            name: e.name,
            fieldCount: e.fields?.length || 0,
            fields: e.fields?.map((f: any) => f.name)
          }))))
          const normalizationResult = normalizeEntities(inferenceResult.entities)
          
          console.log('[Schema Normalizer] Output entities:', JSON.stringify(normalizationResult.entities.map((e: any) => ({
            name: e.name,
            fieldCount: e.fields?.length || 0,
            fields: e.fields?.map((f: any) => f.name)
          }))))
          
          if (normalizationResult.success) {
            console.log('[Schema Normalizer] ✅ Normalization successful')
            console.log('[Schema Normalizer] Stats:', normalizationResult.stats)
            
            if (normalizationResult.warnings.length > 0) {
              console.log('[Schema Normalizer] ⚠️ Warnings:', normalizationResult.warnings)
            }
            
            // ============================================================================
            // PHASE 0.35: CONFIDENCE EVALUATION
            // ============================================================================
            // Using static imports now - no dynamic loading
            
            console.log('[Confidence Evaluation] Calculating execution confidence...')
            const confidenceEval = evaluateConfidence(
              semanticUnderstandingResult,
              inferenceResult.entities,
              normalizationResult.entities
            )
            
            console.log('[Confidence Evaluation] Level:', confidenceEval.level)
            console.log('[Confidence Evaluation] Score:', (confidenceEval.score * 100).toFixed(0) + '%')
            console.log('[Confidence Evaluation] Reasoning:', confidenceEval.reasoning)
            
            // ============================================================================
            // PHASE 0.36: IMPACT ANALYSIS (Elite Agent Phase 5)
            // ============================================================================
            let impactReport: any = null
            try {
              // Using static imports now - no dynamic loading
              console.log('[Impact Analysis] Predicting infrastructure requirements...')
              
              impactReport = await analyzeInfrastructureImpact(
                userMessage,
                semanticUnderstandingResult,
                graphForPlanning,
                normalizationResult.entities.map(e => e.name)
              )
              
              console.log('[Impact Analysis] Severity:', impactReport.overallSeverity)
              console.log('[Impact Analysis] Impacts:', impactReport.impacts?.length || 0)
              console.log('[Impact Analysis] Complexity:', impactReport.estimatedComplexity?.score || 0, '/10')
            } catch (error: any) {
              console.log('[Impact Analysis] Skipped:', error.message)
            }
            
            // ============================================================================
            // PHASE 0.38: INTEGRATION PLANNING (NEW!)
            // ============================================================================
            // Generate architectural options if existing entities present
            const existingEntityCount = Object.keys(graphForPlanning.entities).length
            
            if (existingEntityCount > 0) {
              console.log('[Integration Planner] Existing entities detected - generating options...')
              
              // Using static imports now - no dynamic loading
              const integrationPlan = await generateIntegrationOptions(
                inferenceResult.entities,
                graphForPlanning,
                semanticUnderstandingResult
              )
              
              if (integrationPlan.success && integrationPlan.requiresDecision) {
                console.log('[Integration Planner] Multiple options available - awaiting user decision')
                console.log('[Integration Planner] Options:', integrationPlan.options.map(o => o.title).join(', '))
                
                return {
                  success: false,
                  message: 'Choose how to integrate these changes into your architecture',
                  timeline: {
                    id: `integration_decision_${Date.now()}`,
                    timestamp: new Date().toISOString(),
                    title: 'Architecture Decision Required',
                    description: 'Multiple integration strategies available',
                    category: 'configuration',
                    userVisible: true,
                  },
                  executionState: 'AWAITING_ARCH_DECISION',
                  integrationOptions: integrationPlan.options,
                  semanticUnderstanding,
                  confidence: confidenceEval.level,
                  inferenceMetadata: {
                    originalPrompt: inferenceResult.originalPrompt,
                    inferredEntities: inferenceResult.entities,
                    normalizedEntities: normalizationResult.entities,
                    confidence: inferenceResult.confidence,
                    reasoning: inferenceResult.reasoning,
                    interactionGraph, // Elite Agent Phase 3
                    impactReport, // Elite Agent Phase 5
                  },
                }
              }
              
              console.log('[Integration Planner] Single option - proceeding to execution')
            }
            
            // ============================================================================
            // PHASE 0.4: ROUTING DECISION (DRAFT-FIRST ARCHITECTURE)
            // ============================================================================
            // KEY INSIGHT: When ambiguity is moderate (0.2-0.6), DO NOT return CLARIFICATION_NEEDED.
            // Instead, return PREVIEW with proposedEntities + assumptions.
            // This is the Cursor/Replit style: AI proposes, explains reasoning, asks for confirmation.
            // ============================================================================
            
            // PROPOSAL MODE: Moderate ambiguity (0.2-0.6)
            // AI proposes architecture with explicit assumptions - NO open questions
            // SKIP when forceCommit=true — user already reviewed and confirmed
            if (confidenceEval.shouldPropose && !options?.forceCommit) {
              console.log('[Routing] PROPOSAL MODE - returning PREVIEW with proposed entities')
              console.log('[Routing] Assumptions:', confidenceEval.assumptions)
              
              return {
                success: true,
                message: confidenceEval.message,
                timeline: {
                  id: `preview_proposal_${Date.now()}`,
                  timestamp: new Date().toISOString(),
                  title: 'Architecture Proposal',
                  description: 'Review the proposed structure and confirm',
                  category: 'configuration',
                  userVisible: true,
                },
                executionState: 'PREVIEW',
                requiresCommitment: true, // User must confirm to proceed
                proposedEntities: normalizationResult.entities, // The inferred entities
                assumptions: confidenceEval.assumptions, // Explicit assumptions
                semanticUnderstanding,
                confidence: confidenceEval.level,
                inferenceMetadata: {
                  originalPrompt: inferenceResult.originalPrompt,
                  inferredEntities: inferenceResult.entities,
                  normalizedEntities: normalizationResult.entities,
                  confidence: inferenceResult.confidence,
                  confidenceEval: confidenceEval,
                  reasoning: inferenceResult.reasoning,
                  normalizationStats: normalizationResult.stats,
                  interactionGraph, // Elite Agent Phase 3
                  impactReport, // Elite Agent Phase 5
                },
                narration: {
                  pre: confidenceEval.message, // The proposal message
                },
              }
            }
            
            // HIGH AMBIGUITY (>0.7): Must ask clarifying question
            // Only reach here when ambiguity is truly high (multiple interpretations)
            // SKIP when forceCommit=true — user already confirmed via "Build it" button
            if (confidenceEval.shouldAskQuestion && !options?.forceCommit) {
              console.log('[Routing] LOW confidence - requesting clarification')
              return {
                success: false,
                message: confidenceEval.message,
                timeline: {
                  id: `clarification_${Date.now()}`,
                  timestamp: new Date().toISOString(),
                  title: 'Clarification Needed',
                  description: 'Need more information to proceed',
                  category: 'configuration',
                  userVisible: true,
                },
                executionState: 'CLARIFICATION_NEEDED',
                requiresClarification: true,
                clarificationQuestion: confidenceEval.question,
                semanticUnderstanding,
                confidence: confidenceEval.level,
              }
            }
            
            // MEDIUM/HIGH CONFIDENCE: Request user confirmation
            if (confidenceEval.shouldConfirm) {
              console.log('[Routing] MEDIUM/HIGH confidence - requesting confirmation')
              // Continue to batch mode with confidence metadata
              // Will show commitment UI before execution
            }
            
            // Build enriched prompt from normalized entities
            const normalizedPrompt = buildPromptFromNormalizedEntities(normalizationResult.entities)
            enrichedMessage = normalizedPrompt
            
            // Store metadata for transparency
            inferenceMetadata = {
              originalPrompt: inferenceResult.originalPrompt,
              inferredEntities: inferenceResult.entities,
              normalizedEntities: normalizationResult.entities,
              confidence: inferenceResult.confidence,
              confidenceEval: confidenceEval,
              reasoning: inferenceResult.reasoning,
              normalizationStats: normalizationResult.stats,
            }
          } else {
            console.log('[Schema Normalizer] ❌ Normalization failed:', normalizationResult.errors)
            // Fall back to enriched prompt from inference
            enrichedMessage = inferenceResult.enrichedPrompt
            
            inferenceMetadata = {
              originalPrompt: inferenceResult.originalPrompt,
              entities: inferenceResult.entities,
              confidence: inferenceResult.confidence,
              reasoning: inferenceResult.reasoning,
              normalizationErrors: normalizationResult.errors,
            }
          }
        } else {
          console.log('[Entity Inference] ⚠️ Validation failed:', validation.errors)
          // RESILIENCE: Don't just fall back - try to recover with auto-repair
          // The schema normalizer now has auto-repair, so we should still try
          console.log('[Entity Inference] 🔄 Attempting recovery with schema normalizer auto-repair...')
          
          // Using static imports now - no dynamic loading
          const normalizationResult = normalizeEntities(inferenceResult.entities)
          
          if (normalizationResult.success) {
            console.log('[Entity Inference] ✅ Recovery successful via auto-repair')
            // Use the repaired entities
            const normalizedPrompt = buildPromptFromNormalizedEntities(normalizationResult.entities)
            enrichedMessage = normalizedPrompt
            
            inferenceMetadata = {
              originalPrompt: inferenceResult.originalPrompt,
              inferredEntities: inferenceResult.entities,
              normalizedEntities: normalizationResult.entities,
              confidence: inferenceResult.confidence,
              reasoning: inferenceResult.reasoning,
              normalizationStats: normalizationResult.stats,
              wasRepaired: true,
            }
          } else {
            console.log('[Entity Inference] ❌ Recovery failed, using original prompt')
          }
        }
      } else {
        console.log('[Entity Inference] ⚠️ Inference failed, using original prompt')
      }
    } else {
      console.log('[Entity Inference] Skipped - prompt already has explicit entities')
    }

    // ============================================================================
    // PHASE 0.5: BATCH MODE CHECK
    // ============================================================================
    // Check if this should be batch build mode (parse everything at once)
    // NOTE: Now uses enrichedMessage which may contain inferred entities
    // Using static imports now - no dynamic loading
    // INTEGRATION MODE: Always use batch mode for deterministic parsing
    const useBatch = isIntegrationMode ? true : shouldUseBatchMode(enrichedMessage, graphForPlanning)
    
    if (useBatch) {
      console.log('[Orchestration] STAGE 1: BATCH MODE ENABLED')
      console.log('[Orchestration] STAGE 2: About to generate batch plan...')
      
      // ============================================================================
      // BATCH MODE: FULL SCHEMA CONSTRUCTION
      // ============================================================================
      
      // ============================================================================
      // STEP 1: SINGLE SOURCE OF TRUTH
      // ============================================================================
      // If we have normalized entities from inference, use them directly
      // DO NOT re-parse with LLM - prevents field loss
      // ============================================================================
      let batchPlan: any
      
      if (inferenceMetadata?.normalizedEntities && inferenceMetadata.normalizedEntities.length > 0) {
        console.log('[Batch Planner] ✅ Using normalized inference result (no re-parsing)')
        console.log('[Batch Planner] Normalized entities:', inferenceMetadata.normalizedEntities.length)
        console.log('🔴 ENTITY SOURCE:', {
          fromInference: true,
          fromSemanticBridge: false,
          entityCount: inferenceMetadata.normalizedEntities.length,
          fieldDetails: inferenceMetadata.normalizedEntities.map((e: any) => ({
            name: e.name,
            fieldCount: e.fields.length,
            nonSystemFields: e.fields.filter((f: any) => 
              !['id', 'created_at', 'updated_at'].includes(f.name)
            ).length
          }))
        })
        
        // Create batch plan directly from normalized entities - preserves all fields
        batchPlan = await createBatchPlanFromNormalizedEntities(
          inferenceMetadata.normalizedEntities,
          enrichedMessage,
          semanticUnderstanding
        )
      } else {
        console.log('[Batch Planner] ⚠️ No normalized entities - parsing from message')
        // Fallback: Parse ALL entities/features from enriched prompt
        batchPlan = await parseBatchPlan(enrichedMessage)
      }
      
      // ============================================================================
      // STEP 2: FIELD PRESERVATION INVARIANT
      // ============================================================================
      // If inference extracted explicit fields, ensure they weren't lost in batch plan
      // This prevents silent schema degradation
      // ============================================================================
      if (inferenceMetadata?.normalizedEntities && inferenceMetadata.normalizedEntities.length > 0) {
        const extractedFieldCount = inferenceMetadata.normalizedEntities.reduce((sum: number, e: any) => {
          // Count non-system fields
          const meaningfulFields = e.fields.filter((f: any) => 
            f.name !== 'id' && f.name !== 'created_at' && f.name !== 'updated_at'
          )
          return sum + meaningfulFields.length
        }, 0)
        
        const batchPlanFieldCount = batchPlan.entities.reduce((sum, e) => sum + e.fields.length, 0)
        
        console.log('[Field Preservation] Extracted fields:', extractedFieldCount)
        console.log('[Field Preservation] Batch plan fields:', batchPlanFieldCount)
        
        // INVARIANT: If we extracted fields from NL, batch plan must preserve them
        if (extractedFieldCount > 0 && batchPlanFieldCount === 0) {
          if (options?.forceCommit) {
            // forceCommit: recover by rebuilding the batch plan from normalized entities
            console.log('[Field Preservation] ⚠️ Fields lost but forceCommit=true — recovering from normalized entities')
            batchPlan = await createBatchPlanFromNormalizedEntities(
              inferenceMetadata.normalizedEntities,
              enrichedMessage,
              semanticUnderstanding
            )
            console.log('[Field Preservation] ✅ Recovered batch plan fields:', batchPlan.entities.reduce((s: number, e: any) => s + e.fields.length, 0))
          } else {
            console.log('[Field Preservation] ❌ INVARIANT VIOLATED: Fields were lost')
            console.log('[Field Preservation] Blocking auto-execution, forcing PREVIEW')

            // Force PREVIEW mode with the normalized entities
            return {
              success: true,
              message: generateFieldPreservationProposal(inferenceMetadata.normalizedEntities),
              timeline: {
                id: `preview_field_preservation_${Date.now()}`,
                timestamp: new Date().toISOString(),
                title: 'Architecture Proposal',
                description: 'Review the proposed structure and confirm',
                category: 'configuration',
                userVisible: true,
              },
              executionState: 'PREVIEW',
              requiresCommitment: true,
              proposedEntities: inferenceMetadata.normalizedEntities,
              assumptions: ['Field specifications extracted from natural language', 'Schema structure inferred from prompt'],
              semanticUnderstanding,
              confidence: 'MEDIUM',
              narration: {
                pre: generateFieldPreservationProposal(inferenceMetadata.normalizedEntities),
              },
            }
          }
        }
      }
      
      // ============================================================================
      // STEP 2: ENFORCE PRECEDENCE - SEMANTIC BRIDGE IS FALLBACK ONLY
      // ============================================================================
      // Critical fix: Semantic bridge should NEVER override existing entities
      // Precedence: Deterministic > Inference > Semantic Bridge (fallback only)
      // ============================================================================
      
      const hasEntitiesFromInference = inferenceMetadata?.normalizedEntities?.length > 0
      
      // Only use semantic bridge if we have NO entities from any source
      if (batchPlan.entities.length === 0 && !hasEntitiesFromInference) {
        console.log('[Orchestration] Batch plan empty AND no inference entities - falling back to semantic bridge')
        
        // BRIDGE: If batch plan is empty AND no inference entities exist,
        // create a simple execution plan directly from semantic understanding
        if (semanticUnderstandingResult?.probableEntities?.length > 0) {
          console.log('[Orchestration] Bridge: Creating execution plan from semantic understanding')
          console.log('[Orchestration] Bridge: Entities:', semanticUnderstandingResult.probableEntities)
          
          // Create simple entities from semantic understanding
          const simpleEntities = semanticUnderstandingResult.probableEntities.map((name: string) => ({
            name: name.toLowerCase().replace(/\s+/g, '_'),
            fields: [
              { name: 'id', type: 'uuid', primary: true, required: true },
              { name: 'name', type: 'string', required: true },
              { name: 'created_at', type: 'timestamp', required: true },
              { name: 'updated_at', type: 'timestamp', required: true },
            ]
          }))
          
          // ONLY set batchPlan if it's currently empty - never override existing entities
          if (batchPlan.entities.length === 0) {
            batchPlan = {
              entities: simpleEntities,
              relationships: [],
              auth: { enabled: false, signupEnabled: false, loginEnabled: false },
              storage: { enabled: false, buckets: [] },
              userIntent: enrichedMessage,
              isBatchMode: true,
              executionOrder: simpleEntities.map((e: any) => e.name),
              summary: `Create ${simpleEntities.map((e: any) => e.name).join(', ')} table(s)`,
            }
            
            console.log('[Orchestration] Bridge: Created', simpleEntities.length, 'entities from semantic understanding')
          }
          // Continue to batch execution below
        } else {
          // Fall through to normal parsing - no bridge available
        }
      } else if (hasEntitiesFromInference) {
        console.log('[Orchestration] ✅ Skipping semantic bridge - entities already exist from inference')
        console.log('[Orchestration] Inference entities:', inferenceMetadata.normalizedEntities.length)
      } else if (batchPlan.entities.length > 0) {
        console.log('[Orchestration] ✅ Skipping semantic bridge - entities already exist from batch plan')
        console.log('[Orchestration] Batch plan entities:', batchPlan.entities.length)
      }
      
      // Execute batch plan if we have entities (either from original parsing or bridge)
      // OR if we have a policy intent
      if (batchPlan.entities.length > 0 || batchPlan.policy) {
        // 🚨 DOMAIN LOCK INVARIANT: Check if this is a domain declaration
        // This runs ALWAYS, not just on empty projects
        // SKIP for policy intents - they don't create entities
        const isPolicyIntent = !!batchPlan.policy
        
        if (!isPolicyIntent) {
          const isDomainDeclaration = detectExplicitDomainDeclaration(normalizedUserMessage, batchPlan)
          
          // Check if project has any declared domain yet
          // Domain is declared if: has entities OR version > 0 (something was executed)
          const hasEntities = Object.keys(graphForPlanning.entities).length > 0
          const hasVersion = graphForPlanning.version > 0
          const hasDomainDeclared = hasEntities || hasVersion
          
          console.log('[Domain Lock] Check:', {
            hasEntities,
            hasVersion: graphForPlanning.version,
            hasDomainDeclared,
            isDomainDeclaration,
            entitiesInPlan: batchPlan.entities.map(e => e.name)
          })
          
          // RULE: Can only create entities if domain is declared in THIS request OR was declared before
          if (!isDomainDeclaration && !hasDomainDeclared) {
            console.log('[Orchestration] ❌ REFUSAL: Domain not declared, cannot create entities')
            
            // Generate mechanical refusal message
            const refusalMessage = generateDomainLockRefusal(userMessage, batchPlan)
            
            return {
              success: true,
              message: refusalMessage,
              requiresClarification: true,
              executionState: 'REFUSED',
              refusalReason: 'INSUFFICIENT_DOMAIN_CONTEXT',
              timeline: {
                id: `refusal_${Date.now()}`,
                timestamp: new Date().toISOString(),
                title: 'Domain Not Declared',
                description: refusalMessage,
                category: 'configuration',
                userVisible: true,
              },
              narration: {
                pre: refusalMessage
              }
            }
          }
          
          if (isDomainDeclaration && !hasDomainDeclared) {
            console.log('[Orchestration] ✅ DOMAIN DECLARED - Unlocking project for entity creation')
          }
        } else {
          console.log('[Orchestration] ✅ Policy intent detected - skipping domain lock check')
        }
        
        console.log(`[Orchestration] Batch plan has ${batchPlan.entities.length} entities`)
        console.log(`[Orchestration] Execution order: ${batchPlan.executionOrder.join(' → ')}`)
        console.log(`[Orchestration] Summary: ${batchPlan.summary}`)
        
        // Convert batch plan to intents (ALREADY IN CORRECT ORDER)
        const isTestEnv = process.env.NODE_ENV === 'test'
        
        if (!isTestEnv) {
          console.log('🔍 DEBUG: About to convert batch plan to intents')
        }
        const batchIntents = batchPlanToIntents(batchPlan)
        if (!isTestEnv) {
          console.log('🔍 DEBUG: Batch intents generated:', batchIntents.length)
          console.log('🔍 DEBUG: Intent targets:', batchIntents.map(i => i.target).join(', '))
        }
        
        // Sort intents by executionPriority (set in batchPlanToIntents)
        // Priority ranges: 0-99 storage, 100+ tables (topological), 200+ auth
        const sortedIntents = batchIntents.sort((a, b) => {
          const priorityA = (a.constraints.executionPriority as number) ?? 999
          const priorityB = (b.constraints.executionPriority as number) ?? 999
          return priorityA - priorityB
        })
        
        if (!isTestEnv) {
          console.log(`[Orchestration] Executing ${sortedIntents.length} intents in dependency order`)
          console.log('🔍 DEBUG: Sorted intents:', JSON.stringify(sortedIntents.map(i => ({ target: i.target, action: i.action, type: i.intent_type })), null, 2))
        }
        
        // ============================================================================
        // BATCH MODE: UNIFIED POINTER-BASED EXECUTION
        // ============================================================================
        
        let finalGraph: BackendStateGraph
        let cumulativeChanges: ExecutionChange[] = []
        
        // Step 1: Get active graph (or create initial)
        const activeGraphBatch = await getActiveGraph(projectId)
        
        if (!activeGraphBatch) {
          // First time - create initial empty graph
          const emptyGraph = createEmptyGraph(projectId)
          await createInitialGraph(projectId, emptyGraph)
          finalGraph = emptyGraph
        } else {
          finalGraph = activeGraphBatch
        }
        
        console.log('[Orchestration] 📖 Batch mode: Starting from active graph, version:', finalGraph.version)
        console.log('🔍 DEBUG: GRAPH BEFORE EXECUTION - Entities:', Object.keys(finalGraph.entities).join(', ') || 'NONE')
        
        // Step 2: Execute all intents using WAVE-BASED PARALLEL execution
        // ─────────────────────────────────────────────────────────────────
        // OPTIMIZATION: Separate DATA_MODEL_ADD intents (priority 100-199) from
        // non-table intents (storage, auth, API) which still run sequentially.
        //
        // For table intents we:
        //   1. Run ALL atomic (in-memory) graph updates sequentially (fast, no I/O)
        //   2. Then call executeReal ONCE for the final merged graph
        //      instead of calling it once per table (avoids N×schema+migration)
        //
        // For non-table intents we keep the original sequential loop.
        // ─────────────────────────────────────────────────────────────────
        console.log('[Orchestration] STAGE 4: Starting WAVE-BASED batch execution of', sortedIntents.length, 'intents')

        const tableIntents = sortedIntents.filter(i => i.intent_type === 'DATA_MODEL_ADD')
        const nonTableIntents = sortedIntents.filter(i => i.intent_type !== 'DATA_MODEL_ADD')

        // ── PHASE A: Run all DATA_MODEL_ADD intents via atomic executor (in-memory, no I/O) ──
        if (tableIntents.length > 0) {
          console.log(`[Orchestration] Phase A: Updating graph for ${tableIntents.length} table intents (in-memory)`)
          const { executeAtomic: execAtomic } = await import('@/lib/orchestration/atomic-executor')
          for (let i = 0; i < tableIntents.length; i++) {
            const intent = tableIntents[i]
            console.log(`[Orchestration] [Graph-update ${i + 1}/${tableIntents.length}] ${intent.target}`)
            const plan = generateExecutionPlan(intent, finalGraph)
            const atomicResult = await execAtomic(plan, finalGraph, {
              success: true,
              safeToExecute: true,
              failures: [],
              warnings: [],
              simulatedChanges: [],
              estimatedTime: 0,
              estimatedDowntime: 0,
              apiDiff: [],
              dataMigration: { affectedTables: [], estimatedRows: 0, requiresDowntime: false, duration: 0, operations: [] },
            })
            if (!atomicResult.success) {
              console.error(`[Orchestration] ❌ Atomic graph update failed for ${intent.target}: ${atomicResult.failedStep?.error}`)
              return {
                success: false,
                message: `Build failed updating graph for ${intent.target}: ${atomicResult.failedStep?.error}. Nothing was created.`,
                timeline: {
                  id: `batch_failed_${Date.now()}`,
                  timestamp: new Date().toISOString(),
                  title: 'Build failed',
                  description: 'Batch execution failed in graph update phase',
                  category: 'configuration',
                  userVisible: true,
                },
                errors: [atomicResult.failedStep?.error || 'Graph update failed'],
              }
            }
            finalGraph = atomicResult.finalState
            cumulativeChanges = [...cumulativeChanges, ...atomicResult.changes]
          }

          // ── PHASE B: One single executeReal call for ALL tables (schema + migration once) ──
          console.log('[Orchestration] Phase B: Single executeReal() for all tables (one migration)')
          const lastTableIntent = tableIntents[tableIntents.length - 1]
          const lastTablePlan = generateExecutionPlan(lastTableIntent, finalGraph)
          const tableExecutionResult = await Promise.race([
            executeReal(lastTablePlan, finalGraph, projectId),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('EXEC_REAL_TIMEOUT_TABLES')), 90000) // 90s for full table batch
            ),
          ]) as any

          if (!tableExecutionResult.success) {
            console.error(`[Orchestration] ❌ Table migration failed: ${tableExecutionResult.failedStep?.error}`)
            return {
              success: false,
              message: `Build failed during table migration: ${tableExecutionResult.failedStep?.error}. Nothing was created.`,
              timeline: {
                id: `batch_failed_${Date.now()}`,
                timestamp: new Date().toISOString(),
                title: 'Build failed',
                description: 'Table migration step failed',
                category: 'configuration',
                userVisible: true,
              },
              errors: [tableExecutionResult.failedStep?.error || 'Table migration failed'],
            }
          }
          cumulativeChanges = [...cumulativeChanges, ...tableExecutionResult.changes]
          finalGraph = tableExecutionResult.finalState
          console.log('[Orchestration] ✅ Phase B complete — all tables migrated in one pass')
          console.log('🔍 DEBUG: GRAPH AFTER TABLE MIGRATION - Entities:', Object.keys(finalGraph.entities).join(', ') || 'NONE')
        }

        // ── PHASE C: Sequential execution for storage, auth, API intents ──
        for (let i = 0; i < nonTableIntents.length; i++) {
          const intent = nonTableIntents[i]
          console.log(`[Orchestration] [Non-table ${i + 1}/${nonTableIntents.length}] Executing: ${intent.target}`)

          console.log('[Orchestration] STAGE 4a: Generating execution plan...')
          const plan = generateExecutionPlan(intent, finalGraph)
          console.log('[Orchestration] STAGE 4b: About to call executeReal()...')

          const executionResult = await Promise.race([
            executeReal(plan, finalGraph, projectId),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('EXEC_REAL_TIMEOUT')), 60000) // 60s per intent (increased from 30s)
            )
          ]) as any

          console.log('[Orchestration] STAGE 4c: executeReal() returned')

          if (!executionResult.success) {
            console.error(`[Orchestration] [Non-table ${i + 1}/${nonTableIntents.length}] ❌ FAILED`)

            return {
              success: false,
              message: `Build failed: ${executionResult.failedStep?.error}. Nothing was created.`,
              timeline: {
                id: `batch_failed_${Date.now()}`,
                timestamp: new Date().toISOString(),
                title: 'Build failed',
                description: 'Batch execution failed, no changes were made',
                category: 'configuration',
                userVisible: true,
              },
              errors: [executionResult.failedStep?.error || 'Batch execution failed'],
            }
          }

          console.log(`[Orchestration] [Non-table ${i + 1}/${nonTableIntents.length}] ✅ Success`)
          cumulativeChanges = [...cumulativeChanges, ...executionResult.changes]
          finalGraph = executionResult.finalState
          console.log('🔍 DEBUG: GRAPH AFTER EXECUTION - Entities:', Object.keys(finalGraph.entities).join(', ') || 'NONE')
          console.log('🔍 DEBUG: Cumulative changes count:', cumulativeChanges.length)
        }
        
        // Step 3: Validate final graph (for LIVE projects)
        if (isLive) {
          console.log('[Orchestration] 🔍 Validating batch result')
          const validationErrors: string[] = []
          
          const allTables = Object.keys(finalGraph.entities || {})
          if (allTables.length === 0 && batchPlan.entities.length > 0) {
            validationErrors.push('Batch build failed: no tables created')
          }
          
          if (validationErrors.length > 0) {
            return {
              success: false,
              message: `Validation failed: ${validationErrors[0]}`,
              timeline: {
                id: `validation_failed_${Date.now()}`,
                timestamp: new Date().toISOString(),
                title: 'Validation Failed',
                description: validationErrors.join('; '),
                category: 'configuration',
                userVisible: true,
              },
              errors: validationErrors,
            }
          }
          
          console.log('[Orchestration] ✅ Batch validation passed')
        }
        
        // Step 4: Save new graph (atomic)
        console.log('🔍 DEBUG: About to save new graph')
        console.log('🔍 DEBUG: Final graph entities:', Object.keys(finalGraph.entities).join(', ') || 'NONE')
        console.log('🔍 DEBUG: Final cumulative changes:', cumulativeChanges.length)
        
        // ============================================================================
        // IDEMPOTENCY GUARD: Check structural equality before saving
        // ============================================================================
        const previousGraph = await getActiveGraph(projectId)
        if (previousGraph && isStructurallyEqual(previousGraph, finalGraph)) {
          console.log('[Orchestration] ⚠️  No structural changes detected. Skipping graph save.')
          return {
            success: true,
            message: 'No structural changes detected',
            timeline: {
              id: `no-change-${Date.now()}`,
              timestamp: new Date().toISOString(),
              title: 'No changes',
              description: enrichedMessage,
              category: 'data_model' as any,
              userVisible: false,
            },
            executionState: 'NO_CHANGE' as any,
          }
        }
        
        // ============================================================================
        // PHASE 4.3: PROJECTION GUARD ASSERTIONS (dev-only, fail-fast)
        // ============================================================================
        const { assertGraphInvariants, assertProjectionConsistency, repairOrphanRelationships } = await import('./projection-assertions')
        const batchRepairs = repairOrphanRelationships(finalGraph)
        if (batchRepairs.length > 0) {
          console.warn('[Orchestration] ⚠️  Repaired orphan relationships before batch save:', batchRepairs)
        }
        try {
          assertGraphInvariants(finalGraph)
          assertProjectionConsistency(finalGraph)
        } catch (assertionError: any) {
          console.error('[Orchestration] ❌ Projection guard assertion failed (batch):', assertionError.message)
          // Fail fast in development - this indicates a kernel integrity violation
          if (process.env.NODE_ENV !== 'production') {
            throw assertionError
          }
        }
        
        // ============================================================================
        // INTEGRATION MODE: Skip all Prisma persistence
        // ============================================================================
        const isIntegrationMode = process.env.ENGINE_MODE === 'integration'
        if (isIntegrationMode) {
          console.log('[Orchestration] 🧪 INTEGRATION MODE - Storing graph in memory only')
          // Push to history stack instead of replacing
          const history = integrationGraphStore.get(projectId) || []
          history.push(finalGraph)
          integrationGraphStore.set(projectId, history)
          
          return {
            success: true,
            message: 'Backend updated successfully (integration mode)',
            timeline: {
              id: `integration_${Date.now()}`,
              timestamp: new Date().toISOString(),
              title: 'Backend Updated',
              description: enrichedMessage,
              category: 'data_model' as any,
              userVisible: true,
            },
            executionState: 'EXECUTED' as any,
          }
        }
        
        const newGraphRecord = await saveNewGraph(projectId, finalGraph)
        console.log('[Orchestration] ✅ Batch: New graph saved and pointer updated')
        console.log('🔍 DEBUG: New graph ID:', newGraphRecord.id, 'Sequence:', newGraphRecord.sequenceNumber)
        
        // ============================================================================
        // SUGGESTION LAYER: Non-mutating advisory (read-only analysis)
        // ============================================================================
        try {
          // Using static imports now - no dynamic loading
          const suggestions = await generateSuggestions(projectId, finalGraph)
          await storeSuggestions(projectId, newGraphRecord.id, suggestions)
          console.log(`[Orchestration] ✅ Generated ${suggestions.length} suggestions`)
        } catch (suggestionError) {
          // Non-critical: don't fail execution if suggestion generation fails
          console.error('[Orchestration] ⚠️ Suggestion generation failed:', suggestionError)
        }
        
        // ============================================================================
        // BATCH MODE: LOGGING (SAME FOR BOTH)
        // ============================================================================
        const context = await createOrchestrationContext(projectId)
        await saveProjectState(context, finalGraph)
        
        // Record intent lineage for rollback (same as context-enforced-orchestration)
        const artifacts: { type: string; name: string; data: any }[] = []
        
        Object.entries(finalGraph.entities || {}).forEach(([name, entity]) => {
          artifacts.push({ type: 'table', name, data: entity })
        })
        
        Object.entries(finalGraph.storage?.buckets || {}).forEach(([name, bucket]) => {
          artifacts.push({ type: 'storage', name, data: bucket })
        })
        
        Object.entries(finalGraph.apis || {}).forEach(([path, api]) => {
          artifacts.push({ type: 'api', name: path, data: api })
        })
        
        const lineage = await recordIntentLineage(context, userMessage, artifacts)
        
        // Record in database for timeline with rollback data
        await logIntentExecution(
          context,
          userMessage,
          batchIntents[0], // Use first intent as representative
          true,
          cumulativeChanges,
          {
            beforeState: graphForPlanning, // Original state before batch execution
            afterState: finalGraph, // Final state after all batch intents
            lineage,
            lineageHash: lineage.intentHash,
          }
        )
        
        // Generate timeline entry
        const timeline = generateTimelineEntry(batchIntents[0], {
          success: true,
          plan: { planId: 'batch', intentId: batchIntents[0].timestamp, steps: [], estimatedDuration: 0, rollbackPlan: [], createdAt: new Date().toISOString(), status: 'completed' },
          executedSteps: [],
          changes: cumulativeChanges,
          finalState: finalGraph,
          rollbackPerformed: false,
          message: 'Batch execution completed',
        })
        
        // Generate post-execution summary from actual changes (diff-derived)
        console.log('[Orchestration] 📊 DEBUG - Cumulative changes before returning:')
        console.log('[Orchestration]   Total changes:', cumulativeChanges.length)
        console.log('[Orchestration]   Table changes:', cumulativeChanges.filter((c: any) => c.type === 'table').length)
        console.log('[Orchestration]   API changes:', cumulativeChanges.filter((c: any) => c.type === 'api').length)
        console.log('[Orchestration]   All changes:', JSON.stringify(cumulativeChanges, null, 2))

        const batchExecutionResult: ExecutionResult = {
          success: true,
          plan: { planId: 'batch', intentId: batchIntents[0].timestamp, steps: [], estimatedDuration: 0, rollbackPlan: [], createdAt: new Date().toISOString(), status: 'completed' },
          executedSteps: [],
          changes: cumulativeChanges,
          finalState: finalGraph,
          rollbackPerformed: false,
          message: 'Batch execution completed',
        }
        
        const postNarration = generatePostExecutionNarration(batchExecutionResult)
        
        // PHASE 2: Record architectural memory
        // Using static imports now - no dynamic loading
        if (batchExecutionResult.changes) {
          for (const change of batchExecutionResult.changes) {
            if (change.type === 'table' && change.action === 'created') {
              await recordSchemaChange(
                projectId,
                'create',
                change.target || 'unknown',
                `Created via batch mode: ${batchPlan.summary}`
              )
            }
          }
        }
        
        // ============================================================================
        // POST-EXECUTION: SCHEMA EVOLUTION ANALYSIS (Elite Agent Phase 4)
        // ============================================================================
        let evolutionReport: any = null
        try {
          // Using static imports now - no dynamic loading
          console.log('[Schema Evolution] Analyzing architecture health...')
          
          evolutionReport = analyzeSchemaEvolution(finalGraph)
          
          console.log('[Schema Evolution] Health Score:', evolutionReport.health.score)
          console.log('[Schema Evolution] Grade:', evolutionReport.health.grade)
          console.log('[Schema Evolution] Issues:', evolutionReport.issues.length)
          console.log('[Schema Evolution] Suggestions:', evolutionReport.suggestions.length)
        } catch (error: any) {
          console.log('[Schema Evolution] Skipped:', error.message)
        }
        
        // ============================================================================
        // BACKGROUND: AUTONOMOUS SUGGESTIONS (Elite Agent Phase 6)
        // ============================================================================
        // Trigger proactive suggestions after a delay (non-blocking)
        // FIXED: Properly handle async background task to prevent test interference
        // SKIP entirely in test environment to prevent async leaks
        if (process.env.NODE_ENV !== 'test') {
          void (async () => {
            try {
              // Using static imports now - no dynamic loading
              console.log('[Autonomous Guidance] Generating proactive suggestions...')
              
              const suggestions = await generateProactiveSuggestions(
                finalGraph,
                projectId
              )
              
              console.log('[Autonomous Guidance] Generated', suggestions.suggestions?.length || 0, 'suggestions')
              // Note: In production, emit this via SSE or polling endpoint
            } catch (error: any) {
              // Silent failure - background task should not affect main execution
              console.log('[Autonomous Guidance] Skipped:', error.message)
            }
          })()
        }
        
        markTime('final_success')
        
        // ============================================================================
        // LIGHTWEIGHT POST-EXECUTION: Small heuristics + LLM will do reasoning
        // ============================================================================
        // Simple 20-line heuristic for relationship suggestions
        let relationshipSuggestions: RelationshipInferenceResult[] = []
        const newlyCreatedTables: string[] = []
        
        if (batchExecutionResult.changes) {
          for (const change of batchExecutionResult.changes) {
            if (change.type === 'table' && change.action === 'created' && change.target) {
              newlyCreatedTables.push(change.target)
              
              // Simple heuristic: check if pattern matches
              const existingTables = Object.keys(finalGraph.entities)
              const suggestion = suggestRelationshipHeuristic(change.target, existingTables)
              
              if (suggestion.suggest && suggestion.to) {
                relationshipSuggestions.push({
                  tableName: change.target,
                  hasSuggestion: true,
                  suggestion: {
                    id: `rel_${change.target}_${suggestion.to}_${Date.now()}`,
                    tableName: change.target,
                    suggestedRelation: {
                      from: change.target,
                      to: suggestion.to,
                      type: 'many-to-many',
                      foreignKeyField: `${suggestion.to.replace(/s$/, '').toLowerCase()}Id`,
                      reason: suggestion.reason
                    },
                    confidence: 'high',
                    priority: 'high'
                  },
                  allPossibleRelations: [{ to: suggestion.to, reason: suggestion.reason, confidence: 'high' }]
                })
                console.log(`[Smart Relationship] 💡 Suggested: ${change.target} → ${suggestion.to}`)
              }
            }
          }
        }
        
        // Build architect-style message with AI clarity (like Bolt/Cursor)
        let enhancedMessage = postNarration
        
        if (newlyCreatedTables.length > 0) {
          const tableName = newlyCreatedTables[0]
          const pattern = getFeaturePattern(tableName)
          const existingTables = Object.keys(finalGraph.entities)
          const relationSuggestion = suggestRelationshipHeuristic(tableName, existingTables)
          
          // AI clarity format: Understood → Will do → Suggestion
          const messages: string[] = []
          
          // AI understood
          messages.push(`**AI understood:** You want to add ${tableName} tracking.`)
          
          // AI will do
          messages.push(`\n**AI will:**`)
          messages.push(`• Create **${tableName}** table`)
          if (pattern) {
            messages.push(`• Include fields: ${pattern.fields.slice(0, 4).join(', ')}`)
          }
          
          // AI suggestion (if applicable)
          if (relationSuggestion.suggest && relationSuggestion.to) {
            messages.push(`\n**AI suggestion:**`)
            messages.push(`${relationSuggestion.reason}.`)
            messages.push(`Should I link **${tableName}** to **${relationSuggestion.to}**?`)
          }
          
          enhancedMessage = messages.join('\n')
        }
        
        // ============================================================================
        // PERFORMANCE REPORT
        // ============================================================================
        const totalDuration = Date.now() - perfStart
        console.log('⏱️  ORCHESTRATION PERFORMANCE:')
        console.log(`   Total duration: ${totalDuration}ms`)
        Object.entries(perfMarkers).forEach(([label, time]) => {
          console.log(`   ${label}: ${time}ms`)
        })
        
        return {
          success: true,
          message: enhancedMessage,
          executionState: 'EXECUTED', // Batch mode creates real infrastructure
          timeline,
          executionResult: batchExecutionResult,
          advancedView: projectAdvancedView(finalGraph),
          narration: {
            pre: `Building: ${batchPlan.summary}`,
            post: enhancedMessage,
          },
          // Elite Agent intelligence layers
          evolutionReport, // Phase 4: Schema health
          // Smart relationship suggestions (non-blocking improvements)
          relationshipSuggestions: relationshipSuggestions.length > 0 ? relationshipSuggestions : undefined,
          // 🔒 CRITICAL: NO generic suggestions, NO "Add more?", NO questions in batch mode
          suggestions: undefined,
        }
      }
    }
    
    // ============================================================================
    // FALLBACK: Normal incremental mode (if batch disabled or failed)
    // ============================================================================
    
    // ============================================================================
    // INTENT DOWNGRADE PREVENTION
    // ============================================================================
    // CRITICAL: If semantic understanding clearly indicated a DATA_MODEL intent
    // (e.g., "create a review table") but inference/batch failed, we MUST NOT
    // downgrade to QUERY/clarification. Instead, return PREVIEW with what we understood.
    // This is what makes AI feel powerful vs weak.
    // ============================================================================
    
    const hasCreateIntent = semanticUnderstandingResult?.crudIntent?.create?.length > 0
    const isDataModelIntent = hasCreateIntent ||
                              /create|add|build|make/i.test(semanticUnderstandingResult?.intentSummary || '')
    const ambiguityIsLow = semanticUnderstandingResult?.ambiguityScore < 0.7

    // GUARD: Don't downgrade storage/auth feature requests into entity creation.
    // E.g. "implement filestorage" must NOT become "create files table".
    // Let parseIntent() handle these properly via its STORAGE/AUTH patterns.
    const isStorageOrAuthFeatureRequest =
      /\b(file.?storage|filestorage|storage|upload|bucket)\b/i.test(normalizedUserMessage) &&
      /\b(implement|enable|add|setup|configure|do|build|create|activate|turn.?on)\b/i.test(normalizedUserMessage)

    if (!options?.forceCommit && !isStorageOrAuthFeatureRequest && isDataModelIntent && ambiguityIsLow && semanticUnderstandingResult?.probableEntities?.length > 0) {
      console.log('[Intent Downgrade Prevention] Semantic intent is DATA_MODEL with low ambiguity')
      console.log('[Intent Downgrade Prevention] Probable entities:', semanticUnderstandingResult.probableEntities)
      
      // Generate a draft proposal from semantic understanding alone
      // This prevents the "weak AI" behavior of falling back to clarification
      const fallbackEntities = semanticUnderstandingResult.probableEntities.map(entityName => ({
        name: entityName.toLowerCase().replace(/\s+/g, '_'),
        fields: [
          { name: 'id', type: 'uuid' as const, primary: true, required: true },
          { name: 'created_at', type: 'timestamp' as const, required: true },
          { name: 'updated_at', type: 'timestamp' as const, required: true },
        ]
      }))
      
      const fallbackAssumptions = [
        'Using standard schema structure',
        'Fields will be inferred from entity type',
      ]
      
      const fallbackMessage = `I'll create ${fallbackEntities.map(e => `**${e.name}**`).join(', ')}.\n\n` +
        `This structure supports ${semanticUnderstandingResult.intentSummary?.toLowerCase() || 'your requirements'}.\n\n` +
        `**Proceed with this structure?** Or tell me what should change.`
      
      console.log('[Intent Downgrade Prevention] ✅ Generated fallback proposal')
      
      return {
        success: true,
        message: fallbackMessage,
        timeline: {
          id: `preview_fallback_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Architecture Proposal',
          description: 'Review the proposed structure and confirm',
          category: 'configuration',
          userVisible: true,
        },
        executionState: 'PREVIEW',
        requiresCommitment: true,
        proposedEntities: fallbackEntities,
        assumptions: fallbackAssumptions,
        semanticUnderstanding,
        confidence: 'MEDIUM',
        narration: {
          pre: fallbackMessage,
        },
      }
    }

    // Phase 1: Parse intent (Now with state context + conversation history)
    console.log('[Orchestration] Phase 1: Parsing intent')
    // Resolve pronouns using conversation history ("it", "that table" → actual table name)
    const resolvedMessage = resolveMessageWithHistory(userMessage, options?.conversationHistory || [])
    if (resolvedMessage !== userMessage) {
      console.log(`[Orchestration] Pronoun resolved: "${userMessage}" → "${resolvedMessage}"`)
    }
    const intent = await parseIntent(resolvedMessage, graphForPlanning)
    
    // PHASE 1.5: STRUCTURED INTENT VALIDATION (CRITICAL GATEWAY)
    // Every intent must pass schema validation before proceeding
    console.log('[Orchestration] Phase 1.5: Validating structured intent schema')
    const { validateStructuredIntent, migrateToStructuredIntent } = await import('./intent-validation')
    const structuredIntent = migrateToStructuredIntent(intent)
    const validationResult = validateStructuredIntent(structuredIntent)
    
    if (!validationResult.success) {
      // Type guard ensures validationResult has 'errors' property
      const errorMessages = 'errors' in validationResult ? validationResult.errors : ['Unknown validation error']
      console.error('[Orchestration] ❌ Intent validation failed:', errorMessages)
      
      // Log validation failure
      const context = await createOrchestrationContext(projectId).catch(() => ({
        projectId,
        executionId: `exec_${Date.now()}`,
        timestamp: new Date(),
        source: 'orchestration' as const,
      }))
      
      await logIntentExecution(
        context,
        userMessage,
        intent,
        false,
        { type: 'validation_failure', errors: errorMessages }
      )
      
      return {
        success: false,
        message: `Intent validation failed: ${errorMessages.join(', ')}`,
        errors: errorMessages,
        timeline: {
          id: `validation_failure_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Intent Validation Failed',
          description: `The intent could not be validated: ${errorMessages[0]}`,
          category: 'configuration',
          userVisible: true,
        },
        narration: {
          pre: 'The system detected an issue with the request structure and prevented execution for safety.',
        },
      }
    }
    
    console.log('[Orchestration] ✅ Intent validation passed')
    
    // STAGE 3: BYPASS CLARIFICATION FOR OBVIOUS COMMANDS
    // If user clearly asks to build something, NEVER ask clarification
    if (intent.constraints.isAmbiguous && isObviousBuildCommand(userMessage)) {
      console.log('[Orchestration] 🚀 Obvious build command detected - bypassing clarification')
      intent.constraints.isAmbiguous = false
      intent.status = 'READY'
    }
    
    // PHASE 10: Guardrail, Ambiguity, and Beginner Guidance handling (CHECK FIRST)
    // These are DRAFT intents that need clarification - handle before commitment gate
    // EXCEPTION: When forceCommit=true (user explicitly clicked "Build it"), skip
    // ambiguity/guidance/demo checks and proceed to execution. Only guardrails remain.
    if ((!options?.forceCommit && (intent.constraints.isGuardrail || intent.constraints.isAmbiguous || intent.constraints.isBeginnerGuidance || intent.constraints.isDemo)) ||
        (options?.forceCommit && intent.constraints.isGuardrail)) {
      const isGuidance = intent.constraints.isBeginnerGuidance
      const isAmbiguous = intent.constraints.isAmbiguous
      const isDemo = intent.constraints.isDemo
      
      // Log for analytics even if no execution happens
      const context = await createOrchestrationContext(projectId).catch(() => ({
        projectId,
        executionId: `exec_${Date.now()}`,
        timestamp: new Date(),
        source: 'orchestration' as const,
      }))
      
      await logIntentExecution(
        context,
        userMessage,
        intent,
        !!(isGuidance || isDemo),
        { type: isAmbiguous ? 'clarification' : isGuidance ? 'guidance' : isDemo ? 'demo' : 'guardrail' }
      )

      // Use AI conversation message instead of intent message
      const message = conversation.needsClarification ? conversation.message : intent.constraints.message

      return {
        success: isGuidance || isDemo, // Guidance and Demo are successful interactions, just not executions
        message,
        suggestions: intent.constraints.suggestions, // Pass behavioral suggestions
        timeline: {
          id: `${isAmbiguous ? 'clarification' : isGuidance ? 'guidance' : isDemo ? 'demo' : 'guardrail'}_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: isAmbiguous ? 'Clarification Needed' : isGuidance ? 'Product Guidance' : isDemo ? 'Demo Mode' : 'Feature Suggestion',
          description: message,
          category: 'configuration',
          userVisible: true,
        },
        errors: (isGuidance || isDemo) ? undefined : [message],
        narration: {
          pre: message // Show AI conversation as narration
        },
        // NEW: Set clarification flags for ambiguous intents
        requiresClarification: isAmbiguous,
        clarificationQuestion: isAmbiguous ? message : undefined,
        executionState: isAmbiguous ? 'CLARIFICATION_NEEDED' : undefined,
      }
    }
    
    // ============================================================================
    // COMMITMENT GATE: The Bridge Between Conversation and Execution
    // ============================================================================
    // If intent status is READY, AI is confident but user hasn't confirmed yet.
    // We MUST return requiresCommitment=true and STOP before execution.
    // Only COMMITTED intents are allowed to proceed to execution.
    // ============================================================================
    
    // If forceCommit=true, user clicked "Build now" - upgrade intent to COMMITTED
    // This works regardless of initial status (READY or DRAFT) since the user
    // already reviewed the plan and explicitly confirmed.
    if (options?.forceCommit && !intent.constraints.isGuardrail) {
      console.log(`[Orchestration] Force commit enabled - upgrading intent (${intent.status}) to COMMITTED`)
      intent.status = 'COMMITTED'
    }
    
    if (intent.status === 'READY') {
      console.log('[Orchestration] Intent is READY - awaiting user commitment')
      
      // Use LLM's response and plan
      const readyMessage = conversation.message || llmResponse || "I'm ready to build this."
      
      return {
        success: true,
        requiresCommitment: true, // 🔒 CRITICAL: Triggers "Build now" confirmation UI
        executionState: 'PREVIEW', // Intent ready but not executed yet
        intent, // Pass full intent to frontend
        message: readyMessage,
        timeline: {
          id: `ready_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Ready to build',
          description: llmExplanation || 'Implementation plan ready',
          category: 'configuration',
          userVisible: true,
        },
        narration: {
          pre: readyMessage
        },
        actionPlan: {
          summary: llmExplanation || 'Implementation plan',
          steps: llmPlan || [],
          estimatedTime: 'A few minutes',
        }
      }
    }
    
    // 🚨 EXECUTION GUARD: Block execution unless intent is COMMITTED
    if (intent.status !== 'COMMITTED' && intent.status !== 'EXECUTED') {
      console.warn(`[Orchestration] Blocking execution - intent status is ${intent.status}, not COMMITTED`)
      
      return {
        success: false,
        message: 'Intent must be committed before execution',
        timeline: {
          id: `blocked_not_committed_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Execution blocked',
          description: 'User confirmation required',
          category: 'configuration',
          userVisible: false,
        },
        errors: ['Intent not committed'],
      }
    }
    
    console.log('[Orchestration] Intent is COMMITTED - proceeding to execution')
    console.log(`[Orchestration] Intent status: ${intent.status}`)
    console.log(`[Orchestration] Intent type: ${intent.intent_type}`)
    console.log(`[Orchestration] Intent action: ${intent.action}`)
    
    // PHASE 0: Handle Intent Supersession (Actually... / Instead...)
    if (intent.isOverride) {
      const context = await createOrchestrationContext(projectId).catch(() => null)
      if (context) {
        const lastIntent = await getLastSuccessfulIntent(context)
        if (lastIntent) {
          console.log(`[Orchestration] Intent "${userMessage}" supersedes "${lastIntent.intent}"`)
          // Mark last intent as superseded in its metadata
          lastIntent.canonicalIntent.isSuperseded = true
          lastIntent.canonicalIntent.supersededBy = intent.source_text
        }
      }
    }

    // PHASE 12: Handle Rollback Intent directly (No Narration)
    if (intent.intent_type === 'ROLLBACK') {
      console.log('[Orchestration] Phase 12: Handling undo via graph pointer swap')
      
      // Using static imports now - no dynamic loading
      const previousGraphId = await getPreviousGraphId(projectId)
      
      if (!previousGraphId) {
        return {
          success: false,
          message: 'Cannot undo: No previous state available',
          timeline: {
            id: `undo_failed_${Date.now()}`,
            timestamp: new Date().toISOString(),
            title: 'Undo unavailable',
            description: 'This is the initial version',
            category: 'configuration',
            userVisible: true,
          },
        }
      }
      
      // Perform undo
      await undoToGraph(projectId, previousGraphId)
      
      return {
        success: true,
        message: 'Change undone successfully',
        timeline: {
          id: `undo_success_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Change undone',
          description: 'Reverted to previous state',
          category: 'configuration',
          userVisible: true,
        },
      }
    }

    // PHASE 12.5: Handle Frontend Connection Intent (CONNECT/DISCONNECT)
    if (intent.intent_type === 'FRONTEND_CONNECTION') {
      console.log('[Orchestration] Phase 12.5: Handling frontend connection intent')
      // Using static imports now - no dynamic loading
      
      const frontendUrl = intent.target || intent.constraints.frontendUrl
      
      if (!frontendUrl) {
        return {
          success: false,
          message: 'Please provide a valid URL to connect (e.g., http://localhost:5173 or https://myapp.com)',
          timeline: {
            id: `connect_failed_${Date.now()}`,
            timestamp: new Date().toISOString(),
            title: 'Connection failed',
            description: 'No URL provided',
            category: 'configuration',
            userVisible: true,
          },
          executionState: 'REFUSED',
          refusalReason: 'INSUFFICIENT_DOMAIN_CONTEXT',
        }
      }
      
      // Check for explicit confirmation (user typed CONNECT or DISCONNECT)
      // OR if forceCommit is enabled (user clicked "Build now")
      const isExplicitConfirmation = /^(CONNECT|DISCONNECT)$/i.test(userMessage.trim())
      const shouldForceExecution = isExplicitConfirmation || options?.forceCommit
      
      // Resolve project owner — engine requires userId for audit-log writes.
      const ownerLookup = await (await import('@/lib/db/prisma')).prisma.project.findUnique({
        where: { id: projectId },
        select: { userId: true },
      })
      const ownerUserId = ownerLookup?.userId ?? 'system'

      if (intent.action === 'CONNECT') {
        const result = await connectFrontend({
          projectId,
          frontendUrl,
          userId: ownerUserId,
          confirmedBy: 'CHAT',
          force: shouldForceExecution,
        })
        
        return {
          success: result.success,
          message: result.message,
          timeline: {
            id: `connect_${Date.now()}`,
            timestamp: new Date().toISOString(),
            title: result.requiresConfirmation ? 'Connection preview' : 'Frontend connected',
            description: result.message,
            category: 'configuration',
            userVisible: true,
          },
          requiresCommitment: result.requiresConfirmation,
          executionState: result.requiresConfirmation ? 'PREVIEW' : 'EXECUTED',
        }
      } else if (intent.action === 'DISCONNECT') {
        const result = await disconnectFrontend({
          projectId,
          origin: frontendUrl,
          userId: ownerUserId,
          confirmedBy: 'CHAT',
          force: shouldForceExecution,
        })
        
        return {
          success: result.success,
          message: result.message,
          timeline: {
            id: `disconnect_${Date.now()}`,
            timestamp: new Date().toISOString(),
            title: result.requiresConfirmation ? 'Disconnection preview' : 'Frontend disconnected',
            description: result.message,
            category: 'configuration',
            userVisible: true,
          },
          requiresCommitment: result.requiresConfirmation,
          executionState: result.requiresConfirmation ? 'PREVIEW' : 'EXECUTED',
        }
      }
    }

    // PHASE 11: Pre-Execution AI Narration
    console.log('[Orchestration] Phase 11: Generating pre-execution narration')
    // Use AI conversation message as pre-narration
    const preNarration = conversation.message

    // Phase 3: Validate safety
    console.log('[Orchestration] Phase 3: Validating safety')
    const safetyResult = await validateIntentSafety(intent, graphForPlanning)
    
    if (!safetyResult.safe) {
      // AI Explanation for the safety block
      const aiExplanation = await explainDecision(intent, 'SAFETY_BLOCK', { 
        violations: safetyResult.violations.map(v => v.reason) 
      })

      return {
        success: false,
        message: aiExplanation || safetyResult.userMessage,
        timeline: {
          id: `blocked_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Change blocked for safety',
          description: aiExplanation || safetyResult.userMessage,
          category: 'configuration',
          userVisible: true,
        },
        errors: safetyResult.violations.map(v => v.reason),
      }
    }
    
    // Phase 4: Generate execution plan
    console.log('[Orchestration] Phase 4: Generating execution plan')
    const plan = generateExecutionPlan(
      safetyResult.safeAlternative || intent,
      graphForPlanning
    )
    const planValidation = validatePlan(plan)
    
    // PHASE 11: Pre-Execution Narration from Plan Diff
    console.log('[Orchestration] Phase 11: Generating diff-derived pre-execution narration')
    const diffDerivedPreNarration = generatePreExecutionNarration(intent, plan)
    
    if (!planValidation.valid) {
      return {
        success: false,
        message: 'Something didn\'t work. Nothing was changed.',
        timeline: {
          id: `invalid_plan_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Invalid execution plan',
          description: planValidation.errors.join('. '),
          category: 'configuration',
          userVisible: false,
        },
        errors: planValidation.errors,
      }
    }
    
    // Phase 5: Dry-run simulation
    console.log('[Orchestration] Phase 5: Running dry-run simulation')
    const dryRun = await runDryRun(plan, graphForPlanning)
    
    if (!dryRun.safeToExecute) {
      const failureReasons = dryRun.failures
        .filter(f => f.blocking)
        .map(f => f.reason)
      
      return {
        success: false,
        message: 'Something didn\'t work. Nothing was changed.',
        timeline: {
          id: `dryrun_failed_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Simulation failed',
          description: failureReasons.join('. '),
          category: 'configuration',
          userVisible: false,
        },
        errors: failureReasons,
      }
    }
    
    // Phase 7: Check for migrations
    console.log('[Orchestration] Phase 7: Checking for migrations')
    const migrationStrategy = generateMigrationStrategy(intent, graphForPlanning)
    
    if (migrationStrategy) {
      console.log('[Orchestration] Executing silent migration')
      const migrationResult = await executeMigration(migrationStrategy, graphForPlanning)
      
      if (!migrationResult.success) {
        return {
          success: false,
          message: 'Something didn\'t work. Nothing was changed.',
          timeline: {
            id: `migration_failed_${Date.now()}`,
            timestamp: new Date().toISOString(),
            title: 'Migration failed',
            description: migrationResult.message,
            category: 'configuration',
            userVisible: false,
          },
          errors: ['Migration failed'],
        }
      }
    }
    
    // Phase 6: Atomic execution
    console.log('[Orchestration] Phase 6: Executing atomically')
    
    // 🚀 CRITICAL: Use REAL executor instead of simulation
    const USE_REAL_EXECUTION = true // Toggle to enable real execution
    
    let executionResult: ExecutionResult
    let graph: BackendStateGraph
    
    // ============================================================================
    // UNIFIED POINTER-BASED MUTATION (PRIVATE AND LIVE)
    // ============================================================================
    
    // Step 1: Get active graph (or create initial)
    const activeGraph = await getActiveGraph(projectId)
    
    if (!activeGraph) {
      // First time - create initial empty graph
      const emptyGraph = createEmptyGraph(projectId)
      await createInitialGraph(projectId, emptyGraph)
      graph = emptyGraph
    } else {
      graph = activeGraph
    }
    
    console.log('[Orchestration] 📖 Loaded active graph, version:', graph.version)
    
    // Step 2: Execute mutation (in memory)
    if (USE_REAL_EXECUTION) {
      console.log('[Orchestration] 🚀 Executing mutation in memory')
      // Using static imports now - no dynamic loading
      executionResult = await executeReal(plan, graph, projectId)
    } else {
      executionResult = await executeAtomic(plan, graph, dryRun)
    }
    
    if (!executionResult.success) {
      return {
        success: false,
        message: isLive ? 'Live backend update failed. Your backend is unchanged.' : 'Something didn\'t work. Nothing was changed.',
        executionState: 'EXECUTED',
        errors: [executionResult.failedStep?.error || 'Mutation failed'],
        timeline: {
          id: `mutation_failed_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Mutation Failed',
          description: executionResult.message,
          category: 'configuration',
          userVisible: true,
        },
      }
    }
    
    // Step 3: Validate mutated graph (for LIVE projects)
    if (isLive) {
      console.log('[Orchestration] 🔍 Validating mutated graph')
      const validationErrors: string[] = []
      
      // Validate schema integrity
      const allTables = Object.keys(executionResult.finalState.entities || {})
      if (allTables.length === 0 && Object.keys(graph.entities || {}).length > 0) {
        validationErrors.push('All tables disappeared after mutation')
      }
      
      // Validate foreign key integrity
      for (const tableName of allTables) {
        const entity = executionResult.finalState.entities[tableName]
        const fields = Object.values(entity?.fields || {})
        for (const field of fields) {
          if (field.type === 'relation' && (field as any).relationTo) {
            const relatedTable = (field as any).relationTo
            if (!executionResult.finalState.entities[relatedTable]) {
              validationErrors.push(`Foreign key broken: ${tableName}.${field.name} → ${relatedTable}`)
            }
          }
        }
      }
      
      if (validationErrors.length > 0) {
        console.error('[Orchestration] ❌ Validation failed:', validationErrors)
        
        return {
          success: false,
          message: `Live update validation failed: ${validationErrors[0]}`,
          executionState: 'EXECUTED',
          errors: validationErrors,
          timeline: {
            id: `validation_failed_${Date.now()}`,
            timestamp: new Date().toISOString(),
            title: 'Validation Failed',
            description: validationErrors.join('; '),
            category: 'configuration',
            userVisible: true,
          },
        }
      }
      
      console.log('[Orchestration] ✅ Validation passed')
    }
    
    // Step 4: Save new graph (creates immutable BackendGraph row + atomic pointer swap)
    // With automatic retry on concurrency conflicts
    const MAX_RETRIES = 3
    const RETRY_DELAY_MS = 50
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await saveNewGraph(projectId, executionResult.finalState)
        console.log('[Orchestration] ✅ New graph saved and pointer updated')
        
        // Log retry if it took multiple attempts
        if (attempt > 1) {
          logger.info('Mutation succeeded after retry', {
            projectId: projectId.substring(0, 8),
            attempts: attempt,
            mutation: userMessage.substring(0, 50),
          })
        }
        
        break // Success - exit retry loop
      } catch (error: any) {
        const isConflict = error.message?.includes('CONCURRENCY_CONFLICT')
        const shouldRetry = isConflict && attempt < MAX_RETRIES
        
        if (shouldRetry) {
          const delayMs = RETRY_DELAY_MS * attempt
          
          logger.info('Concurrency conflict detected, retrying', {
            projectId: projectId.substring(0, 8),
            attempt,
            maxRetries: MAX_RETRIES,
            delayMs,
            mutation: userMessage.substring(0, 50),
          })
          
          // Wait with exponential backoff
          await new Promise(resolve => setTimeout(resolve, delayMs))
          
          // Re-fetch latest graph for next attempt
          const latestGraph = await getActiveGraph(projectId)
          if (latestGraph) {
            console.log(`[Orchestration] 🔄 Retrying with updated graph (version ${latestGraph.version})`)
            // Update execution result with latest graph state
            executionResult.finalState = latestGraph
          }
          
          continue // Retry
        }
        
        // Max retries exceeded or non-conflict error
        if (isConflict) {
          logger.warn('Max retries exceeded for concurrency conflict', {
            projectId: projectId.substring(0, 8),
            attempts: attempt,
            mutation: userMessage.substring(0, 50),
          })
          
          return {
            success: false,
            message: 'Another request modified this project. Please retry your change.',
            executionState: 'EXECUTED' as const,
            errors: ['Concurrent modification detected - max retries exceeded'],
            timeline: {
              id: `concurrency_conflict_${Date.now()}`,
              timestamp: new Date().toISOString(),
              title: 'Concurrent Modification',
              description: 'Project was modified by another request - please retry',
              category: 'configuration' as const,
              userVisible: true,
            },
          }
        }
        
        // Re-throw other errors
        throw error
      }
    }
    
    if (!executionResult.success) {
      return {
        success: false,
        message: 'Something didn\'t work. Nothing was changed.',
        timeline: {
          id: `execution_failed_${Date.now()}`,
          timestamp: new Date().toISOString(),
          title: 'Execution failed',
          description: executionResult.message,
          category: 'configuration',
          userVisible: false,
        },
        errors: [executionResult.failedStep?.error || 'Unknown error'],
      }
    }
    
    // ============================================================================
    // LOGGING PHASE - Record intent execution in IntentLog
    // ============================================================================
    const context = await createOrchestrationContext(projectId).catch(() => ({
      projectId,
      executionId: `exec_${Date.now()}`,
      timestamp: new Date(),
      source: 'orchestration' as const,
    }))

    const lineage = await recordIntentLineage(context, userMessage, 
      executionResult.changes.map(c => ({
        type: c.type,
        name: c.target,
        data: c.details
      }))
    )

    await logIntentExecution(
      context,
      userMessage,
      intent,
      true,
      executionResult.changes,
      {
        beforeState: graphForPlanning, // Original graph before execution
        afterState: executionResult.finalState,
        lineage,
        lineageHash: executionResult.finalState.lineageHash
      },
      isLive, // liveMutation flag
      'SUCCESS' // liveMutationStatus
    )

    // Note: Graph already saved via pointer swap (LIVE) or saveGraph() (PRIVATE)
    // Just need to save project state for context
    await saveProjectState(context, executionResult.finalState)
    
    // Phase 8: Generate timeline entry
    console.log('[Orchestration] Phase 8: Generating timeline')
    const timeline = generateTimelineEntry(intent, executionResult)

    // PHASE 11: Post-Execution AI Narration (DIFF-DERIVED)
    console.log('[Orchestration] Phase 11: Generating post-execution narration from results')
    // Derive narration from actual execution results, not speculation
    const postNarration = generatePostExecutionNarration(executionResult)
    
    // Phase 9: Project advanced view
    console.log('[Orchestration] Phase 9: Projecting advanced view')
    const advancedView = projectAdvancedView(executionResult.finalState)
    
    // Generate structured build summary for professional UI
    const createdEntities = executionResult.changes
      .filter(c => c.action === 'created' && c.type === 'table')
      .map(c => c.target)
    const uniqueEntities = Array.from(new Set(createdEntities))
    
    const capabilities: string[] = []
    if (executionResult.changes.some(c => c.type === 'auth')) {
      capabilities.push('Authentication')
    }
    if (executionResult.changes.some(c => c.type === 'storage')) {
      capabilities.push('File Uploads')
    }
    if (createdEntities.some(e => e.toLowerCase().includes('activity') || e.toLowerCase().includes('log'))) {
      capabilities.push('Activity Tracking')
    }
    
    const buildSummary = {
      summary: postNarration,
      entities: uniqueEntities,
      capabilities
    }

    await recordBackendExecutionMemory({
      projectId,
      userMessage,
      canonicalIntent: intent,
      beforeState: graphForPlanning,
      afterState: executionResult.finalState,
      changes: executionResult.changes,
      executionId: context.executionId,
      rollbackAvailable: executionResult.changes.length > 0,
      rollbackId: context.executionId,
    }).catch((error) => {
      console.error('[Operational Memory] Failed to record orchestration receipt:', error)
    })
    
    const durationMs = Date.now() - startTime
    
    // Log successful mutation
    logger.mutation('Mutation completed successfully', {
      projectId,
      intent: userMessage.substring(0, 100),
      success: true,
      durationMs,
      graphVersion: executionResult.finalState?.version || 0,
      executionState: 'EXECUTED',
    })
    
    return {
      success: true,
      message: postNarration,
      executionState: 'EXECUTED',
      timeline,
      executionResult,
      advancedView,
      buildSummary,
      narration: {
        pre: diffDerivedPreNarration,
        post: postNarration
      }
    }
    
  } catch (error) {
    const durationMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    
    logger.error('Mutation failed', error as Error, {
      projectId: projectId.substring(0, 8),
      durationMs,
      intent: userMessage.substring(0, 100),
    })
    
    recordError(error instanceof Error ? error.constructor.name : 'UnknownError')
    
    return {
      success: false,
      message: 'Something didn\'t work. Nothing was changed.',
      executionState: 'REFUSED',
      timeline: {
        id: `fatal_${Date.now()}`,
        timestamp: new Date().toISOString(),
        title: 'System error',
        description: errorMessage,
        category: 'configuration',
        userVisible: false,
      },
      errors: [errorMessage],
    }
  }
}
