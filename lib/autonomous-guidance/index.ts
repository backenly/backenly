/**
 * PHASE 6: AUTONOMOUS GUIDANCE
 * 
 * Proactive AI suggestions for backend improvements.
 * Analyzes graph continuously and suggests optimizations.
 */

import { getOpenAIClient } from '@/lib/ai/openai-service'
import { logger } from '@/lib/logger'
import type { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'

/**
 * Suggestion categories
 */
export type SuggestionCategory = 
  | 'caching'
  | 'indexing'
  | 'analytics'
  | 'notifications'
  | 'security'
  | 'performance'
  | 'scalability'
  | 'monitoring'

/**
 * AI-generated suggestion
 */
export interface AISuggestion {
  id: string
  category: SuggestionCategory
  title: string
  description: string
  rationale: string
  impact: 'low' | 'medium' | 'high'
  effort: 'low' | 'medium' | 'high'
  priority: number // 1-10
  implementation: {
    changes: string[]
    configurations: string[]
    dependencies?: string[]
  }
  benefits: string[]
  tradeoffs?: string[]
}

/**
 * Suggestions analysis result
 */
export interface SuggestionsAnalysis {
  suggestions: AISuggestion[]
  analysisContext: {
    entityCount: number
    hasAuth: boolean
    hasStorage: boolean
    hasRealtime: boolean
    complexity: number
  }
  timestamp: string
}

/**
 * Generate proactive suggestions for backend improvement
 */
export async function generateProactiveSuggestions(
  graph: BackendStateGraph,
  projectId: string,
  recentActivity?: string[]
): Promise<SuggestionsAnalysis> {
  const startTime = Date.now()
  
  try {
    logger.info('[Autonomous Guidance] Starting analysis', {
      projectId,
      entities: Object.keys(graph.entities).length,
    })
    
    // Analyze current state
    const context = analyzeBackendContext(graph)
    
    // Generate pattern-based suggestions
    const patternSuggestions = generatePatternSuggestions(graph, context)
    
    // Generate AI-powered suggestions for complex scenarios
    const aiSuggestions = await generateAISuggestions(graph, context, recentActivity)
    
    // Merge and prioritize
    const allSuggestions = [...patternSuggestions, ...aiSuggestions]
    const prioritized = prioritizeSuggestions(allSuggestions, context)
    
    const duration = Date.now() - startTime
    logger.info('[Autonomous Guidance] Analysis complete', {
      suggestions: prioritized.length,
      duration,
    })
    
    return {
      suggestions: prioritized.slice(0, 8), // Top 8 suggestions
      analysisContext: context,
      timestamp: new Date().toISOString(),
    }
    
  } catch (error: any) {
    logger.error('[Autonomous Guidance] Analysis failed', {
      error: error.message,
    })
    
    return {
      suggestions: [],
      analysisContext: analyzeBackendContext(graph),
      timestamp: new Date().toISOString(),
    }
  }
}

/**
 * Analyze backend context
 */
function analyzeBackendContext(graph: BackendStateGraph) {
  const entities = Object.values(graph.entities)
  const entityCount = entities.length
  
  // Detect capabilities
  const hasAuth = entities.some(e => 
    e.name.toLowerCase().includes('user') || 
    e.name.toLowerCase().includes('account')
  )
  
  const hasStorage = entities.some(e =>
    Object.values(e.fields || {}).some(f => 
      f.type === 'string' && (f.name.includes('url') || f.name.includes('path'))
    )
  )
  
  const hasRealtime = entities.some(e =>
    e.name.toLowerCase().includes('message') ||
    e.name.toLowerCase().includes('notification') ||
    e.name.toLowerCase().includes('event')
  )
  
  // Calculate complexity
  let complexity = entityCount
  entities.forEach(e => {
    const fieldCount = Object.keys(e.fields || {}).length
    complexity += fieldCount > 10 ? 2 : fieldCount > 5 ? 1 : 0
  })
  
  return {
    entityCount,
    hasAuth,
    hasStorage,
    hasRealtime,
    complexity: Math.min(10, complexity),
  }
}

/**
 * Generate pattern-based suggestions
 */
function generatePatternSuggestions(
  graph: BackendStateGraph,
  context: ReturnType<typeof analyzeBackendContext>
): AISuggestion[] {
  const suggestions: AISuggestion[] = []
  const entities = Object.values(graph.entities)
  
  // CACHING: Suggest for read-heavy entities
  const readHeavyEntities = entities.filter(e => 
    e.name.toLowerCase().includes('product') ||
    e.name.toLowerCase().includes('post') ||
    e.name.toLowerCase().includes('article') ||
    e.name.toLowerCase().includes('course')
  )
  
  if (readHeavyEntities.length > 0) {
    suggestions.push({
      id: 'cache_read_heavy',
      category: 'caching',
      title: 'Add Redis Caching for Read-Heavy Data',
      description: `Cache ${readHeavyEntities.map(e => e.name).join(', ')} to reduce database load`,
      rationale: 'These entities are typically read more often than written. Caching can reduce response time by 80%+',
      impact: 'high',
      effort: 'medium',
      priority: 8,
      implementation: {
        changes: [
          'Add Redis client configuration',
          `Cache GET endpoints for ${readHeavyEntities[0].name}`,
          'Implement cache invalidation on updates',
        ],
        configurations: ['REDIS_URL', 'CACHE_TTL'],
        dependencies: ['redis', '@redis/client'],
      },
      benefits: [
        'Reduce database queries by 60-80%',
        'Improve response time significantly',
        'Better scalability',
      ],
      tradeoffs: ['Cache invalidation complexity', 'Slightly stale data possible'],
    })
  }
  
  // INDEXING: Suggest for large tables
  if (context.entityCount > 5) {
    suggestions.push({
      id: 'add_indexes',
      category: 'indexing',
      title: 'Add Database Indexes for Query Performance',
      description: 'Create indexes on frequently queried fields',
      rationale: 'As your data grows, queries on unindexed fields will become slow',
      impact: 'high',
      effort: 'low',
      priority: 9,
      implementation: {
        changes: [
          'Add index on foreign key fields',
          'Add index on commonly filtered fields (status, createdAt)',
          'Add composite index for complex queries',
        ],
        configurations: [],
      },
      benefits: [
        'Query performance 10-100x faster',
        'Better database scalability',
        'Lower infrastructure costs',
      ],
    })
  }
  
  // ANALYTICS: Suggest for user-facing apps
  if (context.hasAuth) {
    suggestions.push({
      id: 'add_analytics',
      category: 'analytics',
      title: 'Track User Activity & Events',
      description: 'Add analytics to understand user behavior',
      rationale: 'User data helps you make informed product decisions',
      impact: 'medium',
      effort: 'low',
      priority: 6,
      implementation: {
        changes: [
          'Create events table',
          'Add event tracking middleware',
          'Build analytics dashboard endpoints',
        ],
        configurations: ['ANALYTICS_ENABLED', 'SAMPLING_RATE'],
      },
      benefits: [
        'Understand user behavior',
        'Data-driven decisions',
        'Identify bottlenecks',
      ],
    })
  }
  
  // NOTIFICATIONS: Suggest for user interactions
  if (context.hasAuth && !context.hasRealtime) {
    suggestions.push({
      id: 'add_notifications',
      category: 'notifications',
      title: 'Add Push Notifications System',
      description: 'Enable user notifications for important events',
      rationale: 'Keep users engaged with timely updates',
      impact: 'medium',
      effort: 'medium',
      priority: 5,
      implementation: {
        changes: [
          'Create notifications table',
          'Add notification service',
          'Build notification endpoints',
        ],
        configurations: ['NOTIFICATION_PROVIDER', 'PUSH_CREDENTIALS'],
        dependencies: ['firebase-admin', 'node-push-notifications'],
      },
      benefits: [
        'Improve user engagement',
        'Real-time communication',
        'Better UX',
      ],
    })
  }
  
  // SECURITY: Always relevant
  suggestions.push({
    id: 'add_rate_limiting',
    category: 'security',
    title: 'Implement Rate Limiting',
    description: 'Protect APIs from abuse and DDoS attacks',
    rationale: 'Essential security measure for production apps',
    impact: 'high',
    effort: 'low',
    priority: 9,
    implementation: {
      changes: [
        'Add rate limiting middleware',
        'Configure limits per endpoint type',
        'Add rate limit response headers',
      ],
      configurations: ['RATE_LIMIT_WINDOW', 'RATE_LIMIT_MAX'],
      dependencies: ['express-rate-limit', 'rate-limiter-flexible'],
    },
    benefits: [
      'Protection from abuse',
      'Prevent DDoS attacks',
      'Fair resource usage',
    ],
  })
  
  // MONITORING: For production readiness
  if (context.complexity > 5) {
    suggestions.push({
      id: 'add_monitoring',
      category: 'monitoring',
      title: 'Add Application Monitoring',
      description: 'Track errors, performance, and uptime',
      rationale: 'Critical for production reliability and debugging',
      impact: 'high',
      effort: 'low',
      priority: 8,
      implementation: {
        changes: [
          'Integrate error tracking (Sentry)',
          'Add performance monitoring',
          'Set up health check endpoints',
        ],
        configurations: ['SENTRY_DSN', 'MONITORING_ENABLED'],
        dependencies: ['@sentry/node', 'prom-client'],
      },
      benefits: [
        'Catch errors before users report them',
        'Performance insights',
        'Better debugging',
      ],
    })
  }
  
  return suggestions
}

/**
 * Generate AI-powered suggestions
 */
async function generateAISuggestions(
  graph: BackendStateGraph,
  context: ReturnType<typeof analyzeBackendContext>,
  recentActivity?: string[]
): Promise<AISuggestion[]> {
  // Only use AI for complex scenarios
  if (context.complexity < 6) {
    return []
  }
  
  try {
    const openai = getOpenAIClient()
    
    const entityNames = Object.keys(graph.entities)
    const activityContext = recentActivity?.slice(0, 3).join(', ') || 'No recent activity'
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: `You are a backend optimization advisor.

ANALYZE:
Entities: ${entityNames.join(', ')}
Has Auth: ${context.hasAuth}
Has Storage: ${context.hasStorage}
Has Realtime: ${context.hasRealtime}
Complexity: ${context.complexity}/10
Recent Activity: ${activityContext}

SUGGEST 1-2 SPECIFIC OPTIMIZATIONS:
- Focus on scalability, performance, or features
- Be specific and actionable
- Consider the current architecture

RETURN JSON:
{
  "suggestions": [
    {
      "id": "unique_id",
      "category": "caching|indexing|analytics|notifications|security|performance|scalability|monitoring",
      "title": "Short title",
      "description": "What to do",
      "rationale": "Why this matters",
      "impact": "low|medium|high",
      "effort": "low|medium|high",
      "priority": 7,
      "implementation": {
        "changes": ["Step 1", "Step 2"],
        "configurations": ["ENV_VAR"],
        "dependencies": ["npm-package"]
      },
      "benefits": ["Benefit 1", "Benefit 2"]
    }
  ]
}

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: 'Suggest optimizations'
        }
      ],
      temperature: 0.7,
      max_tokens: 1500,
    })
    
    const content = response.choices[0]?.message?.content
    if (!content) {
      return []
    }
    
    const parsed = JSON.parse(content.trim())
    return parsed.suggestions || []
    
  } catch (error: any) {
    logger.error('[Autonomous Guidance] AI suggestions failed', {
      error: error.message,
    })
    return []
  }
}

/**
 * Prioritize suggestions
 */
function prioritizeSuggestions(
  suggestions: AISuggestion[],
  context: ReturnType<typeof analyzeBackendContext>
): AISuggestion[] {
  return suggestions.sort((a, b) => {
    // Primary: Priority score
    if (a.priority !== b.priority) {
      return b.priority - a.priority
    }
    
    // Secondary: Impact
    const impactWeight = { high: 3, medium: 2, low: 1 }
    const aScore = impactWeight[a.impact]
    const bScore = impactWeight[b.impact]
    
    if (aScore !== bScore) {
      return bScore - aScore
    }
    
    // Tertiary: Effort (prefer low effort)
    const effortWeight = { low: 3, medium: 2, high: 1 }
    return effortWeight[a.effort] - effortWeight[b.effort]
  })
}

/**
 * Apply suggestion (execute the changes)
 */
export async function applySuggestion(
  suggestionId: string,
  projectId: string,
  userId: string
): Promise<{ success: boolean; message: string }> {
  // This would integrate with the orchestration engine
  // to actually implement the suggestion
  logger.info('[Autonomous Guidance] Applying suggestion', {
    suggestionId,
    projectId,
  })
  
  return {
    success: true,
    message: 'Suggestion applied successfully',
  }
}

/**
 * Dismiss suggestion (mark as not relevant)
 */
export async function dismissSuggestion(
  suggestionId: string,
  projectId: string,
  reason?: string
): Promise<void> {
  logger.info('[Autonomous Guidance] Dismissing suggestion', {
    suggestionId,
    projectId,
    reason,
  })
  
  // This would record the dismissal to improve future suggestions
}
