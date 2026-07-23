const API_BASE = '/api/settings'

export interface AiConfiguration {
  model: string
  temperature: number
  maxTokens: number
  systemPrompt?: string
  config?: Record<string, any>
}

export interface AiUsageStats {
  totalCalls: number
  totalTokens: number
  totalCost: number
  byModel: Record<string, { calls: number; tokens: number; cost: number }>
  usage: Array<{
    id: string
    model: string
    promptTokens: number
    completionTokens: number
    totalTokens: number
    cost: number | null
    endpoint: string | null
    metadata: any
    createdAt: string
  }>
}

export interface BillingUsage {
  apiRequests: {
    count: number
    changePercent: number
  }
  storage: {
    used: string // BigInt as string
    limit: string // BigInt as string
  }
  aiCalls: {
    count: number
    limit: number
    cost: number
  }
  monthlyEstimate: number
}

/**
 * Get AI configuration for a project
 */
export async function getAiConfig(projectId: string): Promise<AiConfiguration> {
  const response = await fetch(`${API_BASE}/ai?projectId=${encodeURIComponent(projectId)}`)
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to get AI configuration')
  }
  const data = await response.json()
  return data.config
}

/**
 * Update AI configuration for a project
 */
export async function updateAiConfig(
  projectId: string,
  config: Partial<AiConfiguration>
): Promise<AiConfiguration> {
  const response = await fetch(`${API_BASE}/ai?projectId=${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to update AI configuration')
  }
  const data = await response.json()
  return data.config
}

/**
 * Get AI usage statistics
 */
export async function getAiUsage(
  projectId: string,
  period: 'month' | 'all' = 'month'
): Promise<AiUsageStats> {
  const response = await fetch(
    `${API_BASE}/ai/usage?projectId=${encodeURIComponent(projectId)}&period=${period}`
  )
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to get AI usage')
  }
  return await response.json()
}

/**
 * Get billing usage data
 */
export async function getBillingUsage(projectId: string): Promise<BillingUsage> {
  const response = await fetch(`${API_BASE}/billing?projectId=${encodeURIComponent(projectId)}`)
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to get billing usage')
  }
  return await response.json()
}

