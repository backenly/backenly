/**
 * Automatic Archive Cleanup Cron Job
 * 
 * Deletes archived tables older than retention period (90 days default)
 * This is the ONLY place where we permanently delete data
 * 
 * PHILOSOPHY: Preserve data for 90 days, then cleanup automatically
 * Users never trigger deletion - it's system-level only
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { cleanupOldArchives } from '@/lib/rollback/non-destructive-restore'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

function verifyCronAuth(request: NextRequest): boolean {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return POST(request)
}

export async function POST(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    console.error('[Archive Cleanup] Unauthorized cron request')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {

    console.log('[Archive Cleanup] Starting automatic cleanup...')

    // Get all projects
    const projects = await prisma.project.findMany({
      select: { id: true, name: true },
    })

    console.log(`[Archive Cleanup] Found ${projects.length} projects`)

    let totalDeleted = 0
    let totalBytesFreed = 0
    const projectResults: Array<{
      projectId: string
      projectName: string
      deletedTables: number
      bytesFreed: number
    }> = []

    // Cleanup archives for each project
    for (const project of projects) {
      try {
        const result = await cleanupOldArchives(project.id, 90)

        if (result.deletedTables > 0) {
          console.log(
            `[Archive Cleanup] Project ${project.name}: Deleted ${result.deletedTables} archives (${formatBytes(result.bytesFreed)} freed)`
          )
        }

        totalDeleted += result.deletedTables
        totalBytesFreed += result.bytesFreed

        projectResults.push({
          projectId: project.id,
          projectName: project.name,
          deletedTables: result.deletedTables,
          bytesFreed: result.bytesFreed,
        })
      } catch (error: any) {
        console.error(`[Archive Cleanup] Failed for project ${project.id}:`, error)
      }
    }

    // Cleanup old PITR snapshots (>30 days)
    const snapshotCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const { count: snapshotsDeleted } = await prisma.pITRSnapshot.updateMany({
      where: {
        capturedAt: { lt: snapshotCutoff },
        canRestoreTo: true,
      },
      data: {
        canRestoreTo: false,
      },
    })

    console.log(`[Archive Cleanup] Invalidated ${snapshotsDeleted} old PITR snapshots`)

    console.log(
      `[Archive Cleanup] ✅ Complete. ${totalDeleted} archives deleted, ${formatBytes(totalBytesFreed)} freed`
    )

    return NextResponse.json({
      success: true,
      projectsScanned: projects.length,
      totalDeleted,
      totalBytesFreed,
      snapshotsInvalidated: snapshotsDeleted,
      projectResults: projectResults.filter((r) => r.deletedTables > 0),
      message: `Cleaned up ${totalDeleted} archives (90+ days old) from ${projects.length} projects`,
    })
  } catch (error: any) {
    console.error('[Archive Cleanup] Failed:', error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Cleanup failed',
      },
      { status: 500 }
    )
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}
