/**
 * Layer 1 — AI Conversation Layer (LLM ONLY)
 * 
 * CRITICAL RULES:
 * 1. AI may ONLY converse, clarify, and reassure
 * 2. AI must NEVER execute, mutate state, or claim success
 * 3. AI must NEVER mention technical terms (API, database, schema, JWT, RBAC, etc.)
 * 4. All responses are provisional and non-final
 * 
 * ALLOWED: "Got it", "Nothing is live yet", "Here's what I understand"
 * FORBIDDEN: "Users can now", "Your backend is ready", "I've created"
 */

import { chatCompletion, isAIEnabled } from '../openai/client'

export interface ConversationResponse {
  type: 'acknowledgment' | 'clarification' | 'guidance'
  message: string
  needsClarification: boolean
  suggestedBehaviors?: string[]
}

/**
 * AI Conversation Layer — Pre-Execution ONLY
 * 
 * Takes raw user input and produces a calm, non-technical response.
 * MUST NOT claim anything is done or will be done.
 */
export async function converseWithUser(
  userMessage: string,
  context?: {
    hasExistingBackend?: boolean
    previousIntent?: string
  }
): Promise<ConversationResponse> {
  
  const defaultResponse: ConversationResponse = {
    type: 'acknowledgment',
    message: "Got it. I understand what you're aiming for. Nothing is live yet — I'll show you exactly what would change before anything happens.",
    needsClarification: false
  }

  if (!isAIEnabled()) {
    return defaultResponse
  }

  try {
    const systemPrompt = `You are a calm, expert Product Manager helping a user build their backend.

CRITICAL RULES (NEVER VIOLATE):
1. You are ONLY here to understand and rephrase. You do NOT execute anything.
2. NEVER use technical terms: API, database, schema, table, auth provider, JWT, RBAC, infrastructure
3. NEVER claim anything is "done", "created", "enabled", or "ready"
4. ALWAYS state "Nothing is live yet" or similar
5. Focus on USER BEHAVIORS, not technical implementation
6. If the request is vague, ask what data they want to store
7. If the request is clear (single OR multiple actions), acknowledge ALL and say you'll show what would change

ALLOWED PHRASES:
- "Got it — here's how I understand this…"
- "Nothing is live yet."
- "Before I make any changes, I'll show you what would happen."
- "To move forward, I need one small confirmation."
- "I understand you want users to be able to..."

FORBIDDEN PHRASES (NEVER USE):
- "Users can now…"
- "Your backend is ready"
- "I've created…"
- Any mention of tables, APIs, endpoints, schemas
- Any claims of completion

RESPONSE FORMAT:
If the request is clear (single or multiple actions):
  "Got it. Users will be able to [BEHAVIOR 1], [BEHAVIOR 2], and [BEHAVIOR 3]. Nothing is live yet, and I'll show what changes."

If the request is vague:
  "I understand what you're aiming for. What kind of data should your app store? For example: users, posts, reviews, etc."

Keep responses to 1-2 sentences maximum.`

    const response = await chatCompletion([
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: `User wants: "${userMessage}"\n\nProvide a calm, non-technical acknowledgment. Remember: Nothing executes. You're just understanding their intent.`
      }
    ], { temperature: 0.3, maxTokens: 150 })

    const aiMessage = response?.choices[0]?.message?.content || defaultResponse.message

    // Safety check: Block any forbidden phrases
    const forbiddenPhrases = [
      'users can now',
      'backend is ready',
      "i've created",
      'api',
      'database',
      'table',
      'schema',
      'jwt',
      'rbac',
      'endpoint',
      'auth provider'
    ]

    const lowerMessage = aiMessage.toLowerCase()
    const hasForbiddenPhrase = forbiddenPhrases.some(phrase => lowerMessage.includes(phrase))

    if (hasForbiddenPhrase) {
      console.warn('[AI Conversation] Blocked response with forbidden technical terms:', aiMessage)
      return defaultResponse
    }

    // Determine if this needs clarification
    const needsClarification = lowerMessage.includes('to get started') || 
                              lowerMessage.includes('tell me one thing') ||
                              lowerMessage.includes('for example')

    return {
      type: needsClarification ? 'clarification' : 'acknowledgment',
      message: aiMessage,
      needsClarification
    }

  } catch (error) {
    console.error('[AI Conversation] Failed:', error)
    return defaultResponse
  }
}

/**
 * Post-Execution Summary (AI speaks AFTER execution)
 * 
 * CRITICAL: This runs ONLY after successful execution
 * Must be based on actual execution results, not AI imagination
 */
export function generatePostExecutionSummary(
  executionResult: {
    tablesCreated?: number
    apisCreated?: number
    changes?: any[]
  }
): string {
  // Check for deployment changes first
  if (executionResult.changes) {
    const deploymentChange = executionResult.changes.find(
      (c: any) => c.type === 'capability' && c.target === 'production'
    )
    if (deploymentChange?.details?.url) {
      return `Your backend is now live. All changes are available to users.\n\n🌐 Deployment URL: ${deploymentChange.details.url}`
    }
  }

  // Minimal, factual summary for other changes
  const parts: string[] = []

  if (executionResult.tablesCreated && executionResult.tablesCreated > 0) {
    parts.push(`Your app can now remember ${executionResult.tablesCreated === 1 ? 'a new type of' : `${executionResult.tablesCreated} types of`} information`)
  }

  if (executionResult.apisCreated && executionResult.apisCreated > 0) {
    parts.push(`Added ${executionResult.apisCreated === 1 ? 'a way' : `${executionResult.apisCreated} ways`} for users to interact with your app`)
  }

  if (parts.length === 0) {
    return "Here's what changed."
  }

  return parts.join('. ') + '.'
}

/**
 * Guard: Prevent AI from speaking during these operations
 */
export function shouldBlockAIConversation(operation: string): boolean {
  const blockedOperations = [
    'rollback',
    'restore',
    'export',
    'delete',
    'migration'
  ]

  return blockedOperations.includes(operation.toLowerCase())
}
