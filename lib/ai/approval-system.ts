import { prisma } from '@/lib/db'

/**
 * TRUST LAYER: Human-in-the-Loop Governance
 * 
 * This is what enterprises need to trust AI.
 * 
 * Features:
 * 1. Approval chains (two-person rule)
 * 2. Org-level AI policies
 * 3. Destructive action gates
 * 4. Production environment protection
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export type ActionRiskLevel = 'safe' | 'moderate' | 'destructive' | 'critical'

export interface ApprovalRequest {
  id: string
  projectId: string
  executionId: string
  requestedBy: string
  requestedByEmail: string
  action: string
  description: string
  riskLevel: ActionRiskLevel
  requiresApproval: boolean
  approvalReason: string
  
  // What will be executed
  plan: {
    steps: Array<{
      action: string
      description: string
      target: string
    }>
  }
  
  // Approval chain
  requiredApprovers: number // 1 or 2
  approvals: Array<{
    userId: string
    userEmail: string
    decision: 'approve' | 'reject'
    reason?: string
    timestamp: Date
  }>
  
  status: ApprovalStatus
  createdAt: Date
  expiresAt: Date
  
  // Policy that triggered approval
  policyId?: string
}

// Org-level AI policies
export interface AIPolicy {
  id: string
  workspaceId: string
  name: string
  description: string
  enabled: boolean
  
  // What actions does this policy govern?
  rules: Array<{
    actionType: string
    environment?: 'development' | 'staging' | 'production'
    requiresApproval: boolean
    requiredApprovers: number // 1 = single approval, 2 = two-person rule
    autoReject?: boolean
    allowedHours?: string // e.g., "09:00-17:00" (no prod changes at night)
  }>
  
  createdAt: Date
  updatedAt: Date
}

/**
 * Check if action requires approval based on org policies
 */
export async function checkApprovalRequired(
  projectId: string,
  userId: string,
  action: string,
  plan: any,
  environment: 'development' | 'staging' | 'production' = 'development'
): Promise<{
  required: boolean
  reason?: string
  requiredApprovers: number
  policyId?: string
  riskLevel: ActionRiskLevel
}> {
  // Get project details
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  })
  
  if (!project) {
    throw new Error('Project not found')
  }
  
  // Calculate risk level
  const riskLevel = calculateRiskLevel(action, plan, environment)
  
  // Get org policies
  // TODO: Fetch from database when WorkspaceAIPolicy model is added
  const defaultPolicies = getDefaultPolicies()
  
  // Check each policy
  for (const policy of defaultPolicies) {
    for (const rule of policy.rules) {
      if (rule.actionType === action || rule.actionType === '*') {
        // Check environment match
        if (rule.environment && rule.environment !== environment) continue
        
        // Auto-reject if policy says so
        if (rule.autoReject) {
          return {
            required: true,
            reason: `Action blocked by policy: ${policy.name}`,
            requiredApprovers: 999, // Effectively blocks
            policyId: policy.id,
            riskLevel,
          }
        }
        
        // Check time restrictions
        if (rule.allowedHours && environment === 'production') {
          const now = new Date()
          const hour = now.getHours()
          const [start, end] = rule.allowedHours.split('-').map(t => parseInt(t.split(':')[0]))
          
          if (hour < start || hour >= end) {
            return {
              required: true,
              reason: `Production changes only allowed ${rule.allowedHours}`,
              requiredApprovers: rule.requiredApprovers,
              policyId: policy.id,
              riskLevel,
            }
          }
        }
        
        // Requires approval
        if (rule.requiresApproval) {
          return {
            required: true,
            reason: `Policy "${policy.name}" requires approval for ${action}`,
            requiredApprovers: rule.requiredApprovers,
            policyId: policy.id,
            riskLevel,
          }
        }
      }
    }
  }
  
  // Check risk-based approval (even without explicit policy)
  if (riskLevel === 'critical' || riskLevel === 'destructive') {
    return {
      required: true,
      reason: `High-risk action (${riskLevel}) requires approval`,
      requiredApprovers: riskLevel === 'critical' ? 2 : 1,
      riskLevel,
    }
  }
  
  return {
    required: false,
    requiredApprovers: 0,
    riskLevel,
  }
}

// Actions that destroy or mutate existing data irreversibly
const CRITICAL_ACTIONS = new Set([
  'DROP_TABLE', 'TRUNCATE_TABLE', 'DELETE_ROWS', 'DROP_COLUMN',
  'ROLLBACK_DEPLOY',                    // reverts live deployment
  'ROLLBACK_TO_VERSION',                // reverts schema version
])

// Actions that modify schema but can be recovered with effort
const DESTRUCTIVE_ACTIONS = new Set([
  'RENAME_COLUMN', 'ADD_CONSTRAINT',    // can break existing clients
  'BLOCK_USER', 'RESET_PASSWORD',       // impacts live user sessions
  'REVOKE_KEY', 'ROTATE_KEY',           // breaks existing API consumers
  'REMOVE_PERMISSION', 'REMOVE_INTEGRATION_KEY',
  'DELETE_TRIGGER', 'DELETE_AI_FUNCTION', 'DELETE_CRON_JOB',
  'DELETE_FILE',
])

// Safe additive actions — never require approval in dev
const SAFE_ACTIONS = new Set([
  'CREATE_TABLE', 'ENSURE_TABLE', 'ADD_COLUMN', 'CREATE_INDEX',
  'GENERATE_API', 'CREATE_BUCKET', 'CREATE_KEY', 'LIST_TABLES',
  'LIST_APIS', 'LIST_KEYS', 'LIST_BUCKETS', 'LIST_FILES',
  'GET_METRICS', 'GET_ERRORS', 'GET_USAGE', 'INFO',
  'ENABLE_REALTIME',
  'ENABLE_AUTH', 'ADD_PROVIDER', 'LIST_USERS',
  'CREATE_TRIGGER', 'LIST_TRIGGERS',
  'SET_PERMISSION', 'LIST_PERMISSIONS',
  'CREATE_AI_FUNCTION', 'LIST_AI_FUNCTIONS', 'TOGGLE_AI_FUNCTION',
  'CREATE_CRON_JOB', 'LIST_CRON_JOBS',
  'STORE_INTEGRATION_KEY', 'LIST_INTEGRATION_KEYS',
  'GENERATE_FUNCTION', 'LIST_FUNCTIONS',
  'LIST_SCHEMA_VERSIONS',
])

/**
 * Calculate risk level of action based on actual executor action types.
 * Previously this only checked RUN_MIGRATION / MODIFY_ENV (which don't exist).
 * Now maps to real AIAction types from minimal-executor.ts.
 */
function calculateRiskLevel(
  action: string,
  plan: any,
  environment: string
): ActionRiskLevel {
  // Extract the most dangerous action from multi-step plans (IntentGraph)
  const allActions: string[] = [action]
  if (plan?.actions && Array.isArray(plan.actions)) {
    for (const a of plan.actions) {
      if (a.action) allActions.push(a.action)
    }
  }
  if (plan?.steps && Array.isArray(plan.steps)) {
    for (const s of plan.steps) {
      if (s.action) allActions.push(s.action)
    }
  }

  const hasCritical = allActions.some(a => CRITICAL_ACTIONS.has(a))
  const hasDestructive = allActions.some(a => DESTRUCTIVE_ACTIONS.has(a))

  // Production always escalates risk
  if (environment === 'production') {
    if (hasCritical) return 'critical'
    if (hasDestructive) return 'destructive'
    // Any schema mutation in production = destructive
    if (allActions.some(a => ['CREATE_TABLE', 'ADD_COLUMN', 'INSERT_DATA'].includes(a))) return 'destructive'
    return 'moderate'
  }

  // Development / staging
  if (hasCritical) return 'destructive'  // critical in prod, destructive in dev
  if (hasDestructive) return 'moderate'

  return 'safe'
}

/**
 * Create approval request
 */
export async function createApprovalRequest(
  projectId: string,
  executionId: string,
  userId: string,
  userEmail: string,
  action: string,
  description: string,
  plan: any,
  requiredApprovers: number,
  reason: string,
  riskLevel: ActionRiskLevel,
  policyId?: string
): Promise<ApprovalRequest> {
  const request: ApprovalRequest = {
    id: `approval-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    projectId,
    executionId,
    requestedBy: userId,
    requestedByEmail: userEmail,
    action,
    description,
    riskLevel,
    requiresApproval: true,
    approvalReason: reason,
    plan,
    requiredApprovers,
    approvals: [],
    status: 'pending',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    policyId,
  }
  
  // Store in audit log
  await prisma.auditLog.create({
    data: {
      projectId,
      userId,
      action: 'AI_APPROVAL_REQUESTED',
      type: 'ai_approval',
      details: JSON.stringify(request),
      timestamp: new Date(),
    },
  })
  
  console.log(`📋 Created approval request: ${request.id}`)
  console.log(`   Risk: ${riskLevel}, Approvers needed: ${requiredApprovers}`)
  
  return request
}

/**
 * Submit approval decision
 */
export async function submitApproval(
  approvalId: string,
  projectId: string,
  userId: string,
  userEmail: string,
  decision: 'approve' | 'reject',
  reason?: string
): Promise<{
  success: boolean
  finalStatus: ApprovalStatus
  canExecute: boolean
  message: string
}> {
  console.log(`✍️ Approval decision: ${decision} by ${userEmail} for project ${projectId}`)

  // Record approval in audit log
  await prisma.auditLog.create({
    data: {
      projectId,
      userId,
      action: `AI_APPROVAL_${decision.toUpperCase()}`,
      type: 'ai_approval',
      details: JSON.stringify({ approvalId, decision, reason }),
      timestamp: new Date(),
    },
  })
  
  if (decision === 'reject') {
    return {
      success: true,
      finalStatus: 'rejected',
      canExecute: false,
      message: `Execution rejected by ${userEmail}`,
    }
  }

  // Load the original approval request to know how many approvers are required
  const requestRecord = await prisma.auditLog.findFirst({
    where: {
      projectId,
      action: 'AI_APPROVAL_REQUESTED',
      type: 'ai_approval',
      details: { contains: approvalId },
    },
    orderBy: { timestamp: 'desc' },
  })

  let requiredApprovers = 1
  if (requestRecord) {
    try {
      const req = JSON.parse(requestRecord.details || '{}') as ApprovalRequest
      requiredApprovers = req.requiredApprovers ?? 1
    } catch { /* use default 1 */ }
  }

  // Count how many unique users have already approved (including this one, just recorded above)
  const approvalRecords = await prisma.auditLog.findMany({
    where: {
      projectId,
      action: 'AI_APPROVAL_APPROVE',
      type: 'ai_approval',
      details: { contains: approvalId },
    },
    select: { userId: true },
  })

  const uniqueApprovers = new Set(approvalRecords.map(r => r.userId))
  uniqueApprovers.add(userId) // include the current approver

  if (uniqueApprovers.size >= requiredApprovers) {
    return {
      success: true,
      finalStatus: 'approved',
      canExecute: true,
      message: `Execution approved (${uniqueApprovers.size}/${requiredApprovers} approvals received)`,
    }
  }

  const remaining = requiredApprovers - uniqueApprovers.size
  return {
    success: true,
    finalStatus: 'pending',
    canExecute: false,
    message: `Approval recorded. Waiting for ${remaining} more approver${remaining > 1 ? 's' : ''} (${uniqueApprovers.size}/${requiredApprovers} so far)`,
  }
}

/**
 * Default policies for organizations.
 * Rules only fire on the real executor action types (AIAction) — not phantom
 * actions like RUN_MIGRATION / MODIFY_ENV that don't exist in the codebase.
 */
function getDefaultPolicies(): AIPolicy[] {
  return [
    {
      id: 'policy-prod-destructive',
      workspaceId: 'default',
      name: 'Production Destructive Safety',
      description: 'Require two-person approval before dropping tables or rolling back in production',
      enabled: true,
      rules: [
        {
          actionType: 'DROP_TABLE',
          environment: 'production',
          requiresApproval: true,
          requiredApprovers: 2,
        },
        {
          actionType: 'ROLLBACK_DEPLOY',
          environment: 'production',
          requiresApproval: true,
          requiredApprovers: 2,
        },
        {
          actionType: 'ROLLBACK_TO_VERSION',
          environment: 'production',
          requiresApproval: true,
          requiredApprovers: 2,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'policy-prod-mutations',
      workspaceId: 'default',
      name: 'Production Mutation Gate',
      description: 'Any schema mutation in production requires at least one approval outside business hours',
      enabled: true,
      rules: [
        {
          actionType: '*',
          environment: 'production',
          requiresApproval: true,
          requiredApprovers: 1,
          allowedHours: '09:00-17:00',
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'policy-dev-destructive',
      workspaceId: 'default',
      name: 'Development Destructive Gate',
      description: 'Require single approval before dropping tables in development',
      enabled: true,
      rules: [
        {
          actionType: 'DROP_TABLE',
          requiresApproval: true,
          requiredApprovers: 1,
        },
        {
          actionType: 'REVOKE_KEY',
          requiresApproval: true,
          requiredApprovers: 1,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]
}

/**
 * Get pending approvals for a project from the audit log.
 * Pending approvals are audit log entries with action 'AI_APPROVAL_REQUESTED'
 * that have not yet been approved or rejected (no corresponding APPROVE/REJECT entry).
 */
export async function getPendingApprovals(
  userId: string,
  projectId?: string
): Promise<ApprovalRequest[]> {
  try {
    const [requestRecords, resolvedRecords] = await Promise.all([
      prisma.auditLog.findMany({
        where: {
          ...(projectId ? { projectId } : {}),
          action: 'AI_APPROVAL_REQUESTED',
          type: 'ai_approval',
        },
        orderBy: { timestamp: 'desc' },
        take: 50,
      }),
      prisma.auditLog.findMany({
        where: {
          ...(projectId ? { projectId } : {}),
          action: { in: ['AI_APPROVAL_APPROVE', 'AI_APPROVAL_REJECT'] },
          type: 'ai_approval',
        },
        select: { details: true },
      }),
    ])

    // Build set of already-resolved approval IDs
    const resolvedIds = new Set<string>()
    for (const r of resolvedRecords) {
      try {
        const d = JSON.parse(r.details || '{}')
        if (d.approvalId) resolvedIds.add(d.approvalId)
      } catch { /* ignore */ }
    }

    const now = new Date()
    return requestRecords.map(r => {
      try {
        return JSON.parse(r.details || '{}') as ApprovalRequest
      } catch {
        return null
      }
    }).filter((r): r is ApprovalRequest =>
      r !== null &&
      r.id != null &&
      !resolvedIds.has(r.id) &&
      r.status === 'pending' &&
      new Date(r.expiresAt) > now
    )
  } catch (err) {
    console.error('[ApprovalSystem] Failed to fetch pending approvals:', err)
    return []
  }
}
