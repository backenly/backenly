export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db'

/**
 * TRUST LAYER: Execution Timeline & Social Proof
 * 
 * This builds emotional trust by showing:
 * "Nothing happened behind my back"
 * 
 * GET /api/ai/timeline?projectId=xxx - Get execution history
 */

export async function GET(request: NextRequest) {
  return withProjectValidation(request, async (validated) => {
    const { projectId } = validated
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '50')
    const offset = parseInt(searchParams.get('offset') || '0')

    // Get all AI-related audit logs
    const logs = await prisma.auditLog.findMany({
      where: {
        projectId,
        type: {
          in: ['ai_execution', 'ai_rollback', 'ai_approval', 'ai_learning', 'ai_journal'],
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: limit,
      skip: offset,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })

    // Transform into timeline events
    const timeline = logs.map(log => {
      const details = log.details ? JSON.parse(log.details) : {}
      
      return {
        id: log.id,
        type: mapActionToType(log.action),
        action: log.action,
        timestamp: log.timestamp,
        user: log.user ? {
          email: log.user.email,
          name: log.user.name || log.user.email?.split('@')[0],
        } : null,
        
        // Human-readable description
        description: generateDescription(log.action, details),
        
        // What changed
        changes: {
          filesCreated: details.filesCreated || [],
          filesModified: details.filesModified || [],
          commandsRun: details.commandsRun || [],
        },
        
        // Risk level
        riskLevel: details.riskLevel || 'unknown',
        
        // Status
        status: details.status || getStatusFromAction(log.action),
        
        // Approval info
        approval: details.approvalId ? {
          approvalId: details.approvalId,
          requiredApprovers: details.requiredApprovers,
          status: details.approvalStatus,
        } : null,
        
        // Rollback info
        canRollback: log.action === 'AI_EXECUTION_JOURNAL' && details.status === 'completed',
        journalId: details.id || details.executionId,
      }
    })

    // Get stats
    const stats = await getTimelineStats(projectId)

    return NextResponse.json({
      timeline,
      stats,
      pagination: {
        limit,
        offset,
        total: timeline.length,
        hasMore: timeline.length === limit,
      },
    })
  })
}

/**
 * Map action to timeline type
 */
function mapActionToType(action: string): string {
  if (action.includes('EXECUTION')) return 'execution'
  if (action.includes('ROLLBACK')) return 'rollback'
  if (action.includes('APPROVAL')) return 'approval'
  if (action.includes('LEARNING')) return 'learning'
  return 'other'
}

/**
 * Generate human-readable description
 */
function generateDescription(action: string, details: any): string {
  switch (action) {
    case 'AI_EXECUTION_JOURNAL':
      return `AI executed: ${details.planDescription || 'Unknown plan'}`
    
    case 'AI_EXECUTION_ROLLBACK':
      return `Rolled back execution (${details.rolledBack} steps undone)`
    
    case 'AI_APPROVAL_REQUESTED':
      return `Requested approval for: ${details.description || 'action'}`
    
    case 'AI_APPROVAL_APPROVE':
      return `Approved execution`
    
    case 'AI_APPROVAL_REJECT':
      return `Rejected execution: ${details.reason || 'No reason given'}`
    
    case 'AI_LEARNING':
      return `AI learned from ${details.decision} action`
    
    default:
      return action
  }
}

/**
 * Get status from action
 */
function getStatusFromAction(action: string): string {
  if (action.includes('APPROVE')) return 'approved'
  if (action.includes('REJECT')) return 'rejected'
  if (action.includes('ROLLBACK')) return 'rolled_back'
  if (action.includes('EXECUTION')) return 'executed'
  return 'completed'
}

/**
 * Get timeline statistics
 */
async function getTimelineStats(projectId: string) {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const [total, last24hCount, last7dCount, rollbackCount, approvalCount] = await Promise.all([
    prisma.auditLog.count({
      where: {
        projectId,
        type: { in: ['ai_execution', 'ai_journal'] },
      },
    }),
    prisma.auditLog.count({
      where: {
        projectId,
        type: { in: ['ai_execution', 'ai_journal'] },
        timestamp: { gte: last24h },
      },
    }),
    prisma.auditLog.count({
      where: {
        projectId,
        type: { in: ['ai_execution', 'ai_journal'] },
        timestamp: { gte: last7d },
      },
    }),
    prisma.auditLog.count({
      where: {
        projectId,
        action: 'AI_EXECUTION_ROLLBACK',
      },
    }),
    prisma.auditLog.count({
      where: {
        projectId,
        type: 'ai_approval',
      },
    }),
  ])

  return {
    totalExecutions: total,
    last24Hours: last24hCount,
    last7Days: last7dCount,
    rollbacks: rollbackCount,
    approvals: approvalCount,
    successRate: total > 0 ? ((total - rollbackCount) / total * 100).toFixed(1) : '100.0',
  }
}
