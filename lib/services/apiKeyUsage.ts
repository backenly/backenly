import { prisma } from '@/lib/db/postgres'

/**
 * Track API key usage for analytics
 */
export async function trackApiKeyUsage(
  apiKeyId: string,
  endpoint: string,
  method: string,
  statusCode: number = 200,
  responseTime?: number,
  metadata?: any
): Promise<void> {
  try {
    await prisma.apiKeyUsage.create({
      data: {
        apiKeyId,
        endpoint,
        method,
        statusCode,
        responseTime,
        metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : null,
      },
    })
  } catch (error) {
    // Don't fail the request if tracking fails
    console.error('Failed to track API key usage:', error)
  }
}

/**
 * Get API key usage statistics
 */
export async function getApiKeyUsageStats(
  apiKeyId: string,
  startDate?: Date,
  endDate?: Date
): Promise<{
  totalRequests: number
  requestsByEndpoint: Record<string, number>
  requestsByMethod: Record<string, number>
  requestsByStatus: Record<number, number>
  averageResponseTime: number
  peakRequestsPerHour: number
}> {
  const where: any = { apiKeyId }
  
  if (startDate || endDate) {
    where.timestamp = {}
    if (startDate) where.timestamp.gte = startDate
    if (endDate) where.timestamp.lte = endDate
  }
  
  const logs = await prisma.apiKeyUsage.findMany({
    where,
    orderBy: { timestamp: 'desc' },
  })
  
  const totalRequests = logs.length
  const requestsByEndpoint: Record<string, number> = {}
  const requestsByMethod: Record<string, number> = {}
  const requestsByStatus: Record<number, number> = {}
  let totalResponseTime = 0
  let responseTimeCount = 0
  
  for (const log of logs) {
    requestsByEndpoint[log.endpoint] = (requestsByEndpoint[log.endpoint] || 0) + 1
    requestsByMethod[log.method] = (requestsByMethod[log.method] || 0) + 1
    requestsByStatus[log.statusCode] = (requestsByStatus[log.statusCode] || 0) + 1
    
    if (log.responseTime) {
      totalResponseTime += log.responseTime
      responseTimeCount++
    }
  }
  
  // Calculate peak requests per hour
  const hourlyCounts: Record<string, number> = {}
  for (const log of logs) {
    const hour = log.timestamp.toISOString().substring(0, 13) // YYYY-MM-DDTHH
    hourlyCounts[hour] = (hourlyCounts[hour] || 0) + 1
  }
  const peakRequestsPerHour = Math.max(...Object.values(hourlyCounts), 0)
  
  return {
    totalRequests,
    requestsByEndpoint,
    requestsByMethod,
    requestsByStatus,
    averageResponseTime: responseTimeCount > 0 ? totalResponseTime / responseTimeCount : 0,
    peakRequestsPerHour,
  }
}

/**
 * Get usage stats for all API keys of a user
 */
export async function getUserApiKeyUsageStats(userId: string): Promise<Record<string, any>> {
  const apiKeys = await prisma.apiKey.findMany({
    where: { userId },
    select: { id: true, name: true },
  })
  
  const stats: Record<string, any> = {}
  
  for (const key of apiKeys) {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    
    const [stats24h, stats7d] = await Promise.all([
      getApiKeyUsageStats(key.id, last24h),
      getApiKeyUsageStats(key.id, last7d),
    ])
    
    stats[key.id] = {
      name: key.name,
      last24h: stats24h.totalRequests,
      last7d: stats7d.totalRequests,
      ...stats24h,
    }
  }
  
  return stats
}

