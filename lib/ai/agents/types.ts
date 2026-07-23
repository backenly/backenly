// lib/ai/agents/types.ts
/** Shared types for the Backenly multi-agent health framework. */

export type AgentType = 'security' | 'performance' | 'migration' | 'repair' | 'planner'

export interface AgentInput {
  projectId: string
  tables: string[]         // All table names in workspace
  schemaContext?: string   // DDL snippet for LLM context
  recentFindings?: Array<{ type: string; severity: string; details: Record<string, unknown> }>
}

export interface AgentFix {
  description: string
  sql?: string                    // Raw SQL to execute (for additive-only fixes)
  executorAction?: string         // AI executor action name (e.g. 'CREATE_INDEX')
  executorParams?: Record<string, unknown>
  reversible: boolean
  requiresApproval: boolean       // true = needs user OK, false = safe to auto-fix
}

export interface AgentFinding {
  id: string
  agentType: AgentType
  category: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  description: string
  location: string              // table name or 'api' or 'auth' etc.
  fix?: AgentFix
}

export interface AgentResult {
  agentType: AgentType
  durationMs: number
  findings: AgentFinding[]
  autoFixed: string[]           // titles of findings auto-fixed by this agent
  skipped: boolean              // true if agent determined nothing to check
}

export interface OrchestratorResult {
  projectId: string
  ranAt: string
  totalFindings: number
  criticalCount: number
  autoFixedCount: number
  pendingApprovalCount: number
  agentResults: AgentResult[]
  topFindings: AgentFinding[]   // Top 5 by severity
}

export interface Phase {
  name: string
  actions: AgentFinding[]
  canAutoRun: boolean
}

export interface PlannerOutput {
  executionPlan: Phase[]
  ctoBrief: string
  estimatedFixTime: string
}
