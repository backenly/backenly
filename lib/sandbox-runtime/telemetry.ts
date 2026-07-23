/**
 * PHASE 6: Telemetry + Intelligence Hooks
 * 
 * Tracks sandbox usage, deployment conversions, and failure patterns.
 * Feeds data for future autonomous guidance features.
 */

import { prisma } from '@/lib/db'

export interface SandboxTelemetryEvent {
  projectId: string
  userId: string
  eventType:
    | 'sandbox_started'
    | 'sandbox_stopped'
    | 'api_test_success'
    | 'api_test_failure'
    | 'deploy_from_sandbox'
    | 'sandbox_crash'
  timestamp: Date
  metadata?: Record<string, any>
}

export interface SandboxMetrics {
  projectId: string
  totalSandboxStarts: number
  totalApiTests: number
  successfulTests: number
  failedTests: number
  deployConversions: number
  averageSessionDuration: number
  crashCount: number
}

/**
 * Track a sandbox telemetry event
 */
export async function trackSandboxEvent(event: Omit<SandboxTelemetryEvent, 'timestamp'>): Promise<void> {
  try {
    console.log(`[Sandbox Telemetry] ${event.eventType} - Project: ${event.projectId}`)

    // Store event in database for analytics
    await prisma.auditLog.create({
      data: {
        action: `sandbox.${event.eventType}`,
        userId: event.userId,
        projectId: event.projectId,
        details: JSON.stringify(event.metadata || {}),
        type: 'sandbox',
        userEmail: '',
      },
    })
  } catch (error) {
    console.error('[Sandbox Telemetry] Failed to track event:', error)
    // Don't throw - telemetry failures shouldn't break functionality
  }
}

/**
 * Get sandbox metrics for a project
 */
export async function getSandboxMetrics(projectId: string): Promise<SandboxMetrics> {
  try {
    const events = await prisma.auditLog.findMany({
      where: {
        projectId,
        action: {
          startsWith: 'sandbox.',
        },
      },
      orderBy: {
        timestamp: 'asc',
      },
    })

    const metrics: SandboxMetrics = {
      projectId,
      totalSandboxStarts: 0,
      totalApiTests: 0,
      successfulTests: 0,
      failedTests: 0,
      deployConversions: 0,
      averageSessionDuration: 0,
      crashCount: 0,
    }

    const sessionStarts: Date[] = []
    const sessionEnds: Date[] = []

    for (const event of events) {
      const action = event.action.replace('sandbox.', '')

      switch (action) {
        case 'sandbox_started':
          metrics.totalSandboxStarts++
          sessionStarts.push(event.timestamp)
          break
        case 'sandbox_stopped':
          sessionEnds.push(event.timestamp)
          break
        case 'api_test_success':
          metrics.totalApiTests++
          metrics.successfulTests++
          break
        case 'api_test_failure':
          metrics.totalApiTests++
          metrics.failedTests++
          break
        case 'deploy_from_sandbox':
          metrics.deployConversions++
          break
        case 'sandbox_crash':
          metrics.crashCount++
          break
      }
    }

    // Calculate average session duration
    if (sessionStarts.length > 0 && sessionEnds.length > 0) {
      let totalDuration = 0
      const pairs = Math.min(sessionStarts.length, sessionEnds.length)

      for (let i = 0; i < pairs; i++) {
        const duration = sessionEnds[i].getTime() - sessionStarts[i].getTime()
        totalDuration += duration
      }

      metrics.averageSessionDuration = totalDuration / pairs / 1000 // Convert to seconds
    }

    return metrics
  } catch (error) {
    console.error('[Sandbox Telemetry] Failed to get metrics:', error)
    return {
      projectId,
      totalSandboxStarts: 0,
      totalApiTests: 0,
      successfulTests: 0,
      failedTests: 0,
      deployConversions: 0,
      averageSessionDuration: 0,
      crashCount: 0,
    }
  }
}

/**
 * Get sandbox usage insights for intelligence/guidance features
 */
export async function getSandboxInsights(userId: string): Promise<{
  totalProjects: number
  averageTestsBeforeDeploy: number
  topFailureReasons: Array<{ reason: string; count: number }>
  sandboxPreference: number // 0-1 score of how much they use sandbox vs deploy directly
}> {
  try {
    const userProjects = await prisma.project.findMany({
      where: { userId },
      select: { id: true },
    })

    const projectIds = userProjects.map((p) => p.id)

    if (projectIds.length === 0) {
      return {
        totalProjects: 0,
        averageTestsBeforeDeploy: 0,
        topFailureReasons: [],
        sandboxPreference: 0,
      }
    }

    const allEvents = await prisma.auditLog.findMany({
      where: {
        userId,
        projectId: { in: projectIds },
        action: { startsWith: 'sandbox.' },
      },
    })

    // Calculate metrics
    const sandboxStarts = allEvents.filter((e) => e.action === 'sandbox.sandbox_started').length
    const deployments = allEvents.filter((e) => e.action === 'sandbox.deploy_from_sandbox').length
    const totalTests = allEvents.filter(
      (e) => e.action === 'sandbox.api_test_success' || e.action === 'sandbox.api_test_failure'
    ).length

    const averageTestsBeforeDeploy = deployments > 0 ? totalTests / deployments : 0

    // Extract failure reasons
    const failureReasons: Record<string, number> = {}
    allEvents
      .filter((e) => e.action === 'sandbox.api_test_failure')
      .forEach((e) => {
        const reason = (e.details as any)?.error || 'Unknown'
        failureReasons[reason] = (failureReasons[reason] || 0) + 1
      })

    const topFailureReasons = Object.entries(failureReasons)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    // Calculate sandbox preference (sandbox usage vs direct deploy)
    const directDeploys = await prisma.auditLog.count({
      where: {
        userId,
        projectId: { in: projectIds },
        action: 'deploy',
        NOT: { action: { startsWith: 'sandbox.' } },
      },
    })

    const totalDeploys = deployments + directDeploys
    const sandboxPreference = totalDeploys > 0 ? deployments / totalDeploys : 0

    return {
      totalProjects: projectIds.length,
      averageTestsBeforeDeploy: Math.round(averageTestsBeforeDeploy),
      topFailureReasons,
      sandboxPreference,
    }
  } catch (error) {
    console.error('[Sandbox Telemetry] Failed to get insights:', error)
    return {
      totalProjects: 0,
      averageTestsBeforeDeploy: 0,
      topFailureReasons: [],
      sandboxPreference: 0,
    }
  }
}
