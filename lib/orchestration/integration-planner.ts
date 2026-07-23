/**
 * PHASE 1: INTEGRATION PROPOSAL LAYER
 * 
 * Generates multiple architectural options for integrating new entities
 * into existing backend schema. Enables collaborative architecture decisions.
 * 
 * This transforms Backenly from "blind execution" to "co-architect mode".
 */

import { getOpenAIClient } from '@/lib/ai/openai-service'
import { logger } from '@/lib/logger'
import type { BackendStateGraph } from './backend-state-graph'
import type { SemanticUnderstanding } from './semantic-understanding'
import type { InferredEntity } from './entity-inference'

/**
 * Architectural integration option
 */
export interface IntegrationOption {
  id: string
  title: string
  description: string
  complexity: 'simple' | 'moderate' | 'complex'
  changes: {
    newEntities: string[]
    modifiedEntities: string[]
    newRelations: Array<{ from: string; to: string; type: string }>
    capabilities: string[]
  }
  reasoning: string
  tradeoffs: {
    pros: string[]
    cons: string[]
  }
  recommended: boolean
}

/**
 * Result of integration planning
 */
export interface IntegrationPlanResult {
  success: boolean
  options: IntegrationOption[]
  reasoning: string
  requiresDecision: boolean
}

/**
 * Generate architectural integration options
 * 
 * This function analyzes new entities and existing schema to propose
 * multiple integration strategies with tradeoffs.
 */
export async function generateIntegrationOptions(
  newEntities: InferredEntity[],
  graph: BackendStateGraph,
  semanticUnderstanding?: SemanticUnderstanding
): Promise<IntegrationPlanResult> {
  const startTime = Date.now()
  
  try {
    logger.info('[Integration Planner] Starting option generation', {
      newEntitiesCount: newEntities.length,
      existingEntitiesCount: Object.keys(graph.entities).length,
    })
    
    // CASE 1: No existing entities - single obvious path
    const existingEntityNames = Object.keys(graph.entities)
    if (existingEntityNames.length === 0) {
      logger.info('[Integration Planner] Fresh project - single option')
      
      return {
        success: true,
        options: [{
          id: 'create_fresh',
          title: 'Create New Backend',
          description: 'Initialize your backend with the specified entities',
          complexity: 'simple',
          changes: {
            newEntities: newEntities.map(e => e.name),
            modifiedEntities: [],
            newRelations: [],
            capabilities: semanticUnderstanding?.probableCapabilities || []
          },
          reasoning: 'This is a new project with no existing schema',
          tradeoffs: {
            pros: ['Clean start', 'No migration needed'],
            cons: []
          },
          recommended: true
        }],
        reasoning: 'Single path for new project',
        requiresDecision: false
      }
    }
    
    // CASE 2: Existing entities - ALWAYS use Fully Integrated strategy
    // BaaS platforms need cohesive data architecture. No need to ask users.
    logger.info('[Integration Planner] Existing schema detected - auto-selecting Fully Integrated')

    const openai = getOpenAIClient()

    // Build context for AI
    const existingSchema = Object.keys(graph.entities).map(name => ({
      name,
      fields: Object.keys(graph.entities[name].fields || {})
    }))

    const newEntitiesContext = newEntities.map(e => ({
      name: e.name,
      fields: e.fields.map(f => ({ name: f.name, type: f.type }))
    }))

    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: `You are an expert backend architect determining optimal integration relationships.

EXISTING SCHEMA:
${JSON.stringify(existingSchema, null, 2)}

NEW ENTITIES TO INTEGRATE:
${JSON.stringify(newEntitiesContext, null, 2)}

USER'S INTENT:
${semanticUnderstanding?.intentSummary || 'Not provided'}

TASK:
Determine the optimal relationships between new entities and existing ones for full integration.

RESPONSE FORMAT (JSON):
{
  "fullyIntegrated": {
    "id": "fully_integrated",
    "title": "Fully Integrated",
    "description": "Link all entities for comprehensive data access",
    "complexity": "moderate",
    "changes": {
      "newEntities": ["new_table_1", "new_table_2"],
      "modifiedEntities": [],
      "newRelations": [
        { "from": "new_table_1", "to": "existing_table", "type": "relationship_type" }
      ],
      "capabilities": ["capability1", "capability2"]
    },
    "reasoning": "Enables cohesive data architecture and analytics",
    "tradeoffs": {
      "pros": ["Cohesive data", "Enhanced capabilities"],
      "cons": ["Complex implementation", "Requires migration"]
    },
    "recommended": true
  }
}

RULES:
1. Return ONLY the fully integrated option (no alternatives)
2. Identify all logical relationships between new and existing entities
3. Suggest relationship types (belongs_to, has_many, has_one, many_to_many)
4. List all new capabilities enabled by full integration
5. Mark as recommended (always true)

Return ONLY valid JSON, no markdown.`
        },
        {
          role: 'user',
          content: 'Determine optimal integration relationships'
        }
      ],
      temperature: 0.5,
      max_tokens: 1200,
    })

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error('No response from AI')
    }

    const parsed = JSON.parse(content.trim())

    const fullyIntegratedOption = parsed.fullyIntegrated || {
      id: 'fully_integrated',
      title: 'Fully Integrated',
      description: 'Link all entities for comprehensive data access',
      complexity: 'moderate',
      changes: {
        newEntities: newEntities.map(e => e.name),
        modifiedEntities: [],
        newRelations: [],
        capabilities: semanticUnderstanding?.probableCapabilities || []
      },
      reasoning: 'Backenly automatically applies full integration for cohesive architecture',
      tradeoffs: {
        pros: ['Cohesive data', 'Enhanced capabilities', 'Automatic optimization'],
        cons: ['Complex relationships handled by AI']
      },
      recommended: true
    }

    const result: IntegrationPlanResult = {
      success: true,
      options: [fullyIntegratedOption],
      reasoning: 'Backenly automatically applies Fully Integrated strategy',
      requiresDecision: false // Never ask user - BaaS platforms need full integration
    }

    const duration = Date.now() - startTime
    logger.info('[Integration Planner] Fully Integrated strategy applied', {
      newEntitiesCount: newEntities.length,
      applicableRelations: fullyIntegratedOption.changes.newRelations.length,
      duration
    })

    return result
    
  } catch (error: any) {
    logger.error('[Integration Planner] Planning failed', {
      error: error.message
    })
    
    // Fallback: Single default option
    return {
      success: true,
      options: [{
        id: 'default',
        title: 'Standard Integration',
        description: 'Add new entities to your backend',
        complexity: 'moderate',
        changes: {
          newEntities: newEntities.map(e => e.name),
          modifiedEntities: [],
          newRelations: [],
          capabilities: []
        },
        reasoning: 'Fallback to standard integration',
        tradeoffs: {
          pros: ['Straightforward'],
          cons: []
        },
        recommended: true
      }],
      reasoning: `Planning failed: ${error.message}`,
      requiresDecision: false
    }
  }
}

/**
 * Validate an integration option selection
 */
export function validateIntegrationSelection(
  optionId: string,
  options: IntegrationOption[]
): boolean {
  return options.some(opt => opt.id === optionId)
}

/**
 * Get selected integration option
 */
export function getSelectedOption(
  optionId: string,
  options: IntegrationOption[]
): IntegrationOption | null {
  return options.find(opt => opt.id === optionId) || null
}

/**
 * Apply selected option constraints to entity inference
 * This guides the AI to follow the user's chosen integration strategy
 */
export function applyOptionToPrompt(
  originalPrompt: string,
  selectedOption: IntegrationOption
): string {
  const constraints: string[] = [originalPrompt]
  
  // Add relation constraints
  if (selectedOption.changes.newRelations.length > 0) {
    const relationInstructions = selectedOption.changes.newRelations.map(rel => 
      `Link ${rel.from} to ${rel.to} using ${rel.type} relationship`
    )
    constraints.push(...relationInstructions)
  }
  
  // Add complexity guidance
  if (selectedOption.complexity === 'simple') {
    constraints.push('Keep architecture simple with minimal dependencies')
  } else if (selectedOption.complexity === 'complex') {
    constraints.push('Create comprehensive integration with all necessary relationships')
  }
  
  // Add capability requirements
  if (selectedOption.changes.capabilities.length > 0) {
    constraints.push(`Enable: ${selectedOption.changes.capabilities.join(', ')}`)
  }
  
  return constraints.join('. ')
}
