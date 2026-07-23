/**
 * Structured Intent Schema Validation
 * 
 * CRITICAL GATEWAY: Every intent must pass schema validation before execution
 * 
 * Pipeline: Natural Language → Parser/AI Planner → Schema Validation → Execution Engine
 * 
 * If validation fails: Reject intent, never attempt mutation
 */

import { z } from 'zod'
import type { CanonicalIntent, IntentType, Domain, Action, IntentStatus } from './types'

/**
 * Field schema for structured intents
 */
const FieldSchema = z.object({
  name: z.string().min(1, 'Field name cannot be empty'),
  type: z.enum(['string', 'number', 'boolean', 'date', 'json', 'reference', 'relation']),
  required: z.boolean().optional().default(false),
  unique: z.boolean().optional(),
  default: z.any().optional(),
  referenceTo: z.string().optional(), // For reference/relation fields
})

export type ValidatedField = z.infer<typeof FieldSchema>

/**
 * Relationship schema for structured intents
 */
const RelationshipSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']),
  foreignKey: z.string().optional(),
})

export type ValidatedRelationship = z.infer<typeof RelationshipSchema>

/**
 * Core structured intent schema
 * 
 * This is the CONTRACT between AI planner and execution engine
 */
const StructuredIntentSchema = z.object({
  // Core identification
  intent_type: z.enum([
    'FEATURE_ADD',
    'FEATURE_REMOVE',
    'FEATURE_MODIFY',
    'DATA_MODEL_ADD',
    'DATA_MODEL_REMOVE',
    'DATA_MODEL_MODIFY',
    'ACCESS_CONTROL',
    'DEPLOYMENT',
    'INTEGRATION',
    'QUERY',
    'ROLLBACK',
    'RESTORE',
    'EXPORT',
    'INFRASTRUCTURE',
    'FRONTEND_CONNECTION',
  ] as const),
  
  domain: z.enum([
    'AUTH',
    'STORAGE',
    'DATABASE',
    'API',
    'DEPLOYMENT',
    'INTEGRATION',
    'MONITORING',
    'SYSTEM',
  ] as const),
  
  action: z.enum([
    'ENABLE',
    'DISABLE',
    'CREATE',
    'DELETE',
    'UPDATE',
    'RESTRICT',
    'ALLOW',
    'DEPLOY',
    'UNDO',
    'CONNECT',
    'DISCONNECT',
  ] as const),
  
  // Target entity/feature
  target: z.string().min(1, 'Target entity/feature required'),
  feature: z.string().optional(),
  
  // Structured data (replaces free-form constraints)
  fields: z.array(FieldSchema).optional(),
  relationships: z.array(RelationshipSchema).optional(),
  
  // Metadata
  reason: z.string().optional(),
  source_text: z.string(),
  timestamp: z.string(),
  confidence: z.number().min(0).max(1),
  isOverride: z.boolean().optional(),
  status: z.enum(['DRAFT', 'READY', 'COMMITTED', 'EXECUTED'] as const),
  
  // Legacy constraints (for backward compatibility during migration)
  constraints: z.record(z.any()).optional(),
})

export type StructuredIntent = z.infer<typeof StructuredIntentSchema>

/**
 * Validation result types
 */
export interface ValidationSuccess {
  success: true
  intent: StructuredIntent
}

export interface ValidationFailure {
  success: false
  errors: string[]
  originalIntent: Partial<CanonicalIntent>
}

export type ValidationResult = ValidationSuccess | ValidationFailure

/**
 * GATEWAY FUNCTION: Validate intent before execution
 * 
 * This is the CONTRACT enforcement point
 * Failed validation = ZERO state change
 */
export function validateStructuredIntent(
  intent: Partial<CanonicalIntent>
): ValidationResult {
  try {
    // Schema validation
    const validated = StructuredIntentSchema.parse(intent)
    
    // Additional semantic validation
    const semanticErrors = validateSemantics(validated)
    if (semanticErrors.length > 0) {
      return {
        success: false,
        errors: semanticErrors,
        originalIntent: intent,
      }
    }
    
    return {
      success: true,
      intent: validated,
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        errors: error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
        originalIntent: intent,
      }
    }
    
    return {
      success: false,
      errors: [`Validation error: ${error instanceof Error ? error.message : String(error)}`],
      originalIntent: intent,
    }
  }
}

/**
 * Semantic validation rules
 * 
 * Validates logical consistency beyond schema structure
 */
function validateSemantics(intent: StructuredIntent): string[] {
  const errors: string[] = []
  
  // Rule 1: CREATE actions require target
  if (intent.action === 'CREATE' && !intent.target) {
    errors.push('CREATE action requires a target entity')
  }
  
  // Rule 2: DATABASE domain with CREATE should have fields
  if (
    intent.domain === 'DATABASE' &&
    intent.action === 'CREATE' &&
    (!intent.fields || intent.fields.length === 0)
  ) {
    errors.push('Database CREATE requires at least one field definition')
  }
  
  // Rule 3: Relationships must reference valid entities
  if (intent.relationships) {
    for (const rel of intent.relationships) {
      if (rel.from === rel.to) {
        errors.push(`Self-referencing relationship not allowed: ${rel.from}`)
      }
    }
  }
  
  // Rule 4: DELETE actions should have high confidence
  if (intent.action === 'DELETE' && intent.confidence < 0.8) {
    errors.push('DELETE actions require high confidence (>0.8)')
  }
  
  // Rule 5: COMMITTED status requires confidence >= 0.7
  if (intent.status === 'COMMITTED' && intent.confidence < 0.7) {
    errors.push('COMMITTED intents require confidence >= 0.7')
  }
  
  return errors
}

/**
 * Quick validation check (returns boolean)
 */
export function isValidStructuredIntent(intent: Partial<CanonicalIntent>): boolean {
  return validateStructuredIntent(intent).success
}

/**
 * Validate batch of intents
 */
export function validateIntentBatch(
  intents: Partial<CanonicalIntent>[]
): {
  valid: StructuredIntent[]
  invalid: Array<{ intent: Partial<CanonicalIntent>; errors: string[] }>
} {
  const valid: StructuredIntent[] = []
  const invalid: Array<{ intent: Partial<CanonicalIntent>; errors: string[] }> = []
  
  for (const intent of intents) {
    const result = validateStructuredIntent(intent)
    if (result.success) {
      valid.push(result.intent)
    } else {
      const failure = result as ValidationFailure
      invalid.push({
        intent: failure.originalIntent,
        errors: failure.errors,
      })
    }
  }
  
  return { valid, invalid }
}

/**
 * Convert legacy CanonicalIntent to StructuredIntent
 * 
 * Migration helper for gradual rollout
 */
export function migrateToStructuredIntent(
  legacy: CanonicalIntent
): Partial<StructuredIntent> {
  return {
    intent_type: legacy.intent_type,
    domain: legacy.domain,
    action: legacy.action,
    target: legacy.target || legacy.feature || '',
    feature: legacy.feature,
    reason: legacy.reason,
    source_text: legacy.source_text,
    timestamp: legacy.timestamp,
    confidence: legacy.confidence,
    isOverride: legacy.isOverride,
    status: legacy.status,
    constraints: legacy.constraints,
    
    // Extract fields from constraints if present
    fields: legacy.constraints?.fields as ValidatedField[] | undefined,
    relationships: legacy.constraints?.relationships as ValidatedRelationship[] | undefined,
  }
}
