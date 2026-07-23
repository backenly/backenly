/**
 * Entity Inference Layer - NATURAL-LANGUAGE BACKEND BUILDER MODE
 * 
 * Aggressively infers backend entities from ANY prompt, even vague ones.
 * Behaves like Lovable/Replit/Cursor - NO clarification loops.
 * 
 * Pipeline:
 * User Prompt → Entity Inference → Auto-Expand → Spec Validator → Execution
 * 
 * NEW BEHAVIOR:
 * - Infers from single words ("review" → full review table)
 * - Auto-injects default fields (id, createdAt, updatedAt)
 * - Uses domain templates for common entities
 * - Executes on confidence > 0.6
 * - NO blocking on missing fields
 */

import { getOpenAIClient } from '@/lib/ai/openai-service'
import { logger } from '@/lib/logger'
import type { SemanticUnderstanding } from './semantic-understanding'
import type { BackendStateGraph } from './backend-state-graph'
import { loadArchitecturalMemory, generateMemoryContext } from '@/lib/architecture-memory'
import { sanitizeAIContext } from '@/lib/ai/context-sanitizer'
import * as fs from 'fs'
import * as path from 'path'

// ============================================================================
// DETERMINISTIC INLINE FIELD EXTRACTION
// Extracts comma-separated field lists from natural language prompts
// Example: "create products with name, price, and quantity" → [{name:"name",type:"string"}, ...]
// IMPORTANT: This should ONLY extract actual fields, not entity names
// ============================================================================
export function extractInlineFields(prompt: string, parsedEntityNames?: string[]): Array<{name: string, type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'relation', required?: boolean}> {
  // Match patterns like: "create X with field1, field2, and field3"
  // But NOT patterns like "with users, posts, follows" (those are entities)
  const match = prompt.match(/with\s+(.+?)(?:\s+(?:table|entity|for|to|from|in|on)\s|$)/i)
  if (!match) return []

  const fieldPart = match[1]

  // Split by comma or 'and', clean up, remove trailing punctuation
  const fields = fieldPart
    .split(/,|\band\b/i)
    .map(f => f.trim().replace(/[.!?;:]$/, ''))
    .filter(f => f.length > 0 && !f.match(/^(table|entity|model|collection)s?$/i))

  // CRITICAL: Filter out entity names that were already parsed by LLM
  // If the LLM created "users", "posts", "follows" as entities,
  // don't inject them as fields into the primary entity
  const entityNameSet = new Set((parsedEntityNames || []).map(n => n.toLowerCase()))

  const fieldNames = fields.filter(fieldName => {
    const lowerFieldName = fieldName.toLowerCase()
    // Skip if this is already an entity name
    if (entityNameSet.has(lowerFieldName)) {
      console.log(`[Entity Inference] ℹ️ Skipping "${fieldName}" - it's already a parsed entity, not a field`)
      return false
    }
    return true
  })

  return fieldNames.map(name => ({
    name: name.toLowerCase().replace(/\s+/g, '_'),
    type: inferTypeFromName(name),
    required: false
  }))
}

/**
 * Infer field type from common naming patterns
 */
function inferTypeFromName(name: string): 'string' | 'number' | 'boolean' | 'date' | 'json' | 'relation' {
  const lower = name.toLowerCase()
  if (/price|amount|cost|total|count|quantity|stock|number|age|score|rating/i.test(lower)) return 'number'
  if (/date|time|at|on|created|updated/i.test(lower)) return 'date'
  if (/is_|has_|can_|should_|active|enabled|verified|published/i.test(lower)) return 'boolean'
  if (/email|url|link|path/i.test(lower)) return 'string'
  return 'string'
}

// Domain knowledge templates for common entities
const DOMAIN_TEMPLATES: Record<string, InferredEntity> = {
  review: {
    name: 'reviews',
    fields: [
      { name: 'userId', type: 'relation', relationTo: 'users', required: true },
      { name: 'rating', type: 'number', required: true },
      { name: 'comment', type: 'string' },
      { name: 'helpful', type: 'number' },
    ],
    description: 'User reviews and ratings',
  },
  subscription: {
    name: 'subscriptions',
    fields: [
      { name: 'userId', type: 'relation', relationTo: 'users', required: true },
      { name: 'plan', type: 'string', required: true },
      { name: 'status', type: 'string', required: true },
      { name: 'startDate', type: 'date', required: true },
      { name: 'endDate', type: 'date' },
    ],
    description: 'User subscriptions',
  },
  upload: {
    name: 'uploads',
    fields: [
      { name: 'userId', type: 'relation', relationTo: 'users', required: true },
      { name: 'fileUrl', type: 'string', required: true },
      { name: 'fileType', type: 'string' },
      { name: 'fileSize', type: 'number' },
    ],
    description: 'File uploads',
  },
  comment: {
    name: 'comments',
    fields: [
      { name: 'userId', type: 'relation', relationTo: 'users', required: true },
      { name: 'content', type: 'string', required: true },
      { name: 'likes', type: 'number' },
    ],
    description: 'User comments',
  },
  post: {
    name: 'posts',
    fields: [
      { name: 'userId', type: 'relation', relationTo: 'users', required: true },
      { name: 'title', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
      { name: 'published', type: 'boolean' },
    ],
    description: 'User posts',
  },
  notification: {
    name: 'notifications',
    fields: [
      { name: 'userId', type: 'relation', relationTo: 'users', required: true },
      { name: 'message', type: 'string', required: true },
      { name: 'read', type: 'boolean', required: true },
      { name: 'type', type: 'string' },
    ],
    description: 'User notifications',
  },
  order: {
    name: 'orders',
    fields: [
      { name: 'userId', type: 'relation', relationTo: 'users', required: true },
      { name: 'total', type: 'number', required: true },
      { name: 'status', type: 'string', required: true },
      { name: 'items', type: 'json' },
    ],
    description: 'Customer orders',
  },
}

export interface InferredEntity {
  name: string
  fields: {
    name: string
    type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'relation'
    required?: boolean
    unique?: boolean
    relationTo?: string
  }[]
  description: string
}

export interface EntityInferenceResult {
  success: boolean
  entities: InferredEntity[]
  enrichedPrompt: string
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
  originalPrompt: string
}

/**
 * Safe JSON parser for entity inference responses.
 * Handles truncated JSON caused by max_tokens limits on long prompts.
 * Falls back to progressively simpler repair strategies before throwing.
 */
function safeParseEntityJSON(text: string): any {
  // 1. Happy path — direct parse
  try {
    return JSON.parse(text)
  } catch (_) {}

  // 2. Strip markdown code fences (```json ... ```)
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  try {
    return JSON.parse(stripped)
  } catch (_) {}

  // 3. Try to close truncated arrays/objects by appending common suffixes
  const suffixes = ['"}]}', '"}]', '"}', ']', '}]', '}']
  for (const suffix of suffixes) {
    try {
      return JSON.parse(stripped + suffix)
    } catch (_) {}
  }

  // 4. Find last complete entity by cutting at last "},{"
  const lastCompleteEntity = stripped.lastIndexOf('},\n  {')
    || stripped.lastIndexOf('},{')
  if (lastCompleteEntity > 0) {
    // Close the entities array at the last complete entity
    const truncated = stripped.substring(0, lastCompleteEntity + 1) + ']}'
    try {
      return JSON.parse(truncated)
    } catch (_) {}
    // Try wrapping in {"entities": ...}
    const asEntities = '{"entities":' + stripped.substring(0, lastCompleteEntity + 1) + ']}'
    try {
      return JSON.parse(asEntities)
    } catch (_) {}
  }

  // 5. Final: throw with helpful diagnostic message
  throw new Error(
    `Entity inference JSON parse failed after ${text.length} chars — ` +
    `response was truncated. Consider increasing max_tokens further. ` +
    `First 200 chars: ${text.substring(0, 200)}`
  )
}

/**
 * Infer entities from user prompt using AI + Domain Templates
 * 
 * NEW BEHAVIOR:
 * 1. Check domain templates first (instant)
 * 2. Fall back to AI inference
 * 3. Auto-inject default fields
 * 4. Execute on confidence > 0.6
 */
export async function inferEntities(
  prompt: string,
  projectId: string,
  graph: BackendStateGraph,
  semanticUnderstanding?: SemanticUnderstanding
): Promise<EntityInferenceResult> {
  // Only log in non-test environments to prevent "Cannot log after tests are done"
  const isTestEnvironment = process.env.NODE_ENV === 'test'
  
  if (!isTestEnvironment) {
    console.log('🔥 ENTITY INFERENCE ACTIVATED - THIS IS THE SMOKING GUN 🔥')
    console.log('Prompt:', prompt)
    console.log('Project ID:', projectId)
  }
  
  const startTime = Date.now()
  
  try {
    logger.info('[Entity Inference] AGGRESSIVE MODE - Starting inference', { 
      projectId, 
      promptLength: prompt.length,
      hasSemanticContext: !!semanticUnderstanding,
      existingEntities: Object.keys(graph.entities).length
    })
    
    // PHASE 0: CHECK FOR EXISTING ENTITIES (DUPLICATION DETECTION)
    const existingEntityNames = Object.keys(graph.entities)
    const hasExistingEntities = existingEntityNames.length > 0
    
    if (hasExistingEntities) {
      logger.info('[Entity Inference] Graph-aware mode - existing entities:', existingEntityNames)
    } else {
      logger.info('[Entity Inference] Fresh project - no existing entities')
    }
    
    // PHASE 0.1: LOAD ARCHITECTURAL MEMORY
    const archMemory = await loadArchitecturalMemory(projectId)
    const memoryContext = generateMemoryContext(archMemory)
    
    logger.info('[Arch Memory] Memory loaded for inference', {
      projectId,
      namingStyle: archMemory.namingStyle.entityCase,
      integrationPatterns: archMemory.integrationPatterns.length,
      corrections: archMemory.userCorrections.length,
    })
    
    // STEP 1: Use semantic understanding if available (has priority over templates)
    if (semanticUnderstanding && semanticUnderstanding.probableEntities.length > 0) {
      logger.info('[Entity Inference] Using semantic understanding context', {
        probableEntities: semanticUnderstanding.probableEntities,
        ambiguityScore: semanticUnderstanding.ambiguityScore
      })
      
      // If semantic understanding detected multiple entities, use them directly
      if (semanticUnderstanding.probableEntities.length > 1) {
        logger.info('[Entity Inference] Multiple entities detected, using semantic understanding', {
          entityCount: semanticUnderstanding.probableEntities.length,
          entities: semanticUnderstanding.probableEntities
        })
        // Continue to AI inference with full entity list
      }
    }
    
    // STEP 1.5: Check domain templates only for single-entity cases
    const templateMatch = matchDomainTemplate(prompt)
    if (templateMatch) {
      // Only use template if semantic understanding didn't detect multiple entities
      if (!semanticUnderstanding || semanticUnderstanding.probableEntities.length <= 1) {
        logger.info('[Entity Inference] ✅ Template match found', { template: templateMatch.name })
        
        return {
          success: true,
          entities: [templateMatch],
          enrichedPrompt: `Create a ${templateMatch.name} table with ${templateMatch.fields.map(f => f.name).join(', ')} fields`,
          confidence: 'high',
          reasoning: `Matched domain template for "${templateMatch.name}"`,
          originalPrompt: prompt,
        }
      } else {
        logger.info('[Entity Inference] Template match found but semantic has multiple entities, using AI inference', {
          template: templateMatch.name,
          semanticEntities: semanticUnderstanding.probableEntities
        })
      }
    }
    
    // STEP 2: Build architecture context for AI
    // SECURITY: Sanitize context to ensure NO row data reaches AI
    const architectureContext = {
      entities: Object.keys(graph.entities).map(name => ({
        name,
        fields: Object.keys(graph.entities[name].fields || {})
      }))
    }
    
    // Defense-in-depth: Run sanitizer even though we only pass schema
    const sanitizationResult = sanitizeAIContext({ schema: { tables: architectureContext.entities } })
    if (sanitizationResult.violations.length > 0) {
      logger.warn('[Entity Inference] Context sanitization warnings:', sanitizationResult.violations)
    }
    
    const existingArchitecture = hasExistingEntities 
      ? `\n\nEXISTING ARCHITECTURE:\n${JSON.stringify(architectureContext, null, 2)}\n\nYou MUST consider this existing schema.`
      : '\n\nThis is a NEW PROJECT with no existing entities.'
    
    // STEP 2.1: Inject architectural memory
    const memoryPrompt = memoryContext 
      ? `\n\nUSER'S ARCHITECTURAL PREFERENCES:\n${memoryContext}\n\nADAPT to these learned preferences.`
      : ''
    
    logger.info('[Entity Inference] No template match, using AI inference with architecture context')
    
    // Get OpenAI client
    const openai = getOpenAIClient()
    
    // Call OpenAI with CONTEXT-AWARE prompt
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: `You are a CONTEXT-AWARE backend architect for an intelligent backend builder.

GOAL: Infer entities from user prompts while RESPECTING existing architecture.
${existingArchitecture}
${memoryPrompt}

CRITICAL RULES:
1. NEVER duplicate existing entities
2. PREFER extending existing entities over creating new ones
3. ALWAYS link new entities to existing entities via relations
4. If entity already exists, suggest EXTENSION MODE (add fields/relations)
5. Explain integration strategy in reasoning

BEHAVIOR EXAMPLES:
- If "users" exists and prompt says "reviews" → Link reviews to users
- If "courses" exists and prompt says "lessons" → Link lessons to courses
- If "posts" exists and prompt says "comments" → Link comments to posts

EXTENSION MODE:
If requested entity already exists, return:
{
  "mode": "extend",
  "existingEntity": "users",
  "newFields": [{ "name": "bio", "type": "string" }],
  "reasoning": "Extending users table instead of creating duplicate"
}

CREATION MODE:
If new entity needed:
{
  "entities": [
    {
      "name": "reviews",
      "fields": [
        { "name": "userId", "type": "relation", "relationTo", "users", "required": true },
        { "name": "rating", "type": "number", "required": true },
        { "name": "comment", "type": "string" }
      ],
      "description": "User reviews linked to existing users"
    }
  ],
  "confidence": "high",
  "reasoning": "Created new reviews entity and linked to existing users table"
}

FIELD EXTRACTION RULES (CRITICAL):
When user describes a table with field lists like:
- "create products with name, price, and quantity"
- "add a reviews table with rating and comment"
- "orders table with total, status, and items"

You MUST extract EVERY mentioned field. Examples:
- "products with name, price, quantity" → fields: [{name:"name",type:"string"}, {name:"price",type:"number"}, {name:"quantity",type:"number"}]
- "reviews with rating and comment" → fields: [{name:"rating",type:"number"}, {name:"comment",type:"string"}]

Type inference:
- name, title, description, email → string
- price, amount, cost, total → number
- count, quantity, number → number
- active, enabled, verified → boolean
- date, time → date

NEVER return empty fields if user mentioned field names.
It is INVALID to create a table without the fields the user specified.

FIELD RULES:
- Auto-inject: id, createdAt, updatedAt (don't list explicitly)
- Types: string, number, boolean, date, json, relation
- Always include userId relation for user-generated content

CRITICAL AUTH TABLE RULE:
All entities that represent people who sign in to the application MUST use a single 'users' table.
NEVER create separate primary auth tables named 'members', 'customers', 'clients', 'founders', 
'providers', 'instructors', 'students', 'sitters', 'owners', 'writers', 'readers', etc.
Instead, always name the primary authentication entity 'users' and use a 'role' or 'type' field 
to differentiate account types (e.g. role: 'instructor' | 'student').
For role-specific data, create separate profile tables (e.g. instructor_profiles, student_profiles).

EXAMPLES:
- Fitness app with "members" and "instructors" → users table (role: 'member'|'instructor') + instructor_profiles
- Pet care with "owners" and "sitters" → users table (role: 'owner'|'sitter') + sitter_profiles
- Analytics with "founders" → users table (role: 'founder')
- Appointment app with "providers" and "clients" → users table (role: 'provider'|'client')

Confidence levels: "high" (obvious), "medium" (reasonable), "low" (ambiguous)

Return ONLY valid JSON, no markdown.`
        },
        {
          role: 'user',
          content: `Infer backend entities from: "${prompt}"
${semanticUnderstanding && semanticUnderstanding.probableEntities.length > 0 
  ? `\nSEMANTIC ANALYSIS DETECTED THESE ENTITIES: ${semanticUnderstanding.probableEntities.join(', ')}\nYou MUST create ALL of these entities with appropriate fields and relationships.` 
  : ''}`
        }
      ],
      temperature: 0.4, // Slightly higher for creativity
      max_tokens: 4000, // Increased from 1500 to prevent JSON truncation on complex apps
    })

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error('No response from AI')
    }

    // Parse AI response — with robust truncation recovery
    const parsed = safeParseEntityJSON(content.trim())
    
    // DEBUG: Log what the LLM returned
    console.log('[Entity Inference] 🤖 LLM RAW RESPONSE:')
    console.log('[Entity Inference] Content:', content.substring(0, 500))
    console.log('[Entity Inference] Parsed entities:', parsed.entities?.map((e: any) => ({
      name: e.name,
      fieldCount: e.fields?.length || 0,
      fields: e.fields?.map((f: any) => f.name)
    })))
    
    // ============================================================================
    // DETERMINISTIC FIELD EXTRACTION GUARD
    // If LLM returned entities with NO fields, but user specified inline fields,
    // extract them deterministically and inject into the result
    // ============================================================================
    const debugLog = `[Entity Inference] 🔍 Checking for deterministic field extraction...
[Entity Inference]   Prompt: ${prompt.substring(0, 100)}
[Entity Inference]   Parsed entities: ${parsed.entities?.length || 0}
[Entity Inference]   First entity name: ${parsed.entities?.[0]?.name}
[Entity Inference]   First entity fields: ${parsed.entities?.[0]?.fields?.length || 0}
`
    console.log(debugLog)
    
    // Also write to file for debugging
    try {
      fs.appendFileSync(path.join(process.cwd(), 'entity-inference-debug.log'), debugLog + '\n')
    } catch (e) {
      // Ignore file write errors
    }
    
    if (parsed.entities && parsed.entities.length > 0) {
      // Get entity names to filter out from inline field extraction
      const parsedEntityNames = parsed.entities.map((e: any) => e.name)
      console.log('[Entity Inference] 📊 Parsed entity names for filtering:', parsedEntityNames.join(', '))

      const inlineFields = extractInlineFields(prompt, parsedEntityNames)
      const inlineLog = `[Entity Inference]   Inline fields extracted: ${inlineFields.length}
[Entity Inference]   Inline fields: ${inlineFields.map(f => f.name).join(', ') || '(none - all were entity names or no matches)'}`
      console.log(inlineLog)

      try {
        fs.appendFileSync(path.join(process.cwd(), 'entity-inference-debug.log'), inlineLog + '\n')
      } catch (e) {}

      // CRITICAL: Only inject if we found actual fields that aren't entity names
      if (inlineFields.length > 0) {
        const enterBlockLog = '[Entity Inference] >>> ENTERING inlineFields.length > 0 block - INJECTING FIELDS'
        console.log(enterBlockLog)
        try {
          fs.appendFileSync(path.join(process.cwd(), 'entity-inference-debug.log'), enterBlockLog + '\n')
        } catch (e) {}

        try {
          console.log('[Entity Inference] 🎯 Found real fields to inject:', inlineFields.length, 'fields:', inlineFields.map(f => f.name).join(', '))

          // Check if LLM returned empty fields for the primary entity
          const primaryEntity = parsed.entities[0]
          console.log('[Entity Inference]   Primary entity:', primaryEntity?.name)
          console.log('[Entity Inference]   Primary entity existing fields:', JSON.stringify(primaryEntity?.fields?.map((f: any) => f.name)))

          const hasMeaningfulFields = primaryEntity.fields?.some((f: any) =>
            f.name !== 'id' && f.name !== 'created_at' && f.name !== 'updated_at'
          )

          console.log('[Entity Inference]   Primary entity has meaningful fields:', hasMeaningfulFields)

          // Only inject if LLM didn't already provide good fields
          if (!hasMeaningfulFields) {
            console.log('[Entity Inference] ✅ LLM provided empty/system fields only, injecting from inline extraction...')
            primaryEntity.fields = [
              ...(primaryEntity.fields || []).filter((f: any) =>
                f.name === 'id' || f.name === 'created_at' || f.name === 'updated_at'
              ),
              ...inlineFields
            ]
          } else {
            console.log('[Entity Inference] ✅ LLM already provided good fields, SKIPPING injection')
          }

          const injectedFieldsLog = `[Entity Inference] ✅ Final fields in primary entity: ${primaryEntity.fields.map((f: any) => f.name).join(', ')}`
          console.log(injectedFieldsLog)
          fs.appendFileSync(path.join(process.cwd(), 'entity-inference-debug.log'), injectedFieldsLog + '\n')

          const successLog = '[Entity Inference] ✅✅✅ FIELD PROCESSING COMPLETE ✅✅✅'
          console.log(successLog)
          fs.appendFileSync(path.join(process.cwd(), 'entity-inference-debug.log'), successLog + '\n')
        } catch (err: any) {
          const errorLog = `[Entity Inference] ❌❌❌ ERROR IN FIELD PROCESSING: ${err.message}`
          console.error(errorLog)
          fs.appendFileSync(path.join(process.cwd(), 'entity-inference-debug.log'), errorLog + '\n')
        }
      } else {
        console.log('[Entity Inference] ℹ️✅ No inline fields found (expected for "with entity1, entity2" patterns) - KEEPING LLM-PROVIDED FIELDS')
      }
    } else {
      console.log('[Entity Inference] ℹ️ No entities parsed from LLM response')
    }
    
    // HANDLE EXTENSION MODE
    if (parsed.mode === 'extend') {
      logger.info('[Entity Inference] EXTENSION MODE detected', {
        existingEntity: parsed.existingEntity,
        newFieldsCount: parsed.newFields?.length || 0
      })
      
      // Convert extension to entity format for downstream processing
      // The execution layer will handle merging
      const extensionEntity: InferredEntity = {
        name: parsed.existingEntity,
        fields: parsed.newFields || [],
        description: `Extension to existing ${parsed.existingEntity}`,
      }
      
      const result: EntityInferenceResult = {
        success: true,
        entities: [extensionEntity],
        enrichedPrompt: `Add ${parsed.newFields?.map((f: any) => f.name).join(', ')} fields to ${parsed.existingEntity}`,
        confidence: 'high',
        reasoning: parsed.reasoning || `Extending existing ${parsed.existingEntity} instead of creating duplicate`,
        originalPrompt: prompt,
      }
      
      logger.info('[Entity Inference] ✅ Extension inference complete', {
        projectId,
        entity: parsed.existingEntity,
        fieldsToAdd: parsed.newFields?.length || 0,
      })
      
      return result
    }
    
    // HANDLE CREATION MODE (standard)
    // Build enriched prompt
    const enrichedPrompt = buildEnrichedPrompt(parsed.entities || [])
    
    const result: EntityInferenceResult = {
      success: true,
      entities: parsed.entities || [],
      enrichedPrompt,
      confidence: parsed.confidence || 'medium',
      reasoning: parsed.reasoning || 'AI inferred from prompt',
      originalPrompt: prompt,
    }

    const duration = Date.now() - startTime
    logger.info('[Entity Inference] ✅ AI inference complete', {
      projectId,
      entityCount: result.entities.length,
      confidence: result.confidence,
      duration,
    })

    return result

  } catch (error: any) {
    logger.error('[Entity Inference] Inference failed', {
      projectId,
      error: error.message,
      prompt: prompt.substring(0, 100),
    })

    // Fallback: return generic entity
    const genericEntity: InferredEntity = {
      name: 'items',
      fields: [
        { name: 'name', type: 'string', required: true },
        { name: 'description', type: 'string' },
      ],
      description: 'Generic data items',
    }

    return {
      success: true,
      entities: [genericEntity],
      enrichedPrompt: 'Create an items table with name and description fields',
      confidence: 'low',
      reasoning: `Inference failed, using generic fallback: ${error.message}`,
      originalPrompt: prompt,
    }
  }
}

/**
 * Match prompt against domain templates
 */
function matchDomainTemplate(prompt: string): InferredEntity | null {
  const lowerPrompt = prompt.toLowerCase()
  
  for (const [key, template] of Object.entries(DOMAIN_TEMPLATES)) {
    if (lowerPrompt.includes(key)) {
      return template
    }
  }
  
  return null
}

/**
 * Build enriched prompt from entities
 */
function buildEnrichedPrompt(entities: InferredEntity[]): string {
  if (entities.length === 0) {
    return 'Create backend entities'
  }
  
  return entities.map(entity => {
    const fields = entity.fields.map(f => {
      if (f.type === 'relation') {
        return `${f.name} (relation to ${f.relationTo})`
      }
      return `${f.name} (${f.type})`
    }).join(', ')
    
    return `Create a ${entity.name} table with ${fields}`
  }).join('. ')
}

/**
 * Check if prompt needs entity inference
 * 
 * NEW BEHAVIOR: Always return true for ANY entity-related prompt
 * Even single words like "review", "comment", "post"
 */
export function needsEntityInference(prompt: string): boolean {
  const lowerPrompt = prompt.toLowerCase()
  
  console.log('[needsEntityInference] Checking prompt:', prompt.substring(0, 100))
  
  // Check if this matches a domain template (aggressive matching)
  const hasTemplateMatch = Object.keys(DOMAIN_TEMPLATES).some(key => 
    lowerPrompt.includes(key)
  )
  
  console.log('[needsEntityInference] hasTemplateMatch:', hasTemplateMatch)
  
  if (hasTemplateMatch) {
    console.log('[needsEntityInference] Returning TRUE (template match)')
    return true // Always infer for known entities
  }
  
  // Indicators that entities are already explicitly specified in structured format
  // NOTE: We now handle natural language field descriptions in entity inference
  const hasStructuredSpec = 
    /create\s+table\s+\w+\s*\([^)]+\)/i.test(prompt) ||  // CREATE TABLE xxx (field1, field2)
    /\{\s*"name"\s*:\s*"\w+"\s*,\s*"type"/i.test(prompt)  // JSON schema format
  
  console.log('[needsEntityInference] hasStructuredSpec:', hasStructuredSpec)
  
  if (hasStructuredSpec) {
    console.log('[needsEntityInference] Returning FALSE (structured spec)')
    return false // Already has structured spec, no inference needed
  }
  
  // Any mention of creating/adding entities
  const hasCreate = /create|add|build|make/i.test(lowerPrompt)
  const hasTable = /table|entity|model|collection/i.test(lowerPrompt)
  const isEntityCreation = hasCreate && (hasTable || hasTemplateMatch)
  
  console.log('[needsEntityInference] hasCreate:', hasCreate, 'hasTable:', hasTable, 'isEntityCreation:', isEntityCreation)
  console.log('[needsEntityInference] Returning:', isEntityCreation)
  
  return isEntityCreation
}

/**
 * Validate inferred entities before passing to spec validator
 */
export function validateInferredEntities(entities: InferredEntity[]): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []
  
  if (entities.length === 0) {
    errors.push('No entities inferred')
  }
  
  for (const entity of entities) {
    // Validate entity name
    if (!entity.name || !/^[a-z_]+$/.test(entity.name)) {
      errors.push(`Invalid entity name: "${entity.name}" (must be lowercase with underscores)`)
    }
    
    // Validate fields
    if (!entity.fields || entity.fields.length === 0) {
      errors.push(`Entity "${entity.name}" has no fields`)
    }
    
    for (const field of entity.fields || []) {
      if (!field.name || !/^[a-z_]+$/.test(field.name)) {
        errors.push(`Invalid field name: "${field.name}" in entity "${entity.name}"`)
      }
      
      const validTypes = ['string', 'number', 'boolean', 'date', 'json', 'relation']
      if (!validTypes.includes(field.type)) {
        errors.push(`Invalid field type: "${field.type}" for "${entity.name}.${field.name}"`)
      }
      
      // Validate relations
      if (field.type === 'relation' && !field.relationTo) {
        errors.push(`Relation field "${entity.name}.${field.name}" missing relationTo`)
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  }
}
