/**
 * PHASE 1: CONVERSATION MEMORY BUFFER
 * 
 * Lightweight dialogue history storage (last 10 exchanges)
 * 
 * CRITICAL CONSTRAINTS:
 * - UI-layer only - NEVER touches orchestration
 * - Stateless to execution pipeline
 * - Project-scoped, session-based
 * - Token-safe trimming
 * - Serializable for persistence
 */

export type MessageRole = 
  | 'USER' 
  | 'AI' 
  | 'CLARIFICATION' 
  | 'EXECUTION_RESULT'

export interface ConversationMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: string
  metadata?: {
    intent?: string
    entities?: string[]
    confidence?: number
    executionId?: string
  }
}

export interface ConversationContext {
  messages: ConversationMessage[]
  projectId: string
  sessionId: string
  createdAt: string
  lastUpdatedAt: string
}

const MAX_MESSAGES = 10
const MAX_TOKENS_PER_MESSAGE = 500 // Approximate token limit

/**
 * In-memory conversation buffer
 * Could be extended to persist to database/localStorage
 */
class ConversationMemoryBuffer {
  private contexts: Map<string, ConversationContext> = new Map()

  /**
   * Add message to conversation history
   */
  addMessage(
    projectId: string,
    message: Omit<ConversationMessage, 'id' | 'timestamp'>
  ): void {
    let context = this.contexts.get(projectId)
    
    if (!context) {
      context = {
        messages: [],
        projectId,
        sessionId: this.generateSessionId(),
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      }
      this.contexts.set(projectId, context)
    }

    // Create message with ID and timestamp
    const fullMessage: ConversationMessage = {
      ...message,
      id: this.generateMessageId(),
      timestamp: new Date().toISOString(),
    }

    // Trim content if too long (prevent token overflow)
    if (fullMessage.content.length > MAX_TOKENS_PER_MESSAGE * 4) {
      fullMessage.content = fullMessage.content.slice(0, MAX_TOKENS_PER_MESSAGE * 4) + '...'
    }

    // Add to history
    context.messages.push(fullMessage)

    // Keep only last MAX_MESSAGES
    if (context.messages.length > MAX_MESSAGES) {
      context.messages = context.messages.slice(-MAX_MESSAGES)
    }

    // Update timestamp
    context.lastUpdatedAt = new Date().toISOString()
  }

  /**
   * Get recent conversation context for a project
   */
  getRecentContext(projectId: string, limit?: number): ConversationMessage[] {
    const context = this.contexts.get(projectId)
    if (!context) return []

    const messages = context.messages
    const messageLimit = limit ?? MAX_MESSAGES

    return messages.slice(-messageLimit)
  }

  /**
   * Get full context object
   */
  getContext(projectId: string): ConversationContext | null {
    return this.contexts.get(projectId) || null
  }

  /**
   * Clear conversation history for a project
   */
  clear(projectId: string): void {
    this.contexts.delete(projectId)
  }

  /**
   * Clear all conversations (memory cleanup)
   */
  clearAll(): void {
    this.contexts.clear()
  }

  /**
   * Get last user message (for pronoun resolution)
   */
  getLastUserMessage(projectId: string): ConversationMessage | null {
    const messages = this.getRecentContext(projectId)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'USER') {
        return messages[i]
      }
    }
    return null
  }

  /**
   * Get last AI response
   */
  getLastAIMessage(projectId: string): ConversationMessage | null {
    const messages = this.getRecentContext(projectId)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'AI') {
        return messages[i]
      }
    }
    return null
  }

  /**
   * Get conversation summary for context window
   * Returns formatted string for display or context injection
   */
  getSummary(projectId: string): string {
    const messages = this.getRecentContext(projectId, 5)
    if (messages.length === 0) return ''

    return messages
      .map((msg) => {
        const role = msg.role === 'USER' ? 'You' : 'AI'
        const preview = msg.content.slice(0, 100)
        return `${role}: ${preview}${msg.content.length > 100 ? '...' : ''}`
      })
      .join('\n')
  }

  /**
   * Serialize context to JSON (for persistence)
   */
  serialize(projectId: string): string | null {
    const context = this.contexts.get(projectId)
    if (!context) return null
    return JSON.stringify(context)
  }

  /**
   * Deserialize context from JSON
   */
  deserialize(projectId: string, json: string): void {
    try {
      const context = JSON.parse(json) as ConversationContext
      this.contexts.set(projectId, context)
    } catch (error) {
      console.error('[ConversationMemoryBuffer] Failed to deserialize:', error)
    }
  }

  // Private helpers

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}

// Singleton instance
export const conversationMemory = new ConversationMemoryBuffer()

/**
 * Helper: Add user prompt to conversation
 */
export function recordUserPrompt(
  projectId: string,
  prompt: string,
  metadata?: ConversationMessage['metadata']
): void {
  conversationMemory.addMessage(projectId, {
    role: 'USER',
    content: prompt,
    metadata,
  })
}

/**
 * Helper: Add AI response to conversation
 */
export function recordAIResponse(
  projectId: string,
  response: string,
  metadata?: ConversationMessage['metadata']
): void {
  conversationMemory.addMessage(projectId, {
    role: 'AI',
    content: response,
    metadata,
  })
}

/**
 * Helper: Add clarification request
 */
export function recordClarification(
  projectId: string,
  question: string,
  metadata?: ConversationMessage['metadata']
): void {
  conversationMemory.addMessage(projectId, {
    role: 'CLARIFICATION',
    content: question,
    metadata,
  })
}

/**
 * Helper: Add execution result
 */
export function recordExecutionResult(
  projectId: string,
  summary: string,
  metadata?: ConversationMessage['metadata']
): void {
  conversationMemory.addMessage(projectId, {
    role: 'EXECUTION_RESULT',
    content: summary,
    metadata,
  })
}
