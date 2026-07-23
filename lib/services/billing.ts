/**
 * Basic Billing Service
 * 
 * Simple subscription-based billing tracking.
 * Tracks basic usage for subscription limits.
 */

import { prisma } from '@/lib/db'

export interface Subscription {
  projectId: string
  plan: 'free' | 'starter' | 'pro' | 'enterprise'
  status: 'active' | 'cancelled' | 'past_due'
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAtPeriodEnd?: boolean
}

export interface BasicUsage {
  projectId: string
  apiRequests: number
  storageBytes: number
  databaseQueries: number
  lastUpdated: Date
}

/**
 * Get subscription for a project
 */
export async function getSubscription(projectId: string): Promise<Subscription | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      // In production, add subscription fields to Project model
      // For now, return default
    },
  })

  if (!project) {
    return null
  }

  // Default to free plan
  return {
    projectId: project.id,
    plan: 'free',
    status: 'active',
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
  }
}

/**
 * Get basic usage metrics
 */
export async function getBasicUsage(projectId: string): Promise<BasicUsage> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      apiRequests: true,
      storageUsed: true,
    },
  })

  return {
    projectId,
    apiRequests: project?.apiRequests || 0,
    storageBytes: Number(project?.storageUsed || 0),
    databaseQueries: 0, // Would track separately if needed
    lastUpdated: new Date(),
  }
}

/**
 * Update subscription plan
 */
export async function updateSubscription(
  projectId: string,
  plan: Subscription['plan']
): Promise<Subscription> {
  // In production, integrate with Stripe or similar
  // For now, just return updated subscription
  return {
    projectId,
    plan,
    status: 'active',
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  }
}

/**
 * Get comprehensive billing usage for Settings > Billing tab
 */
export interface BillingUsageData {
  apiRequests: {
    count: number
    changePercent: number
  }
  storage: {
    used: bigint
    limit: bigint
  }
  aiCalls: {
    count: number
    limit: number
    cost: number
  }
  monthlyEstimate: number
}

export async function getBillingUsage(projectId: string): Promise<BillingUsageData> {
  // Fetch project data
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      apiRequests: true,
      storageUsed: true,
      storageLimit: true,
    },
  })

  if (!project) {
    throw new Error('Project not found')
  }

  // Get AI usage count
  const aiUsageCount = await prisma.aiUsage.count({
    where: { projectId },
  })

  // Calculate AI cost (simplified: $0.002 per call)
  const aiCost = aiUsageCount * 0.002

  // Calculate monthly estimate based on current usage
  // Free plan = $0, could add paid plan logic here
  const monthlyEstimate = 0 // Free plan

  return {
    apiRequests: {
      count: project.apiRequests,
      changePercent: 0, // Would calculate from historical data
    },
    storage: {
      used: project.storageUsed,
      limit: project.storageLimit,
    },
    aiCalls: {
      count: aiUsageCount,
      limit: 10000, // Free plan limit
      cost: aiCost,
    },
    monthlyEstimate,
  }
}
