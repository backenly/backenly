/**
 * PHASE 2: SEMANTIC UNDERSTANDING LAYER
 * 
 * Preprocessing stage that extracts structured interpretation from ANY user prompt.
 * 
 * This layer NEVER rejects input - it's responsibility is to understand, not validate.
 * 
 * Pipeline Position:
 * User Prompt → SEMANTIC UNDERSTANDING → Entity Inference → Normalization → Validation
 */

import { getOpenAIClient } from '@/lib/ai/openai-service'
import { logger } from '@/lib/logger'

/**
 * Structured interpretation of user intent
 */
export interface SemanticUnderstanding {
  // High-level interpretation
  intentSummary: string
  domain: string // e.g., "e-commerce", "social media", "SaaS platform"
  
  // Extracted components
  probableEntities: string[] // e.g., ["users", "orders", "products"]
  probableRelations: Array<{ from: string; to: string; type: string }>
  probableCapabilities: string[] // e.g., ["user authentication", "file uploads", "payment processing"]
  
  // Intent classification
  crudIntent: {
    create: string[] // Entities to create
    read: string[] // Entities to query
    update: string[] // Entities to modify
    delete: string[] // Entities to remove
  }
  
  storageIntent: boolean // Whether file storage is needed
  authIntent: boolean // Whether authentication is needed
  
  // Confidence scoring
  ambiguityScore: number // 0.0 (clear) to 1.0 (very ambiguous)
  missingInformation: string[] // What clarifications would help
  
  // Reasoning
  reasoning: string // Why this interpretation was chosen
}

/**
 * Extract semantic understanding from user prompt
 * 
 * This is the FIRST processing stage - runs before inference
 * NEVER throws or rejects - always returns best interpretation
 */
export async function understandSemanticIntent(
  userMessage: string,
  projectId: string
): Promise<SemanticUnderstanding> {
  const startTime = Date.now()
  
  try {
    logger.info('[Semantic Understanding] Starting interpretation', {
      projectId,
      promptLength: userMessage.length,
    })
    
    const openai = getOpenAIClient()
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: `You are a semantic intent analyzer for a backend builder AI.

Your ONLY job is to understand what the user wants - NOT to validate or reject.

Extract structured information from ANY prompt, no matter how vague.

Return JSON with this EXACT structure:

{
  "intentSummary": "User wants to build...",
  "domain": "e.g., social media, e-commerce, SaaS",
  "probableEntities": ["users", "posts", "comments"],
  "probableRelations": [
    { "from": "posts", "to": "users", "type": "belongs_to" }
  ],
  "probableCapabilities": ["user authentication", "content creation"],
  "crudIntent": {
    "create": ["posts", "comments"],
    "read": ["posts", "users"],
    "update": [],
    "delete": []
  },
  "storageIntent": false,
  "authIntent": true,
  "ambiguityScore": 0.3,
  "missingInformation": ["What fields should posts have?"],
  "reasoning": "User described social media features..."
}

RULES:
1. NEVER return empty probableEntities - ALWAYS infer at least one DOMAIN entity
2. If prompt is just "review" → infer ["reviews"]
3. If prompt mentions users → always include "users" entity
4. ambiguityScore: 0.0-0.3 (clear), 0.3-0.7 (moderate), 0.7-1.0 (very vague)
5. Detect auth needs: signup, login, users, accounts → authIntent: true
6. Detect storage: upload, file, image, document → storageIntent: true
7. Be GENEROUS in interpretation - err on side of inferring structure

CRITICAL - DO NOT EXTRACT AS ENTITIES:
- Infrastructure terms: api/apis, table/tables, schema, database, db, backend, frontend
- Configuration terms: field/fields, column/columns, relation/relations, attribute/attributes
- Generic terms: model/models, type/types, component/components, service/services
- These are NOT entities - they describe HOW to build, not WHAT to build

EXAMPLE FILTERING:
- "add tables and apis required" → DO NOT extract "tables" or "apis" as entities
  Instead infer the actual domain entities like "calculations", "users", etc.
- "create users, posts, and comments" → Extract: ["users", "posts", "comments"] ✓
- "create a backend with apis" → Extract domain entities ONLY, NOT "backend" or "apis" ✓

Return ONLY valid JSON, no markdown.`
        },
        {
          role: 'user',
          content: `Analyze this prompt and extract semantic understanding:\n\n"${userMessage}"`
        }
      ],
      temperature: 0.3,
      max_tokens: 1500,
    })

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error('No response from AI')
    }

    const parsed = JSON.parse(content.trim())

    // CRITICAL: Filter out meta-concepts (infrastructure/framework terms) from entities
    // These are NOT domain entities: apis, tables, schema, database, backend, frontend, etc.
    const metaConcepts = new Set([
      'api', 'apis', 'endpoint', 'endpoints',
      'table', 'tables', 'schema', 'database', 'db',
      'backend', 'frontend', 'ui', 'component', 'components',
      'field', 'fields', 'column', 'columns', 'attribute', 'attributes',
      'relation', 'relations', 'relationship', 'relationships',
      'model', 'models', 'type', 'types', 'interface', 'interfaces',
      'function', 'functions', 'method', 'methods', 'handler', 'handlers',
      'route', 'routes', 'path', 'paths', 'endpoint', 'endpoints',
      'middleware', 'plugin', 'plugin', 'extension', 'extensions',
      'service', 'services', 'utility', 'utilities',
    ])

    const filteredEntities = (parsed.probableEntities || [])
      .filter((entity: string) => !metaConcepts.has(entity.toLowerCase()))

    // If all entities were filtered out (unlikely but defensive), fall back to basic extraction
    const finalEntities = filteredEntities.length > 0
      ? filteredEntities
      : extractBasicEntities(userMessage)

    const understanding: SemanticUnderstanding = {
      intentSummary: parsed.intentSummary || 'User intent unclear',
      domain: parsed.domain || 'general',
      probableEntities: finalEntities,
      probableRelations: (parsed.probableRelations || [])
        .filter((rel: any) =>
          !metaConcepts.has(rel.from?.toLowerCase()) &&
          !metaConcepts.has(rel.to?.toLowerCase())
        ),
      probableCapabilities: parsed.probableCapabilities || [],
      crudIntent: {
        create: (parsed.crudIntent?.create || []).filter((e: string) => !metaConcepts.has(e.toLowerCase())),
        read: (parsed.crudIntent?.read || []).filter((e: string) => !metaConcepts.has(e.toLowerCase())),
        update: (parsed.crudIntent?.update || []).filter((e: string) => !metaConcepts.has(e.toLowerCase())),
        delete: (parsed.crudIntent?.delete || []).filter((e: string) => !metaConcepts.has(e.toLowerCase())),
      },
      storageIntent: parsed.storageIntent || false,
      authIntent: parsed.authIntent || false,
      ambiguityScore: parsed.ambiguityScore ?? 0.5,
      missingInformation: parsed.missingInformation || [],
      reasoning: parsed.reasoning || 'Analyzed user prompt',
    }

    const duration = Date.now() - startTime
    logger.info('[Semantic Understanding] ✅ Analysis complete', {
      projectId,
      intentSummary: understanding.intentSummary,
      entityCount: understanding.probableEntities.length,
      ambiguityScore: understanding.ambiguityScore,
      duration,
    })

    return understanding

  } catch (error: any) {
    logger.error('[Semantic Understanding] Analysis failed', {
      projectId,
      error: error.message,
    })

    // NEVER throw - return safe fallback
    return {
      intentSummary: 'Unable to fully analyze intent - will attempt best interpretation',
      domain: 'general',
      probableEntities: extractBasicEntities(userMessage),
      probableRelations: [],
      probableCapabilities: [],
      crudIntent: { create: extractBasicEntities(userMessage), read: [], update: [], delete: [] },
      storageIntent: /upload|file|image|storage/i.test(userMessage),
      authIntent: /auth|login|signup|user|account/i.test(userMessage),
      ambiguityScore: 0.8,
      missingInformation: ['Could not analyze prompt fully - please provide more details'],
      reasoning: `Fallback analysis due to error: ${error.message}`,
    }
  }
}

/**
 * Basic entity extraction fallback (no AI)
 */
function extractBasicEntities(text: string): string[] {
  const commonEntities = [
    'user', 'users',
    'post', 'posts',
    'comment', 'comments',
    'review', 'reviews',
    'product', 'products',
    'order', 'orders',
    'subscription', 'subscriptions',
    'notification', 'notifications',
    'upload', 'uploads',
    'file', 'files',
    'document', 'documents',
    'project', 'projects',
    'task', 'tasks',
  ]
  
  const found = commonEntities.filter(entity => 
    text.toLowerCase().includes(entity)
  )
  
  // Always return at least one entity
  return found.length > 0 ? found : ['items']
}

/**
 * Check if understanding indicates high confidence
 */
export function isHighConfidence(understanding: SemanticUnderstanding): boolean {
  return understanding.ambiguityScore < 0.4 && understanding.probableEntities.length > 0
}

/**
 * Check if understanding indicates medium confidence (needs confirmation)
 */
export function isMediumConfidence(understanding: SemanticUnderstanding): boolean {
  return understanding.ambiguityScore >= 0.4 && understanding.ambiguityScore < 0.7
}

/**
 * Check if understanding indicates low confidence (needs clarification)
 */
export function isLowConfidence(understanding: SemanticUnderstanding): boolean {
  return understanding.ambiguityScore >= 0.7
}

/**
 * Generate user-friendly confirmation message from understanding
 */
export function generateConfirmationMessage(understanding: SemanticUnderstanding): string {
  if (understanding.probableEntities.length === 0) {
    return `I understand you want to build something, but I need more details about what data structures you need. Could you describe what your app should store?`
  }
  
  const entityList = understanding.probableEntities.join(', ')
  const capabilities = understanding.probableCapabilities.length > 0
    ? ` with ${understanding.probableCapabilities.join(' and ')}`
    : ''
  
  return `I understand you want ${understanding.intentSummary.toLowerCase()}. This will create ${entityList}${capabilities}. Should I proceed?`
}

/**
 * Generate clarifying question from understanding
 */
export function generateClarifyingQuestion(understanding: SemanticUnderstanding): string {
  if (understanding.missingInformation.length > 0) {
    return understanding.missingInformation[0]
  }
  
  if (understanding.probableEntities.length === 0) {
    return 'What data do you want your app to store?'
  }
  
  const entity = understanding.probableEntities[0]
  return `What information should each ${entity} contain?`
}
