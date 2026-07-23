/**
 * PHASE 5: CAPABILITY IMPACT REASONING
 * 
 * Predicts infrastructure impact before execution.
 * Analyzes auth, realtime, storage, API expansion, and performance implications.
 */

import { getOpenAIClient } from '@/lib/ai/openai-service'
import { logger } from '@/lib/logger'
import type { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'
import type { SemanticUnderstanding } from '@/lib/orchestration/semantic-understanding'

/**
 * Impact severity levels
 */
export type ImpactSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical'

/**
 * Infrastructure impact category
 */
export interface ImpactCategory {
  category: 'auth' | 'realtime' | 'storage' | 'api' | 'database' | 'performance'
  severity: ImpactSeverity
  description: string
  requirements: string[]
  risks: string[]
  cost: 'free' | 'low' | 'medium' | 'high'
  scalingConcerns: string[]
}

/**
 * Capability forecast
 */
export interface CapabilityForecast {
  capability: string
  enabled: boolean
  dependencies: string[]
  configuration: string[]
  complexity: 'simple' | 'moderate' | 'complex'
}

/**
 * Complete impact analysis
 */
export interface ImpactAnalysis {
  overallSeverity: ImpactSeverity
  summary: string
  impacts: ImpactCategory[]
  capabilities: CapabilityForecast[]
  recommendations: string[]
  estimatedComplexity: {
    score: number // 1-10
    factors: string[]
  }
  warnings: string[]
}

/**
 * Analyze infrastructure impact of proposed changes
 */
export async function analyzeInfrastructureImpact(
  intent: string,
  semanticUnderstanding: SemanticUnderstanding,
  existingGraph: BackendStateGraph,
  newEntities: string[]
): Promise<ImpactAnalysis> {
  const startTime = Date.now()
  
  try {
    logger.info('[Impact Analysis] Starting analysis', {
      intent: intent.substring(0, 50),
      newEntities: newEntities.length,
      existingEntities: Object.keys(existingGraph.entities).length,
    })
    
    // Quick analysis for simple cases
    const quickAnalysis = performQuickAnalysis(semanticUnderstanding, newEntities)
    if (quickAnalysis) {
      logger.info('[Impact Analysis] Quick analysis complete', {
        severity: quickAnalysis.overallSeverity,
        duration: Date.now() - startTime,
      })
      return quickAnalysis
    }
    
    // Deep AI-powered analysis for complex cases
    const aiAnalysis = await performAIAnalysis(
      intent,
      semanticUnderstanding,
      existingGraph,
      newEntities
    )
    
    const duration = Date.now() - startTime
    logger.info('[Impact Analysis] AI analysis complete', {
      severity: aiAnalysis.overallSeverity,
      impacts: aiAnalysis.impacts.length,
      capabilities: aiAnalysis.capabilities.length,
      duration,
    })
    
    return aiAnalysis
    
  } catch (error: any) {
    logger.error('[Impact Analysis] Analysis failed', {
      error: error.message,
    })
    
    // Return minimal analysis
    return createMinimalAnalysis()
  }
}

/**
 * Quick pattern-based analysis for common scenarios
 */
function performQuickAnalysis(
  semanticUnderstanding: SemanticUnderstanding,
  newEntities: string[]
): ImpactAnalysis | null {
  const impacts: ImpactCategory[] = []
  const capabilities: CapabilityForecast[] = []
  const warnings: string[] = []
  let overallSeverity: ImpactSeverity = 'low'
  
  // Auth impact detection
  if (semanticUnderstanding.authIntent) {
    impacts.push({
      category: 'auth',
      severity: 'medium',
      description: 'Authentication system required',
      requirements: ['JWT secret generation', 'Session management', 'Password hashing'],
      risks: ['Security vulnerabilities if misconfigured', 'Session management complexity'],
      cost: 'free',
      scalingConcerns: ['Session storage at scale', 'Token refresh strategy'],
    })
    
    capabilities.push({
      capability: 'User Authentication',
      enabled: true,
      dependencies: ['users table', 'JWT library'],
      configuration: ['JWT_SECRET', 'SESSION_DURATION'],
      complexity: 'moderate',
    })
    
    overallSeverity = 'medium'
  }
  
  // Storage impact detection
  if (semanticUnderstanding.storageIntent) {
    impacts.push({
      category: 'storage',
      severity: 'high',
      description: 'File storage system required',
      requirements: ['Storage bucket setup', 'File validation', 'Size limits'],
      risks: ['Storage costs', 'Security (public access)', 'Large file handling'],
      cost: 'medium',
      scalingConcerns: ['Storage quota management', 'CDN for delivery', 'Backup strategy'],
    })
    
    capabilities.push({
      capability: 'File Upload & Storage',
      enabled: true,
      dependencies: ['storage buckets', 'file validation middleware'],
      configuration: ['MAX_FILE_SIZE', 'ALLOWED_TYPES', 'STORAGE_PROVIDER'],
      complexity: 'complex',
    })
    
    overallSeverity = 'high'
  }
  
  // Realtime detection (messaging, notifications, live updates)
  const realtimeKeywords = ['message', 'chat', 'notification', 'live', 'realtime', 'subscribe']
  const hasRealtime = realtimeKeywords.some(keyword => 
    semanticUnderstanding.intentSummary.toLowerCase().includes(keyword)
  )
  
  if (hasRealtime) {
    impacts.push({
      category: 'realtime',
      severity: 'high',
      description: 'Real-time communication needed',
      requirements: ['WebSocket server', 'Pub/Sub system', 'Connection management'],
      risks: ['Connection scaling', 'State synchronization', 'Network reliability'],
      cost: 'high',
      scalingConcerns: ['Concurrent connections', 'Message queue', 'Load balancing'],
    })
    
    capabilities.push({
      capability: 'Real-time Updates',
      enabled: true,
      dependencies: ['WebSocket server', 'Redis pub/sub'],
      configuration: ['WS_PORT', 'REDIS_URL'],
      complexity: 'complex',
    })
    
    overallSeverity = 'high'
    warnings.push('Real-time features require additional infrastructure (WebSocket server)')
  }
  
  // API expansion
  if (newEntities.length > 0) {
    const apiEndpoints = newEntities.length * 5 // Estimate CRUD + custom
    impacts.push({
      category: 'api',
      severity: newEntities.length > 5 ? 'medium' : 'low',
      description: `${apiEndpoints}+ new API endpoints`,
      requirements: ['Route handlers', 'Validation schemas', 'Error handling'],
      risks: ['API complexity', 'Testing overhead', 'Documentation burden'],
      cost: 'free',
      scalingConcerns: ['Rate limiting', 'Caching strategy', 'API versioning'],
    })
    
    if (newEntities.length > 5) {
      warnings.push(`Large API expansion (${apiEndpoints}+ endpoints) - consider API documentation`)
    }
  }
  
  // Database impact
  if (newEntities.length > 0) {
    impacts.push({
      category: 'database',
      severity: newEntities.length > 10 ? 'high' : 'medium',
      description: `${newEntities.length} new tables`,
      requirements: ['Schema migration', 'Indexes', 'Relations'],
      risks: ['Migration complexity', 'Data integrity', 'Query performance'],
      cost: 'free',
      scalingConcerns: ['Index optimization', 'Query performance', 'Connection pooling'],
    })
    
    if (newEntities.length > 10) {
      warnings.push('Large schema expansion - consider normalization and performance impact')
    }
  }
  
  // Return analysis if we detected any impacts
  if (impacts.length > 0) {
    return {
      overallSeverity,
      summary: generateSummary(impacts, capabilities),
      impacts,
      capabilities,
      recommendations: generateRecommendations(impacts, warnings),
      estimatedComplexity: {
        score: calculateComplexityScore(impacts, capabilities),
        factors: impacts.map(i => `${i.category}: ${i.severity}`),
      },
      warnings,
    }
  }
  
  return null
}

/**
 * Deep AI-powered impact analysis
 */
async function performAIAnalysis(
  intent: string,
  semanticUnderstanding: SemanticUnderstanding,
  existingGraph: BackendStateGraph,
  newEntities: string[]
): Promise<ImpactAnalysis> {
  const openai = getOpenAIClient()
  
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content: `You are an infrastructure architect analyzing backend changes.

ANALYZE IMPACT:
Intent: ${intent}
Domain: ${semanticUnderstanding.domain}
Capabilities: ${semanticUnderstanding.probableCapabilities.join(', ')}
New Entities: ${newEntities.join(', ')}
Existing Entities: ${Object.keys(existingGraph.entities).join(', ')}

CATEGORIES TO ANALYZE:
1. AUTH - Authentication/authorization needs
2. REALTIME - WebSocket/live updates
3. STORAGE - File uploads/CDN
4. API - Endpoint expansion
5. DATABASE - Schema complexity
6. PERFORMANCE - Scaling concerns

RETURN JSON:
{
  "overallSeverity": "low|medium|high|critical",
  "summary": "Brief impact description",
  "impacts": [
    {
      "category": "auth",
      "severity": "medium",
      "description": "JWT authentication required",
      "requirements": ["JWT secret", "Session management"],
      "risks": ["Security misconfiguration"],
      "cost": "free|low|medium|high",
      "scalingConcerns": ["Session storage at scale"]
    }
  ],
  "capabilities": [
    {
      "capability": "User Authentication",
      "enabled": true,
      "dependencies": ["users table", "JWT library"],
      "configuration": ["JWT_SECRET"],
      "complexity": "simple|moderate|complex"
    }
  ],
  "recommendations": ["Enable rate limiting", "Add caching"],
  "estimatedComplexity": {
    "score": 6,
    "factors": ["auth: medium", "storage: high"]
  },
  "warnings": ["Storage costs may increase"]
}

Return ONLY valid JSON.`
      },
      {
        role: 'user',
        content: 'Analyze infrastructure impact'
      }
    ],
    temperature: 0.3,
    max_tokens: 2000,
  })
  
  const content = response.choices[0]?.message?.content
  if (!content) {
    throw new Error('No response from AI')
  }
  
  return JSON.parse(content.trim())
}

/**
 * Generate summary text
 */
function generateSummary(impacts: ImpactCategory[], capabilities: CapabilityForecast[]): string {
  const highImpacts = impacts.filter(i => i.severity === 'high' || i.severity === 'critical')
  const enabledCaps = capabilities.filter(c => c.enabled)
  
  if (highImpacts.length > 0) {
    return `High infrastructure impact: ${highImpacts.map(i => i.category).join(', ')}. ${enabledCaps.length} capabilities enabled.`
  }
  
  return `Moderate impact: ${impacts.length} infrastructure changes. ${enabledCaps.length} capabilities enabled.`
}

/**
 * Generate recommendations
 */
function generateRecommendations(impacts: ImpactCategory[], warnings: string[]): string[] {
  const recs: string[] = []
  
  for (const impact of impacts) {
    if (impact.category === 'auth' && impact.severity !== 'none') {
      recs.push('Enable rate limiting for authentication endpoints')
      recs.push('Configure secure session management')
    }
    
    if (impact.category === 'storage' && impact.severity !== 'none') {
      recs.push('Set up CDN for file delivery')
      recs.push('Implement file size limits and validation')
    }
    
    if (impact.category === 'realtime' && impact.severity !== 'none') {
      recs.push('Plan for WebSocket scaling strategy')
      recs.push('Consider Redis for pub/sub')
    }
    
    if (impact.category === 'api' && impact.severity === 'high') {
      recs.push('Implement API versioning strategy')
      recs.push('Add comprehensive API documentation')
    }
  }
  
  if (warnings.length > 0) {
    recs.push('Review warnings before proceeding')
  }
  
  return Array.from(new Set(recs)) // Remove duplicates
}

/**
 * Calculate complexity score (1-10)
 */
function calculateComplexityScore(impacts: ImpactCategory[], capabilities: CapabilityForecast[]): number {
  let score = 1
  
  for (const impact of impacts) {
    if (impact.severity === 'critical') score += 3
    else if (impact.severity === 'high') score += 2
    else if (impact.severity === 'medium') score += 1
  }
  
  for (const cap of capabilities) {
    if (cap.complexity === 'complex') score += 2
    else if (cap.complexity === 'moderate') score += 1
  }
  
  return Math.min(10, Math.max(1, score))
}

/**
 * Create minimal analysis fallback
 */
function createMinimalAnalysis(): ImpactAnalysis {
  return {
    overallSeverity: 'low',
    summary: 'Standard backend changes with minimal infrastructure impact',
    impacts: [],
    capabilities: [],
    recommendations: [],
    estimatedComplexity: {
      score: 3,
      factors: ['Basic CRUD operations'],
    },
    warnings: [],
  }
}
