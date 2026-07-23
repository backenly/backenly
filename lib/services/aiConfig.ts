import { prisma } from '@/lib/db'

export interface AiConfigData {
  model: string
  temperature: number
  maxTokens: number
  systemPrompt?: string
  config?: Record<string, any>
}

/**
 * Get AI configuration for a project, creating default if it doesn't exist
 */
export async function getAiConfiguration(projectId: string): Promise<AiConfigData> {
  let config = await prisma.aiConfiguration.findUnique({
    where: { projectId },
  })

  if (!config) {
    // Create default configuration
    config = await prisma.aiConfiguration.create({
      data: {
        projectId,
        model: 'gpt-4o-mini',
        temperature: 0.7,
        maxTokens: 2000,
        systemPrompt: 'You are a helpful backend development assistant.',
        config: {
          maxRetries: 3,
          timeout: 30000,
        },
      },
    })
  }

  return {
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    systemPrompt: config.systemPrompt || undefined,
    config: config.config as Record<string, any> | undefined,
  }
}

/**
 * Update AI configuration for a project
 */
export async function updateAiConfiguration(
  projectId: string,
  data: Partial<AiConfigData>
): Promise<AiConfigData> {
  const existing = await prisma.aiConfiguration.findUnique({
    where: { projectId },
  })

  if (existing) {
    const updated = await prisma.aiConfiguration.update({
      where: { projectId },
      data: {
        model: data.model,
        temperature: data.temperature,
        maxTokens: data.maxTokens,
        systemPrompt: data.systemPrompt,
        config: data.config,
      },
    })

    return {
      model: updated.model,
      temperature: updated.temperature,
      maxTokens: updated.maxTokens,
      systemPrompt: updated.systemPrompt || undefined,
      config: updated.config as Record<string, any> | undefined,
    }
  } else {
    const created = await prisma.aiConfiguration.create({
      data: {
        projectId,
        model: data.model || 'gpt-4o-mini',
        temperature: data.temperature ?? 0.7,
        maxTokens: data.maxTokens ?? 2000,
        systemPrompt: data.systemPrompt,
        config: data.config,
      },
    })

    return {
      model: created.model,
      temperature: created.temperature,
      maxTokens: created.maxTokens,
      systemPrompt: created.systemPrompt || undefined,
      config: created.config as Record<string, any> | undefined,
    }
  }
}

/**
 * Track AI usage for billing
 */
export async function trackAiUsage(
  projectId: string | null,
  data: {
    model: string
    promptTokens: number
    completionTokens: number
    totalTokens: number
    endpoint?: string
    metadata?: Record<string, any>
  }
): Promise<void> {
  // Calculate cost based on model pricing (approximate)
  // GPT-4: $0.03/1K input tokens, $0.06/1K output tokens
  // GPT-4 Turbo: $0.01/1K input, $0.03/1K output
  // GPT-3.5 Turbo: $0.0015/1K input, $0.002/1K output
  // Claude 3 Opus: $0.015/1K input, $0.075/1K output
  // Claude 3 Sonnet: $0.003/1K input, $0.015/1K output
  let cost: number | null = null

  if (data.model.includes('gpt-4.1-mini')) {
    cost = (data.promptTokens / 1000) * 0.0004 + (data.completionTokens / 1000) * 0.0016
  } else if (data.model.includes('gpt-4.1')) {
    cost = (data.promptTokens / 1000) * 0.002 + (data.completionTokens / 1000) * 0.008
  } else if (data.model.includes('gpt-4-turbo')) {
    cost = (data.promptTokens / 1000) * 0.01 + (data.completionTokens / 1000) * 0.03
  } else if (data.model.includes('gpt-4o')) {
    cost = (data.promptTokens / 1000) * 0.005 + (data.completionTokens / 1000) * 0.015
  } else if (data.model.includes('claude-3-opus')) {
    cost = (data.promptTokens / 1000) * 0.015 + (data.completionTokens / 1000) * 0.075
  } else if (data.model.includes('claude-3-sonnet')) {
    cost = (data.promptTokens / 1000) * 0.003 + (data.completionTokens / 1000) * 0.015
  }

  await prisma.aiUsage.create({
    data: {
      projectId: projectId || undefined,
      model: data.model,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      totalTokens: data.totalTokens,
      cost,
      endpoint: data.endpoint,
      metadata: data.metadata,
    },
  })
}

/**
 * Get AI usage statistics for a project
 */
export async function getAiUsageStats(projectId: string, period: 'month' | 'all' = 'month') {
  const now = new Date()
  const startDate = period === 'month' 
    ? new Date(now.getFullYear(), now.getMonth(), 1)
    : new Date(0)

  const usage = await prisma.aiUsage.findMany({
    where: {
      projectId,
      createdAt: {
        gte: startDate,
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  const totalCalls = usage.length
  const totalTokens = usage.reduce((sum, u) => sum + u.totalTokens, 0)
  const totalCost = usage.reduce((sum, u) => sum + (u.cost || 0), 0)

  // Group by model
  const byModel = usage.reduce((acc, u) => {
    if (!acc[u.model]) {
      acc[u.model] = { calls: 0, tokens: 0, cost: 0 }
    }
    acc[u.model].calls += 1
    acc[u.model].tokens += u.totalTokens
    acc[u.model].cost += u.cost || 0
    return acc
  }, {} as Record<string, { calls: number; tokens: number; cost: number }>)

  return {
    totalCalls,
    totalTokens,
    totalCost,
    byModel,
    usage: usage.slice(0, 100), // Last 100 calls
  }
}

