/**
 * PHASE 2: STRUCTURED MESSAGE TYPE SYSTEM
 * 
 * Formal message classification for conversational UI rendering
 * 
 * CRITICAL CONSTRAINTS:
 * - UI-layer only - rendering logic, NOT execution logic
 * - Consumes existing orchestration metadata
 * - NO new inference or computation
 */

/**
 * Message type enum for structured rendering
 */
export enum MessageType {
  USER_PROMPT = 'USER_PROMPT',
  AI_UNDERSTANDING = 'AI_UNDERSTANDING',
  AI_CONFIRMATION = 'AI_CONFIRMATION',
  CLARIFICATION_REQUEST = 'CLARIFICATION_REQUEST',
  EXECUTION_NARRATION = 'EXECUTION_NARRATION',
  EXECUTION_SUCCESS = 'EXECUTION_SUCCESS',
  EXECUTION_WARNING = 'EXECUTION_WARNING',
  ROLLBACK_INFO = 'ROLLBACK_INFO',
  SYSTEM_INFO = 'SYSTEM_INFO',
}

/**
 * Base structured message interface
 */
export interface StructuredMessage {
  id: string
  type: MessageType
  timestamp: string
  projectId: string
  
  // Rendering metadata
  displayConfig?: {
    icon?: string
    color?: string
    collapsible?: boolean
    defaultExpanded?: boolean
  }
}

/**
 * User prompt message
 */
export interface UserPromptMessage extends StructuredMessage {
  type: MessageType.USER_PROMPT
  content: string
  metadata?: {
    characterCount?: number
    wordCount?: number
  }
}

/**
 * AI understanding message (semantic interpretation)
 */
export interface AIUnderstandingMessage extends StructuredMessage {
  type: MessageType.AI_UNDERSTANDING
  interpretation: string
  entities: string[]
  relationships?: string[]
  capabilities?: string[]
  confidence?: number
  ambiguityScore?: number
}

/**
 * AI confirmation message (pre-execution)
 */
export interface AIConfirmationMessage extends StructuredMessage {
  type: MessageType.AI_CONFIRMATION
  summary: string
  impact: {
    tables?: string[]
    apis?: string[]
    auth?: string[]
    storage?: string[]
    policies?: string[]
  }
  confidence: number
  requiresUserConfirmation: boolean
}

/**
 * Clarification request message
 */
export interface ClarificationRequestMessage extends StructuredMessage {
  type: MessageType.CLARIFICATION_REQUEST
  question: string
  context?: string
  suggestions?: string[]
  missingInformation?: string[]
}

/**
 * Execution narration message (during execution)
 */
export interface ExecutionNarrationMessage extends StructuredMessage {
  type: MessageType.EXECUTION_NARRATION
  narrative: string
  progress?: number // 0-100
  currentStep?: string
}

/**
 * Execution success message (post-execution)
 */
export interface ExecutionSuccessMessage extends StructuredMessage {
  type: MessageType.EXECUTION_SUCCESS
  summary: string
  changes: Array<{
    type: 'table' | 'api' | 'auth' | 'storage' | 'policy'
    action: 'created' | 'modified' | 'deleted'
    target: string
  }>
  executionId: string
  canRollback: boolean
}

/**
 * Execution warning message
 */
export interface ExecutionWarningMessage extends StructuredMessage {
  type: MessageType.EXECUTION_WARNING
  warning: string
  severity: 'low' | 'medium' | 'high'
  actionRequired?: boolean
  suggestion?: string
}

/**
 * Rollback information message
 */
export interface RollbackInfoMessage extends StructuredMessage {
  type: MessageType.ROLLBACK_INFO
  description: string
  consequences: {
    tables?: string[]
    apis?: string[]
    capabilities?: string[]
  }
  executionId: string
  canRevert: boolean
}

/**
 * System information message
 */
export interface SystemInfoMessage extends StructuredMessage {
  type: MessageType.SYSTEM_INFO
  message: string
  level: 'info' | 'success' | 'warning' | 'error'
}

/**
 * Union type for all message types
 */
export type AnyStructuredMessage = 
  | UserPromptMessage
  | AIUnderstandingMessage
  | AIConfirmationMessage
  | ClarificationRequestMessage
  | ExecutionNarrationMessage
  | ExecutionSuccessMessage
  | ExecutionWarningMessage
  | RollbackInfoMessage
  | SystemInfoMessage

/**
 * Message factory helpers
 */
export const MessageFactory = {
  userPrompt(projectId: string, content: string): UserPromptMessage {
    return {
      id: generateMessageId(),
      type: MessageType.USER_PROMPT,
      timestamp: new Date().toISOString(),
      projectId,
      content,
      metadata: {
        characterCount: content.length,
        wordCount: content.split(/\s+/).length,
      },
      displayConfig: {
        icon: 'user',
        color: 'purple',
      },
    }
  },

  aiUnderstanding(
    projectId: string,
    interpretation: string,
    entities: string[],
    confidence?: number
  ): AIUnderstandingMessage {
    return {
      id: generateMessageId(),
      type: MessageType.AI_UNDERSTANDING,
      timestamp: new Date().toISOString(),
      projectId,
      interpretation,
      entities,
      confidence,
      displayConfig: {
        icon: 'sparkles',
        color: 'blue',
        collapsible: true,
        defaultExpanded: true,
      },
    }
  },

  aiConfirmation(
    projectId: string,
    summary: string,
    impact: AIConfirmationMessage['impact'],
    confidence: number
  ): AIConfirmationMessage {
    return {
      id: generateMessageId(),
      type: MessageType.AI_CONFIRMATION,
      timestamp: new Date().toISOString(),
      projectId,
      summary,
      impact,
      confidence,
      requiresUserConfirmation: confidence < 0.9,
      displayConfig: {
        icon: 'check-circle',
        color: 'green',
      },
    }
  },

  clarificationRequest(
    projectId: string,
    question: string,
    suggestions?: string[]
  ): ClarificationRequestMessage {
    return {
      id: generateMessageId(),
      type: MessageType.CLARIFICATION_REQUEST,
      timestamp: new Date().toISOString(),
      projectId,
      question,
      suggestions,
      displayConfig: {
        icon: 'question-mark-circle',
        color: 'yellow',
      },
    }
  },

  executionSuccess(
    projectId: string,
    summary: string,
    changes: ExecutionSuccessMessage['changes'],
    executionId: string
  ): ExecutionSuccessMessage {
    return {
      id: generateMessageId(),
      type: MessageType.EXECUTION_SUCCESS,
      timestamp: new Date().toISOString(),
      projectId,
      summary,
      changes,
      executionId,
      canRollback: true,
      displayConfig: {
        icon: 'check-circle',
        color: 'green',
        collapsible: true,
        defaultExpanded: false,
      },
    }
  },

  rollbackInfo(
    projectId: string,
    description: string,
    consequences: RollbackInfoMessage['consequences'],
    executionId: string
  ): RollbackInfoMessage {
    return {
      id: generateMessageId(),
      type: MessageType.ROLLBACK_INFO,
      timestamp: new Date().toISOString(),
      projectId,
      description,
      consequences,
      executionId,
      canRevert: true,
      displayConfig: {
        icon: 'arrow-path',
        color: 'red',
      },
    }
  },
}

// Helper function
function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Type guards for message discrimination
 */
export function isUserPrompt(msg: AnyStructuredMessage): msg is UserPromptMessage {
  return msg.type === MessageType.USER_PROMPT
}

export function isAIUnderstanding(msg: AnyStructuredMessage): msg is AIUnderstandingMessage {
  return msg.type === MessageType.AI_UNDERSTANDING
}

export function isExecutionSuccess(msg: AnyStructuredMessage): msg is ExecutionSuccessMessage {
  return msg.type === MessageType.EXECUTION_SUCCESS
}

export function isClarificationRequest(msg: AnyStructuredMessage): msg is ClarificationRequestMessage {
  return msg.type === MessageType.CLARIFICATION_REQUEST
}

export function isRollbackInfo(msg: AnyStructuredMessage): msg is RollbackInfoMessage {
  return msg.type === MessageType.ROLLBACK_INFO
}
