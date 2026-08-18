export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db'

/**
 * GET /api/projects/[projectId]/changes
 * 
 * Returns timeline of changes for a project
 * Used by the "See what changed" panel on the main screen
 */
export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  const params = await props.params
  return withProjectValidation(request, async (validated) => {
    const { projectId } = validated

    try {
      // Get intent logs (new system) - these support rollback
      // Include ALL successful intents
      const intentLogs = await prisma.intentLog.findMany({
        where: {
          projectId,
          success: true, // Only show successful intents
        },
        orderBy: {
          timestamp: 'desc',
        },
        take: 50,
      })
      
      console.log(`[Changes API] Found ${intentLogs.length} intent logs for project ${projectId}`)

      // Get audit logs (legacy system) - for older changes
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          projectId,
          type: {
            in: ['ai_execution', 'ai_journal'],
          },
        },
        orderBy: {
          timestamp: 'desc',
        },
        take: 50,
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

      // Transform intent logs (support rollback)
      const intentChanges = intentLogs.map((log) => {
        let message = 'Backend updated'
        let details: string[] = []

        try {
          const changes = log.changes as any
          console.log(`[Changes API] Processing log ${log.id}, changes:`, JSON.stringify(changes).substring(0, 200))
          
          if (Array.isArray(changes)) {
            // Count UNIQUE items by type and target
            const uniqueTables = new Set<string>()
            const uniqueApis = new Set<string>()
            const uniqueStorage = new Set<string>()
            const uniqueCapabilities = new Set<string>()
            const uniqueColumns = new Set<string>()
            
            changes.forEach((c: any) => {
              if (c.type === 'table' && c.target) uniqueTables.add(c.target)
              if (c.type === 'api' && c.target) uniqueApis.add(c.target)
              if (c.type === 'storage' && c.target) uniqueStorage.add(c.target)
              if (c.type === 'capability' && c.target) uniqueCapabilities.add(c.target)
              if (c.type === 'column' && c.target) uniqueColumns.add(c.target)
            })

            // Build factual summary from UNIQUE counts
            const parts: string[] = []
            if (uniqueTables.size > 0) parts.push(`${uniqueTables.size} table${uniqueTables.size > 1 ? 's' : ''} created`)
            if (uniqueApis.size > 0) parts.push(`${uniqueApis.size} API${uniqueApis.size > 1 ? 's' : ''} created`)
            if (uniqueStorage.size > 0) parts.push(`${uniqueStorage.size} storage bucket${uniqueStorage.size > 1 ? 's' : ''} created`)
            if (uniqueCapabilities.size > 0) parts.push(`${uniqueCapabilities.size} capability${uniqueCapabilities.size > 1 ? 'ies' : 'y'} enabled`)
            if (uniqueColumns.size > 0) parts.push(`${uniqueColumns.size} field${uniqueColumns.size > 1 ? 's' : ''} added`)
            
            if (parts.length > 0) {
              message = parts.join(', ')
            }

            // Build DEDUPLICATED details list
            uniqueTables.forEach(name => details.push(`Table: ${name}`))
            uniqueApis.forEach(name => details.push(`API: ${name}`))
            uniqueStorage.forEach(name => details.push(`Storage: ${name}`))
            uniqueCapabilities.forEach(name => details.push(`Enabled: ${name}`))
            uniqueColumns.forEach(name => details.push(`Field: ${name}`))
          } else if (log.intent) {
            // Use original intent text if no structured changes
            message = log.intent.substring(0, 100)
          }
        } catch (err) {
          console.error('[Changes API] Failed to parse intent log:', err)
        }

        return {
          id: log.id,
          intentId: log.id, // IntentLog.id IS the intentId for rollback
          message,
          details,
          createdAt: log.timestamp.toISOString(),
          canRestore: true, // Intent logs support rollback
          user: null, // Intent logs don't include user info yet
        }
      })

      // Transform audit logs (legacy - no rollback support)
      const auditChanges = auditLogs.map((log) => {
        let message = 'Backend updated'
        let details: string[] = []

        try {
          const metadata = log.metadata as any
          
          // Extract structured changes if available
          if (metadata?.changes && Array.isArray(metadata.changes)) {
            // Count UNIQUE items by type and target
            const uniqueTables = new Set<string>()
            const uniqueApis = new Set<string>()
            const uniqueStorage = new Set<string>()
            const uniqueCapabilities = new Set<string>()
            const uniqueColumns = new Set<string>()
            
            metadata.changes.forEach((c: any) => {
              if (c.type === 'table' && c.target) uniqueTables.add(c.target)
              if (c.type === 'api' && c.target) uniqueApis.add(c.target)
              if (c.type === 'storage' && c.target) uniqueStorage.add(c.target)
              if (c.type === 'capability' && c.target) uniqueCapabilities.add(c.target)
              if (c.type === 'column' && c.target) uniqueColumns.add(c.target)
            })

            // Build factual summary from UNIQUE counts
            const parts: string[] = []
            if (uniqueTables.size > 0) parts.push(`${uniqueTables.size} table${uniqueTables.size > 1 ? 's' : ''} created`)
            if (uniqueApis.size > 0) parts.push(`${uniqueApis.size} API${uniqueApis.size > 1 ? 's' : ''} created`)
            if (uniqueColumns.size > 0) parts.push(`${uniqueColumns.size} field${uniqueColumns.size > 1 ? 's' : ''} added`)
            if (uniqueStorage.size > 0) parts.push(`${uniqueStorage.size} storage bucket${uniqueStorage.size > 1 ? 's' : ''} created`)
            if (uniqueCapabilities.size > 0) parts.push(`${uniqueCapabilities.size} capability${uniqueCapabilities.size > 1 ? 'ies' : 'y'} enabled`)
            
            if (parts.length > 0) {
              message = parts.join(', ')
            }

            // Build DEDUPLICATED details list
            uniqueTables.forEach(name => details.push(`Table: ${name}`))
            uniqueApis.forEach(name => details.push(`API: ${name}`))
            uniqueStorage.forEach(name => details.push(`Storage: ${name}`))
            uniqueCapabilities.forEach(name => details.push(`Enabled: ${name}`))
            uniqueColumns.forEach(name => details.push(`Field: ${name}`))
          } else if (metadata?.intent?.source_text) {
            // Fallback to original intent text
            message = metadata.intent.source_text.substring(0, 100)
          } else if (log.action) {
            message = log.action.replace(/_/g, ' ').toLowerCase()
          }
        } catch (err) {
          console.error('[Changes API] Failed to parse audit log:', err)
        }

        return {
          id: log.id,
          message,
          details,
          createdAt: log.timestamp.toISOString(),
          canRestore: false, // Audit logs don't support rollback
          user: log.user
            ? {
                email: log.user.email,
                name: log.user.name,
              }
            : null,
        }
      })

      // Combine and sort by timestamp (newest first)
      // Intent logs get priority over audit logs for same/similar timestamps
      const allChanges = [...intentChanges, ...auditChanges].sort(
        (a, b) => {
          const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          // If timestamps are within 1 second, prioritize intent logs (canRestore=true)
          if (Math.abs(timeDiff) < 1000) {
            if (a.canRestore && !b.canRestore) return -1
            if (!a.canRestore && b.canRestore) return 1
          }
          return timeDiff
        }
      )

      const changes = allChanges.slice(0, 50) // Limit to 50 most recent

      return NextResponse.json({
        success: true,
        changes,
        total: changes.length,
      })
    } catch (error) {
      console.error('[Changes API] Failed to fetch changes:', error)
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to load changes',
          changes: [],
          total: 0,
        },
        { status: 500 }
      )
    }
  })
}
