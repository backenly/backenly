export interface CanonicalIntent {
  intent_type: IntentType
  domain: Domain
  action: Action
  feature?: string
  target?: string
  reason?: string
  constraints: Record<string, any>
  source_text: string
  timestamp: string
  confidence: number // 0-1, how confident we are in the parsing
  isOverride?: boolean
  status: IntentStatus // CRITICAL: Conversation → Commitment lifecycle
}

/**
 * Intent Lifecycle States
 * 
 * DRAFT: AI is clarifying, not ready for execution
 * READY: AI is confident, awaiting user confirmation
 * COMMITTED: User explicitly confirmed, ready to execute
 * EXECUTED: Execution completed
 */
export type IntentStatus = 'DRAFT' | 'READY' | 'COMMITTED' | 'EXECUTED'

export type IntentType =
  | 'FEATURE_ADD'
  | 'FEATURE_REMOVE'
  | 'FEATURE_MODIFY'
  | 'DATA_MODEL_ADD'
  | 'DATA_MODEL_REMOVE'
  | 'DATA_MODEL_MODIFY'
  | 'ACCESS_CONTROL'
  | 'DEPLOYMENT'
  | 'INTEGRATION'
  | 'QUERY'
  | 'ROLLBACK'
  | 'RESTORE'
  | 'EXPORT'
  | 'INFRASTRUCTURE'
  | 'FRONTEND_CONNECTION'

export type Domain =
  | 'AUTH'
  | 'STORAGE'
  | 'DATABASE'
  | 'API'
  | 'DEPLOYMENT'
  | 'INTEGRATION'
  | 'MONITORING'
  | 'SYSTEM'

export type Action =
  | 'ENABLE'
  | 'DISABLE'
  | 'CREATE'
  | 'DELETE'
  | 'UPDATE'
  | 'RESTRICT'
  | 'ALLOW'
  | 'DEPLOY'
  | 'UNDO'
  | 'CONNECT'
  | 'DISCONNECT'
