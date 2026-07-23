/**
 * PHASE 3: FLOW REASONING ENGINE
 * 
 * Models actors, actions, and interactions to guide architectural decisions.
 * Transforms entity inference from "tables" to "real-world workflows".
 */

import { getOpenAIClient } from '@/lib/ai/openai-service'
import { logger } from '@/lib/logger'
import type { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'

/**
 * Actor in the system (user types, roles)
 */
export interface Actor {
  name: string
  type: 'user_role' | 'system' | 'external'
  description: string
  capabilities: string[]
}

/**
 * Action that actors can perform
 */
export interface Action {
  name: string
  actor: string
  verb: string // create, read, update, delete, send, receive, etc.
  target: string // entity being acted upon
  description: string
}

/**
 * Interaction between actors
 */
export interface Interaction {
  id: string
  fromActor: string
  toActor: string
  action: string
  context: string // e.g., "within a course", "for a project"
  requiresEntity?: string // linking entity needed
}

/**
 * Complete interaction graph
 */
export interface InteractionGraph {
  actors: Actor[]
  actions: Action[]
  interactions: Interaction[]
  dataFlows: Array<{
    from: string
    to: string
    data: string
    trigger: string
  }>
  suggestedEntities: Array<{
    name: string
    purpose: string
    relatesTo: string[]
  }>
}

/**
 * Infer interaction graph from domain and existing schema
 */
export async function inferInteractionGraph(
  domain: string,
  intentSummary: string,
  existingGraph: BackendStateGraph
): Promise<InteractionGraph> {
  const startTime = Date.now()
  
  try {
    logger.info('[Flow Reasoning] Starting interaction inference', {
      domain,
      existingEntities: Object.keys(existingGraph.entities).length,
    })
    
    const openai = getOpenAIClient()
    
    // Build context from existing entities
    const existingEntities = Object.keys(existingGraph.entities)
    const existingContext = existingEntities.length > 0
      ? `\n\nEXISTING ENTITIES: ${existingEntities.join(', ')}`
      : ''
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: `You are a system architect who models real-world workflows.

GOAL: Infer actors, actions, and interactions from the domain.

DOMAIN: ${domain}
USER INTENT: ${intentSummary}${existingContext}

RULES:
1. Identify WHO uses the system (actors)
2. Identify WHAT they do (actions)
3. Identify HOW they interact (interactions)
4. Model data flows between actors
5. Suggest entities that support these flows

ACTOR TYPES:
- user_role: Students, Teachers, Admins, Customers, etc.
- system: Automated processes, schedulers
- external: Third-party services, APIs

RETURN JSON:
{
  "actors": [
    {
      "name": "students",
      "type": "user_role",
      "description": "Learners taking courses",
      "capabilities": ["enroll", "submit", "view_grades"]
    }
  ],
  "actions": [
    {
      "name": "enroll_in_course",
      "actor": "students",
      "verb": "create",
      "target": "enrollments",
      "description": "Student enrolls in a course"
    }
  ],
  "interactions": [
    {
      "id": "student_instructor_messaging",
      "fromActor": "students",
      "toActor": "instructors",
      "action": "send_message",
      "context": "within a course",
      "requiresEntity": "course_messages"
    }
  ],
  "dataFlows": [
    {
      "from": "students",
      "to": "instructors",
      "data": "assignment_submissions",
      "trigger": "student submits work"
    }
  ],
  "suggestedEntities": [
    {
      "name": "enrollments",
      "purpose": "Track student-course relationships",
      "relatesTo": ["students", "courses"]
    }
  ]
}

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: 'Analyze this domain and infer the interaction graph'
        }
      ],
      temperature: 0.5,
      max_tokens: 2000,
    })
    
    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error('No response from AI')
    }
    
    const graph = JSON.parse(content.trim())
    
    const duration = Date.now() - startTime
    logger.info('[Flow Reasoning] Interaction graph inferred', {
      actors: graph.actors?.length || 0,
      actions: graph.actions?.length || 0,
      interactions: graph.interactions?.length || 0,
      duration,
    })
    
    return graph
    
  } catch (error: any) {
    logger.error('[Flow Reasoning] Inference failed', {
      error: error.message,
    })
    
    // Return minimal graph
    return {
      actors: [],
      actions: [],
      interactions: [],
      dataFlows: [],
      suggestedEntities: [],
    }
  }
}

/**
 * Detect actors from existing schema
 */
export function detectActorsFromSchema(graph: BackendStateGraph): Actor[] {
  const actors: Actor[] = []
  const entityNames = Object.keys(graph.entities)
  
  // Common actor patterns
  const actorPatterns = [
    { pattern: /user|account|profile/i, name: 'users', type: 'user_role' as const },
    { pattern: /admin|moderator/i, name: 'admins', type: 'user_role' as const },
    { pattern: /student|learner/i, name: 'students', type: 'user_role' as const },
    { pattern: /teacher|instructor|tutor/i, name: 'instructors', type: 'user_role' as const },
    { pattern: /customer|client/i, name: 'customers', type: 'user_role' as const },
    { pattern: /vendor|supplier/i, name: 'vendors', type: 'user_role' as const },
  ]
  
  for (const entity of entityNames) {
    for (const { pattern, name, type } of actorPatterns) {
      if (pattern.test(entity) && !actors.find(a => a.name === name)) {
        actors.push({
          name,
          type,
          description: `${name.charAt(0).toUpperCase() + name.slice(1)} in the system`,
          capabilities: [],
        })
      }
    }
  }
  
  return actors
}

/**
 * Suggest linking entities based on interactions
 */
export function suggestLinkingEntities(
  interactions: Interaction[],
  existingEntities: string[]
): Array<{ name: string; links: string[]; purpose: string }> {
  const suggestions: Array<{ name: string; links: string[]; purpose: string }> = []
  
  for (const interaction of interactions) {
    if (interaction.requiresEntity && !existingEntities.includes(interaction.requiresEntity)) {
      suggestions.push({
        name: interaction.requiresEntity,
        links: [interaction.fromActor, interaction.toActor],
        purpose: `Enable ${interaction.action} between ${interaction.fromActor} and ${interaction.toActor}`,
      })
    }
  }
  
  return suggestions
}

/**
 * Generate flow context for entity inference
 */
export function generateFlowContext(graph: InteractionGraph): string {
  const parts: string[] = []
  
  if (graph.actors.length > 0) {
    const actorList = graph.actors.map(a => a.name).join(', ')
    parts.push(`ACTORS: ${actorList}`)
  }
  
  if (graph.interactions.length > 0) {
    const interactionDesc = graph.interactions
      .slice(0, 3)
      .map(i => `${i.fromActor} → ${i.toActor}: ${i.action}`)
      .join('; ')
    parts.push(`KEY INTERACTIONS: ${interactionDesc}`)
  }
  
  if (graph.suggestedEntities.length > 0) {
    const suggestions = graph.suggestedEntities
      .slice(0, 3)
      .map(e => e.name)
      .join(', ')
    parts.push(`SUGGESTED ENTITIES: ${suggestions}`)
  }
  
  return parts.join('\n')
}
