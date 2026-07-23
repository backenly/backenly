/**
 * MISSING PIECE 1: CONVERSATION CONTEXT ADAPTER
 * 
 * Injects recent conversation memory into semantic understanding layer
 * Enables multi-turn understanding: "add more fields", "do the same for tasks", "undo that"
 * 
 * CRITICAL CONSTRAINTS:
 * - Adapter layer only (sits between UI and orchestration)
 * - Does NOT modify semantic-understanding.ts
 * - Enriches prompt context with conversation history
 * - Non-invasive: can be disabled without breaking execution
 */

import { conversationMemory, ConversationMessage } from './ConversationMemoryBuffer'
import { BackendStateGraph } from '../orchestration/backend-state-graph'

/**
 * Context injection result
 */
export interface EnrichedPromptContext {
  // Original prompt from user
  originalPrompt: string
  
  // Enriched prompt with conversation context
  enrichedPrompt: string
  
  // Conversation summary for display
  conversationSummary?: string
  
  // Entities mentioned in recent conversation
  recentEntities: string[]
  
  // Recent actions (for "do the same", "like before" understanding)
  recentActions: string[]
  
  // Pronoun resolution context
  pronounContext?: {
    lastEntity?: string
    lastAction?: string
    lastCapability?: string
  }
}

/**
 * Inject conversation memory into prompt context
 * 
 * This enables multi-turn understanding without modifying semantic layer
 */
export function injectConversationContext(
  projectId: string,
  userPrompt: string,
  graph?: BackendStateGraph
): EnrichedPromptContext {
  // Get recent conversation history
  const recentMessages = conversationMemory.getRecentContext(projectId, 5)
  
  // Extract entities and actions from recent conversation
  const recentEntities = extractRecentEntities(recentMessages, graph)
  const recentActions = extractRecentActions(recentMessages)
  const pronounContext = buildPronounContext(recentMessages, graph)
  
  // Check if prompt contains pronouns or references
  const needsContextInjection = detectContextualReferences(userPrompt)
  
  if (!needsContextInjection || recentMessages.length === 0) {
    // No context injection needed
    return {
      originalPrompt: userPrompt,
      enrichedPrompt: userPrompt,
      recentEntities: [],
      recentActions: [],
    }
  }
  
  // Build enriched prompt
  const enrichedPrompt = buildEnrichedPrompt(
    userPrompt,
    recentMessages,
    recentEntities,
    recentActions,
    pronounContext
  )
  
  // Build conversation summary for display
  const conversationSummary = buildConversationSummary(recentMessages)
  
  return {
    originalPrompt: userPrompt,
    enrichedPrompt,
    conversationSummary,
    recentEntities,
    recentActions,
    pronounContext,
  }
}

/**
 * Extract entities mentioned in recent conversation
 */
function extractRecentEntities(
  messages: ConversationMessage[],
  graph?: BackendStateGraph
): string[] {
  const entities = new Set<string>()
  
  // From conversation metadata
  for (const msg of messages) {
    if (msg.metadata?.entities) {
      msg.metadata.entities.forEach(e => entities.add(e))
    }
  }
  
  // From backend state graph (recent entities)
  if (graph) {
    const graphEntities = Object.keys(graph.entities)
    const recentEntities = graphEntities.slice(-5) // Last 5 entities created
    recentEntities.forEach(e => entities.add(e))
  }
  
  return Array.from(entities)
}

/**
 * Extract recent actions from conversation
 */
function extractRecentActions(messages: ConversationMessage[]): string[] {
  const actions: string[] = []
  
  for (const msg of messages) {
    const content = msg.content.toLowerCase()
    
    // Detect action patterns
    if (content.includes('added') || content.includes('created')) {
      actions.push('create')
    }
    if (content.includes('modified') || content.includes('updated')) {
      actions.push('modify')
    }
    if (content.includes('removed') || content.includes('deleted')) {
      actions.push('delete')
    }
    if (content.includes('enabled') || content.includes('activated')) {
      actions.push('enable')
    }
  }
  
  return Array.from(new Set(actions))
}

/**
 * Build pronoun resolution context
 */
function buildPronounContext(
  messages: ConversationMessage[],
  graph?: BackendStateGraph
): EnrichedPromptContext['pronounContext'] {
  const lastUserMsg = messages.reverse().find(m => m.role === 'USER')
  const lastAIMsg = messages.find(m => m.role === 'AI')
  
  let lastEntity: string | undefined
  let lastAction: string | undefined
  let lastCapability: string | undefined
  
  // Extract from last AI response metadata
  if (lastAIMsg?.metadata) {
    lastEntity = lastAIMsg.metadata.entities?.[0]
  }
  
  // Extract from graph (most recent entity)
  if (graph) {
    const entities = Object.values(graph.entities).sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    if (entities[0]) {
      lastEntity = entities[0].name
    }
  }
  
  // Extract last action from user message
  if (lastUserMsg) {
    const content = lastUserMsg.content.toLowerCase()
    if (content.includes('add') || content.includes('create')) lastAction = 'create'
    if (content.includes('update') || content.includes('modify')) lastAction = 'modify'
    if (content.includes('delete') || content.includes('remove')) lastAction = 'delete'
  }
  
  return {
    lastEntity,
    lastAction,
    lastCapability,
  }
}

/**
 * Detect if prompt contains contextual references
 */
function detectContextualReferences(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  
  // Pronouns
  if (/\b(it|them|that|those|this|these)\b/.test(lower)) return true
  
  // Comparative references
  if (/\b(same|similar|like before|again|also|too)\b/.test(lower)) return true
  
  // Action references
  if (/\b(more|another|additional|extra)\b/.test(lower)) return true
  
  // Temporal references
  if (/\b(last|previous|earlier)\b/.test(lower)) return true
  
  return false
}

/**
 * Build enriched prompt with conversation context
 */
function buildEnrichedPrompt(
  userPrompt: string,
  recentMessages: ConversationMessage[],
  recentEntities: string[],
  recentActions: string[],
  pronounContext?: EnrichedPromptContext['pronounContext']
): string {
  const parts: string[] = []
  
  // Add conversation context header
  parts.push('[Conversation Context]')
  
  // Add recent entities
  if (recentEntities.length > 0) {
    parts.push(`Recent entities: ${recentEntities.join(', ')}`)
  }
  
  // Add recent actions
  if (recentActions.length > 0) {
    parts.push(`Recent actions: ${recentActions.join(', ')}`)
  }
  
  // Add pronoun resolution context
  if (pronounContext) {
    if (pronounContext.lastEntity) {
      parts.push(`Last entity mentioned: ${pronounContext.lastEntity}`)
    }
    if (pronounContext.lastAction) {
      parts.push(`Last action: ${pronounContext.lastAction}`)
    }
  }
  
  // Add recent conversation summary (last 2 exchanges)
  const lastExchanges = recentMessages.slice(-2)
  if (lastExchanges.length > 0) {
    parts.push('Recent conversation:')
    lastExchanges.forEach(msg => {
      const role = msg.role === 'USER' ? 'User' : 'AI'
      const preview = msg.content.slice(0, 100)
      parts.push(`${role}: ${preview}${msg.content.length > 100 ? '...' : ''}`)
    })
  }
  
  parts.push('[/Context]')
  parts.push('')
  
  // Add original user prompt
  parts.push('[Current Request]')
  parts.push(userPrompt)
  
  return parts.join('\n')
}

/**
 * Build conversation summary for UI display
 */
function buildConversationSummary(messages: ConversationMessage[]): string {
  if (messages.length === 0) return ''
  
  const summaryParts: string[] = []
  
  // Count exchanges
  const userMessages = messages.filter(m => m.role === 'USER').length
  summaryParts.push(`${userMessages} exchange${userMessages > 1 ? 's' : ''}`)
  
  // Extract entities mentioned
  const allEntities = new Set<string>()
  messages.forEach(msg => {
    if (msg.metadata?.entities) {
      msg.metadata.entities.forEach(e => allEntities.add(e))
    }
  })
  
  if (allEntities.size > 0) {
    summaryParts.push(`discussing ${Array.from(allEntities).slice(0, 3).join(', ')}`)
  }
  
  return summaryParts.join(' · ')
}

/**
 * Helper: Resolve pronouns using conversation context
 * 
 * This can be called from UI layer before sending to orchestration
 */
export function resolvePronounsWithContext(
  projectId: string,
  prompt: string,
  graph?: BackendStateGraph
): string {
  const context = injectConversationContext(projectId, prompt, graph)
  
  if (!context.pronounContext) return prompt
  
  let resolved = prompt
  
  // Simple pronoun replacement
  if (context.pronounContext.lastEntity) {
    resolved = resolved.replace(/\bit\b/gi, context.pronounContext.lastEntity)
    resolved = resolved.replace(/\bthat\b/gi, context.pronounContext.lastEntity)
  }
  
  return resolved
}

/**
 * Helper: Detect if prompt is a follow-up action
 */
export function detectFollowUpAction(prompt: string): {
  isFollowUp: boolean
  referenceType?: 'same' | 'similar' | 'more' | 'undo'
  confidence: number
} {
  const lower = prompt.toLowerCase()
  
  // "do the same" pattern
  if (/\b(same|similar|like before)\b/.test(lower)) {
    return {
      isFollowUp: true,
      referenceType: 'same',
      confidence: 0.9,
    }
  }
  
  // "add more" pattern
  if (/\b(more|another|additional|also)\b/.test(lower)) {
    return {
      isFollowUp: true,
      referenceType: 'more',
      confidence: 0.85,
    }
  }
  
  // "undo" pattern
  if (/\b(undo|revert|rollback)\b/.test(lower)) {
    return {
      isFollowUp: true,
      referenceType: 'undo',
      confidence: 1.0,
    }
  }
  
  return {
    isFollowUp: false,
    confidence: 0,
  }
}
