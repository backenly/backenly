/**
 * PHASE 4: CONFIDENCE EVALUATION SYSTEM
 * 
 * DRAFT-FIRST ARCHITECTURE (Cursor/Replit Style)
 * 
 * The AI should PROPOSE a coherent architecture, explain WHY, and ask for confirmation.
 * NOT checkbox wizards. NOT open-ended questions.
 * 
 * Flow based on ambiguity:
 * - HIGH confidence (ambiguity < 0.2) → Auto proceed
 * - MODERATE confidence (ambiguity 0.2-0.6) → PREVIEW mode with proposedEntities + assumptions
 * - LOW confidence (ambiguity > 0.7) → Ask clarifying question
 * 
 * KEY INSIGHT: We DO NOT discard inferred entities when confidence is moderate.
 * We PROPOSE them with explicit assumptions and ask for confirmation.
 */

import { SemanticUnderstanding } from './semantic-understanding'
import { InferredEntity } from './entity-inference'
import { NormalizedEntity } from './schema-normalizer'

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW'

export interface ConfidenceEvaluation {
  level: ConfidenceLevel
  score: number // 0.0 to 1.0
  
  // Component scores
  entityClarity: number // 0.0 to 1.0
  relationshipClarity: number // 0.0 to 1.0
  capabilityCompleteness: number // 0.0 to 1.0
  
  // Decision
  shouldAutoProceed: boolean
  shouldConfirm: boolean
  shouldAskQuestion: boolean
  shouldPropose: boolean // NEW: Moderate ambiguity - propose with assumptions
  
  // User messaging
  message: string
  question?: string
  
  // Reasoning
  reasoning: string
  
  // DRAFT-FIRST: Assumptions for proposal mode
  assumptions?: string[] // List of inferred assumptions to display to user
}

/**
 * Evaluate execution confidence from semantic understanding and inferred entities
 */
export function evaluateConfidence(
  understanding: SemanticUnderstanding,
  inferredEntities: InferredEntity[],
  normalizedEntities: NormalizedEntity[]
): ConfidenceEvaluation {
  
  // COMPONENT 1: Entity Clarity
  // How well-defined are the entities?
  const entityClarity = calculateEntityClarity(understanding, inferredEntities, normalizedEntities)
  
  // COMPONENT 2: Relationship Clarity
  // Are relationships between entities clear?
  const relationshipClarity = calculateRelationshipClarity(understanding, normalizedEntities)
  
  // COMPONENT 3: Capability Completeness
  // Are required capabilities (auth, storage, APIs) identified?
  const capabilityCompleteness = calculateCapabilityCompleteness(understanding)
  
  // WEIGHTED SCORE
  // Entity clarity is most important (50%), then relationships (30%), then capabilities (20%)
  const score = (
    entityClarity * 0.5 +
    relationshipClarity * 0.3 +
    capabilityCompleteness * 0.2
  )
  
  // DETERMINE CONFIDENCE LEVEL
  let level: ConfidenceLevel
  if (score >= 0.7) {
    level = 'HIGH'
  } else if (score >= 0.4) {
    level = 'MEDIUM'
  } else {
    level = 'LOW'
  }
  
  // ============================================================================
  // DRAFT-FIRST DECISION LOGIC (Cursor/Replit Style)
  // ============================================================================
  // KEY INSIGHT: When ambiguity is moderate (0.2-0.6), DO NOT ask open questions.
  // Instead, PROPOSE a concrete architecture with explicit assumptions.
  // Only ask clarifying questions when ambiguity is HIGH (>0.7).
  // ============================================================================
  
  const ambiguity = understanding.ambiguityScore
  
  // CHECK: Is this a clear entity creation with explicit fields?
  // If user says "create X with field1, field2", this is NOT ambiguous - execute immediately
  const hasExplicitFields = normalizedEntities.some(e => 
    e.fields && e.fields.length > 0 && e.fields.some(f => 
      f.name !== 'id' && f.name !== 'createdAt' && f.name !== 'updatedAt'
    )
  )
  // Auto-proceed if user specified explicit fields (they were clear about what they want)
  const isClearEntityRequest = hasExplicitFields && normalizedEntities.length === 1
  
  // HIGH confidence + LOW ambiguity → Auto proceed
  // ALSO: Simple entity creation with explicit fields → Auto proceed (bypass proposal mode)
  const shouldAutoProceed = (level === 'HIGH' && ambiguity < 0.2) || 
                            (isClearEntityRequest && level !== 'LOW' && ambiguity < 0.5)
  
  // MODERATE ambiguity (0.2-0.6) → PROPOSE mode (draft-first)
  // AI proposes architecture, explains reasoning, lists assumptions
  // BUT: Skip proposal mode if we have explicit fields (user was clear)
  const shouldPropose = !shouldAutoProceed && ambiguity >= 0.2 && ambiguity <= 0.6 && !isClearEntityRequest
  
  // HIGH ambiguity (>0.7) → Must ask clarifying question
  const shouldAskQuestion = ambiguity > 0.7
  
  // MEDIUM confidence with low ambiguity → Simple confirmation
  const shouldConfirm = (level === 'MEDIUM' || level === 'HIGH') && !shouldPropose && !shouldAskQuestion && !shouldAutoProceed
  
  // GENERATE ASSUMPTIONS for proposal mode
  const assumptions = shouldPropose ? generateAssumptions(understanding, normalizedEntities) : undefined
  
  // GENERATE USER MESSAGE
  const message = shouldPropose 
    ? generateProposalMessage(understanding, normalizedEntities, assumptions || [])
    : generateUserMessage(level, understanding, normalizedEntities)
  const question = shouldAskQuestion ? generateClarifyingQuestion(understanding, normalizedEntities) : undefined
  
  // REASONING
  const reasoning = `Entity clarity: ${(entityClarity * 100).toFixed(0)}%, Relationship clarity: ${(relationshipClarity * 100).toFixed(0)}%, Capability completeness: ${(capabilityCompleteness * 100).toFixed(0)}%. Overall score: ${(score * 100).toFixed(0)}%. Ambiguity: ${(ambiguity * 100).toFixed(0)}%. Mode: ${shouldPropose ? 'PROPOSE' : shouldAskQuestion ? 'CLARIFY' : shouldAutoProceed ? 'AUTO' : 'CONFIRM'}.`
  
  return {
    level,
    score,
    entityClarity,
    relationshipClarity,
    capabilityCompleteness,
    shouldAutoProceed,
    shouldConfirm,
    shouldAskQuestion,
    shouldPropose,
    message,
    question,
    reasoning,
    assumptions,
  }
}

/**
 * Calculate how well-defined entities are
 */
function calculateEntityClarity(
  understanding: SemanticUnderstanding,
  inferredEntities: InferredEntity[],
  normalizedEntities: NormalizedEntity[]
): number {
  // No entities = 0 clarity
  if (normalizedEntities.length === 0) return 0.0
  
  let totalScore = 0
  let entityCount = 0
  
  for (const entity of normalizedEntities) {
    entityCount++
    let entityScore = 0
    
    // Has name: +0.3
    if (entity.name && entity.name.length > 0) {
      entityScore += 0.3
    }
    
    // Has fields: +0.4
    if (entity.fields && entity.fields.length > 0) {
      entityScore += 0.4
    }
    
    // Has meaningful fields (not just id, timestamps): +0.3
    const meaningfulFields = entity.fields.filter(f => 
      f.name !== 'id' && 
      f.name !== 'created_at' && 
      f.name !== 'updated_at'
    )
    if (meaningfulFields.length > 0) {
      entityScore += 0.3
    }
    
    totalScore += entityScore
  }
  
  return totalScore / entityCount
}

/**
 * Calculate how clear relationships are
 */
function calculateRelationshipClarity(
  understanding: SemanticUnderstanding,
  normalizedEntities: NormalizedEntity[]
): number {
  const relationFields = normalizedEntities.flatMap(entity =>
    entity.fields.filter(f => f.type === 'relation')
  )
  
  // If no relations mentioned in understanding, score is neutral (0.7)
  if (understanding.probableRelations.length === 0 && relationFields.length === 0) {
    return 0.7
  }
  
  // If relations were inferred and normalized, score is high (0.9)
  if (relationFields.length > 0) {
    return 0.9
  }
  
  // If relations mentioned but not inferred, score is medium (0.5)
  if (understanding.probableRelations.length > 0 && relationFields.length === 0) {
    return 0.5
  }
  
  return 0.7
}

/**
 * Calculate how complete capabilities are
 */
function calculateCapabilityCompleteness(
  understanding: SemanticUnderstanding
): number {
  let score = 0.5 // Base score
  
  // Auth intent identified: +0.25
  if (understanding.authIntent) {
    score += 0.25
  }
  
  // Storage intent identified: +0.25
  if (understanding.storageIntent) {
    score += 0.25
  }
  
  // Capabilities listed: +0.1 per capability (max +0.3)
  if (understanding.probableCapabilities.length > 0) {
    score += Math.min(0.3, understanding.probableCapabilities.length * 0.1)
  }
  
  return Math.min(1.0, score)
}

/**
 * Generate user-facing message based on confidence level
 */
function generateUserMessage(
  level: ConfidenceLevel,
  understanding: SemanticUnderstanding,
  entities: NormalizedEntity[]
): string {
  if (level === 'HIGH') {
    // High confidence: clear confirmation
    const entityNames = entities.map(e => e.name).join(', ')
    const capabilities = []
    if (understanding.authIntent) capabilities.push('user authentication')
    if (understanding.storageIntent) capabilities.push('file storage')
    
    const capStr = capabilities.length > 0 ? ` with ${capabilities.join(' and ')}` : ''
    
    return `I understand you want ${understanding.intentSummary.toLowerCase()}. This will create ${entityNames}${capStr}. Ready to build?`
  }
  
  if (level === 'MEDIUM') {
    // Medium confidence: show interpretation and ask confirmation
    const entityNames = entities.map(e => e.name).join(', ')
    return `I understand you want to work with ${entityNames}. I'll create the necessary tables and APIs. Does this sound right?`
  }
  
  // Low confidence: explain limitation
  return `I want to help build this, but I need a bit more information to create the right structure for you.`
}

/**
 * Generate clarifying question for low confidence
 */
function generateClarifyingQuestion(
  understanding: SemanticUnderstanding,
  entities: NormalizedEntity[]
): string {
  // If missing information was identified, use it
  if (understanding.missingInformation.length > 0) {
    return understanding.missingInformation[0]
  }
  
  // If no entities, ask about data
  if (entities.length === 0) {
    return 'What kind of data do you want your app to store? (For example: users, posts, orders, etc.)'
  }
  
  // If entities exist but fields are unclear
  const entity = entities[0]
  const meaningfulFields = entity.fields.filter(f => 
    f.name !== 'id' && 
    f.name !== 'created_at' && 
    f.name !== 'updated_at'
  )
  
  if (meaningfulFields.length === 0) {
    return `What information should each ${entity.name} contain?`
  }
  
  // Generic fallback
  return 'Could you describe what you want to build in a bit more detail?'
}

/**
 * Check if confidence allows auto-execution
 */
export function canAutoProceed(evaluation: ConfidenceEvaluation): boolean {
  return evaluation.shouldAutoProceed
}

/**
 * Check if confidence requires user confirmation
 */
export function needsConfirmation(evaluation: ConfidenceEvaluation): boolean {
  return evaluation.shouldConfirm
}

/**
 * Check if confidence requires clarifying question
 */
export function needsClarification(evaluation: ConfidenceEvaluation): boolean {
  return evaluation.shouldAskQuestion
}

/**
 * Check if confidence triggers proposal mode (draft-first)
 */
export function needsProposal(evaluation: ConfidenceEvaluation): boolean {
  return evaluation.shouldPropose
}

/**
 * DRAFT-FIRST: Generate assumptions for proposal mode
 * 
 * These are the inferred assumptions that the AI will explicitly state:
 * - "Users exist in the system"
 * - "Reviews belong to users"
 * - "Products can have multiple reviews"
 */
function generateAssumptions(
  understanding: SemanticUnderstanding,
  entities: NormalizedEntity[]
): string[] {
  const assumptions: string[] = []
  
  // Check for user entity or user_id references
  const hasUserEntity = entities.some(e => e.name.toLowerCase() === 'users' || e.name.toLowerCase() === 'user')
  const hasUserReference = entities.some(e => 
    e.fields.some(f => f.name === 'user_id' || f.relationTo === 'users')
  )
  
  if (hasUserReference && !hasUserEntity) {
    assumptions.push('Users exist in your system (I\'ll reference them)')
  }
  
  // Check for relations between entities
  for (const entity of entities) {
    const relations = entity.fields.filter(f => f.type === 'relation')
    for (const rel of relations) {
      if (rel.relationTo) {
        assumptions.push(`${entity.name} belong to ${rel.relationTo}`)
      }
    }
  }
  
  // Check for auth intent
  if (understanding.authIntent) {
    assumptions.push('User authentication is required')
  }
  
  // Check for storage intent
  if (understanding.storageIntent) {
    assumptions.push('File storage will be needed')
  }
  
  // Add domain-based assumptions
  if (understanding.domain) {
    const domainAssumptions: Record<string, string[]> = {
      'ecommerce': ['Products have prices and inventory', 'Orders track purchase history'],
      'social': ['Users can follow each other', 'Content is public by default'],
      'saas': ['Each user has their own workspace', 'Data is isolated per tenant'],
      'content': ['Content can be published or drafted', 'Authors are tracked'],
      'booking': ['Appointments have time slots', 'Double-booking is prevented'],
    }
    
    const domainSpecific = domainAssumptions[understanding.domain.toLowerCase()]
    if (domainSpecific) {
      assumptions.push(...domainSpecific.slice(0, 2)) // Max 2 domain assumptions
    }
  }
  
  // If no specific assumptions, add generic ones
  if (assumptions.length === 0) {
    if (entities.length > 0) {
      assumptions.push('This structure follows standard patterns for your use case')
    }
  }
  
  return assumptions
}

/**
 * DRAFT-FIRST: Generate proposal message (Cursor/Replit style)
 * 
 * This creates a conversational architecture proposal:
 * - Summarizes what AI inferred
 * - Lists proposed models and fields
 * - Explicitly states assumptions
 * - Asks for confirmation or modification
 */
function generateProposalMessage(
  understanding: SemanticUnderstanding,
  entities: NormalizedEntity[],
  assumptions: string[]
): string {
  const parts: string[] = []
  
  // HEADER: What we're proposing
  if (entities.length === 1) {
    parts.push(`I'll create a **${entities[0].name}** model.`)
  } else if (entities.length > 1) {
    const entityNames = entities.map(e => `**${e.name}**`).join(', ')
    parts.push(`I'll create ${entities.length} models: ${entityNames}.`)
  }
  
  // FIELDS: What each model includes
  for (const entity of entities) {
    const meaningfulFields = entity.fields.filter(f => 
      f.name !== 'id' && 
      f.name !== 'created_at' && 
      f.name !== 'updated_at'
    )
    
    if (meaningfulFields.length > 0) {
      const fieldDescriptions = meaningfulFields.map(f => {
        if (f.type === 'relation') {
          return `${f.name} (linked to ${f.relationTo})`
        }
        return f.name
      }).join(', ')
      
      parts.push(`\n**${entity.name}** will include: ${fieldDescriptions}`)
    }
  }
  
  // REASONING: Why this structure makes sense
  if (understanding.intentSummary) {
    parts.push(`\nThis structure supports ${understanding.intentSummary.toLowerCase()}.`)
  }
  
  // ASSUMPTIONS: What we're assuming
  if (assumptions.length > 0) {
    parts.push('\n**Assumptions:**')
    for (const assumption of assumptions) {
      parts.push(`• ${assumption}`)
    }
  }
  
  // CALL TO ACTION
  parts.push('\n**Proceed with this structure?** Or tell me what should change.')
  
  return parts.join('\n')
}
