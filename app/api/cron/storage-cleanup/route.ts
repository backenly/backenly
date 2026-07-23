/**
 * Storage Lifecycle Cleanup Cron Job
 * 
 * AUTOMATIC EXECUTION:
 * - Runs daily at 2:00 AM UTC
 * - No manual intervention required
 * - No UI access
 * 
 * Triggered by:
 * - Vercel Cron (production)
 * - Manual curl for testing
 * 
 * Auth: CRON_SECRET environment variable
 */

import { NextRequest, NextResponse } from 'next/server'
import { runLifecycleCleanup, getStorageHealth } from '@/lib/storage/storage-lifecycle'
import { getS3Client, getS3Config } from '@/lib/services/s3-config'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

/**
 * POST /api/cron/storage-cleanup
 * 
 * Automatic storage lifecycle cleanup
 * 
 * Security:
 * - Requires CRON_SECRET header
 * - Only accessible via cron or admin
 */
function verifyCronAuth(request: NextRequest): boolean {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function POST(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    
    console.log('[Storage Cron] Starting automatic lifecycle cleanup...')

    // Shared S3 client — region derived from endpoint (see s3-config.ts).
    const s3Client = getS3Client()
    const bucketName = getS3Config().bucket
    
    // Run cleanup
    const result = await runLifecycleCleanup(s3Client, bucketName, {
      softDeleteRetentionDays: 7,
      dryRun: false,
    })
    
    // Check health for all projects
    const projects = await prisma.project.findMany({
      select: { id: true, name: true },
    })
    
    const healthChecks = await Promise.all(
      projects.map(async (project) => {
        const health = await getStorageHealth(project.id)
        return {
          projectId: project.id,
          projectName: project.name,
          ...health,
        }
      })
    )
    
    // Alert on critical issues
    const criticalProjects = healthChecks.filter(
      h => h.quotaUsage > 90 || h.inconsistencies.length > 0
    )
    
    if (criticalProjects.length > 0) {
      console.warn('[Storage Cron] Critical storage issues detected:', criticalProjects)
      
      // TODO: Send alert notifications
      // - Email to admins
      // - Slack webhook
      // - Monitoring dashboard
    }
    
    console.log('[Storage Cron] Cleanup complete:', {
      ...result,
      projectsScanned: projects.length,
      criticalProjects: criticalProjects.length,
    })
    
    return NextResponse.json({
      success: true,
      cleanup: {
        deletedSoftDeletes: result.deletedSoftDeletes,
        deletedOrphans: result.deletedOrphans,
        deletedIncomplete: result.deletedIncomplete,
        totalBytesFreed: result.totalBytesFreed.toString(),
        errors: result.errors,
      },
      health: {
        projectsScanned: projects.length,
        criticalProjects: criticalProjects.length,
        issues: criticalProjects.map(p => ({
          project: p.projectName,
          quotaUsage: `${p.quotaUsage}%`,
          inconsistencies: p.inconsistencies,
        })),
      },
    })
  } catch (error: any) {
    console.error('[Storage Cron] Failed:', error)
    
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    )
  }
}

/**
 * GET /api/cron/storage-cleanup
 * 
 * Health check endpoint
 */
export async function GET(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    
    // Get health for all projects
    const projects = await prisma.project.findMany({
      select: { id: true, name: true, storageUsed: true },
    })
    
    const health = await Promise.all(
      projects.map(async (project) => ({
        projectId: project.id,
        projectName: project.name,
        storageUsed: project.storageUsed.toString(),
        ...(await getStorageHealth(project.id)),
      }))
    )
    
    return NextResponse.json({
      totalProjects: projects.length,
      projects: health,
    })
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}
