/**
 * MISSING PIECE 4: PREDICTIVE GUIDANCE LAYER
 * 
 * Proactive architectural foresight - the "Oh. This is different." moment
 * Suggests: "You added realtime messaging. Would you like push notifications too?"
 * 
 * CRITICAL CONSTRAINTS:
 * - Consumes existing BackendStateGraph
 * - NO execution - only suggestions
 * - Pattern-based (deterministic, not AI speculation)
 * - Non-invasive: can be disabled
 */

import { BackendStateGraph, EntityState } from '../orchestration/backend-state-graph'

export interface GuidanceSuggestion {
  id: string
  type: 'capability' | 'integration' | 'optimization' | 'security'
  title: string
  description: string
  reasoning: string
  priority: 'low' | 'medium' | 'high'
  
  // What was just added that triggers this
  trigger: {
    entity?: string
    capability?: string
    action: string
  }
  
  // Suggested action
  action: {
    prompt: string // Pre-filled prompt user can click
    category: string
  }
  
  // Confidence
  confidence: number // 0-1
  
  // Metadata
  timestamp: string
}

/**
 * Analyze state graph and generate proactive suggestions
 */
export function generatePredictiveSuggestions(
  graph: BackendStateGraph,
  recentExecutionId?: string
): GuidanceSuggestion[] {
  const suggestions: GuidanceSuggestion[] = []
  
  // Pattern 1: Realtime → Push Notifications
  if (hasRealtimeCapability(graph) && !hasPushNotifications(graph)) {
    suggestions.push({
      id: `suggest_${Date.now()}_push`,
      type: 'capability',
      title: 'Add Push Notifications',
      description: 'You have realtime messaging. Users might appreciate push notifications when offline.',
      reasoning: 'Realtime messaging works great when users are online, but push notifications ensure they never miss important messages.',
      priority: 'high',
      trigger: {
        capability: 'realtime',
        action: 'enabled',
      },
      action: {
        prompt: 'Add push notifications for new messages',
        category: 'capability',
      },
      confidence: 0.85,
      timestamp: new Date().toISOString(),
    })
  }
  
  // Pattern 2: User Authentication → Email Verification
  if (hasAuth(graph) && !hasEmailVerification(graph)) {
    suggestions.push({
      id: `suggest_${Date.now()}_email_verify`,
      type: 'security',
      title: 'Add Email Verification',
      description: 'Protect your user accounts with email verification.',
      reasoning: 'Email verification prevents fake accounts and ensures users can recover their accounts.',
      priority: 'high',
      trigger: {
        capability: 'auth',
        action: 'enabled',
      },
      action: {
        prompt: 'Enable email verification for new users',
        category: 'auth',
      },
      confidence: 0.9,
      timestamp: new Date().toISOString(),
    })
  }
  
  // Pattern 3: File Uploads → Image Processing
  if (hasFileStorage(graph) && !hasImageProcessing(graph)) {
    suggestions.push({
      id: `suggest_${Date.now()}_image_processing`,
      type: 'optimization',
      title: 'Add Image Processing',
      description: 'Automatically resize and optimize uploaded images.',
      reasoning: 'Image processing reduces storage costs and improves load times for your users.',
      priority: 'medium',
      trigger: {
        capability: 'storage',
        action: 'enabled',
      },
      action: {
        prompt: 'Add automatic image resizing for uploads',
        category: 'storage',
      },
      confidence: 0.75,
      timestamp: new Date().toISOString(),
    })
  }
  
  // Pattern 4: User-Generated Content → Moderation
  if (hasUserContent(graph) && !hasModeration(graph)) {
    suggestions.push({
      id: `suggest_${Date.now()}_moderation`,
      type: 'security',
      title: 'Add Content Moderation',
      description: 'Protect your platform with automated content moderation.',
      reasoning: 'User-generated content can include spam or inappropriate material. Moderation keeps your platform safe.',
      priority: 'high',
      trigger: {
        entity: 'user content',
        action: 'created',
      },
      action: {
        prompt: 'Add content moderation for user posts',
        category: 'safety',
      },
      confidence: 0.8,
      timestamp: new Date().toISOString(),
    })
  }
  
  // Pattern 5: Payment Integration → Subscription Management
  if (hasPayments(graph) && !hasSubscriptions(graph)) {
    suggestions.push({
      id: `suggest_${Date.now()}_subscriptions`,
      type: 'capability',
      title: 'Add Subscription Management',
      description: 'Turn one-time payments into recurring revenue with subscriptions.',
      reasoning: 'Subscriptions provide predictable revenue and are easier to manage than one-time payments.',
      priority: 'medium',
      trigger: {
        capability: 'payments',
        action: 'enabled',
      },
      action: {
        prompt: 'Add subscription billing for users',
        category: 'payments',
      },
      confidence: 0.7,
      timestamp: new Date().toISOString(),
    })
  }
  
  // Pattern 6: Multiple Entities → Search
  if (getEntityCount(graph) >= 3 && !hasSearch(graph)) {
    suggestions.push({
      id: `suggest_${Date.now()}_search`,
      type: 'optimization',
      title: 'Add Full-Text Search',
      description: 'Your data is growing. Make it easy for users to find what they need.',
      reasoning: 'With multiple data types, users will benefit from powerful search capabilities.',
      priority: 'medium',
      trigger: {
        entity: 'multiple entities',
        action: 'created',
      },
      action: {
        prompt: 'Add full-text search across all content',
        category: 'search',
      },
      confidence: 0.75,
      timestamp: new Date().toISOString(),
    })
  }
  
  // Pattern 7: API Endpoints → Rate Limiting
  if (getAPICount(graph) >= 5 && !hasRateLimiting(graph)) {
    suggestions.push({
      id: `suggest_${Date.now()}_rate_limit`,
      type: 'security',
      title: 'Add Rate Limiting',
      description: 'Protect your APIs from abuse with rate limiting.',
      reasoning: 'With multiple APIs, rate limiting prevents excessive usage and protects your infrastructure.',
      priority: 'high',
      trigger: {
        capability: 'api',
        action: 'created',
      },
      action: {
        prompt: 'Add rate limiting to protect my APIs',
        category: 'security',
      },
      confidence: 0.85,
      timestamp: new Date().toISOString(),
    })
  }
  
  // Pattern 8: Social Features → Activity Feed
  if (hasSocialFeatures(graph) && !hasActivityFeed(graph)) {
    suggestions.push({
      id: `suggest_${Date.now()}_activity_feed`,
      type: 'capability',
      title: 'Add Activity Feed',
      description: 'Keep users engaged with a personalized activity feed.',
      reasoning: 'Social platforms work best when users can see what\'s happening in their network.',
      priority: 'medium',
      trigger: {
        capability: 'social',
        action: 'enabled',
      },
      action: {
        prompt: 'Add an activity feed for user actions',
        category: 'social',
      },
      confidence: 0.7,
      timestamp: new Date().toISOString(),
    })
  }
  
  return suggestions.filter(s => s.confidence >= 0.7)
}

// Detection helpers

function hasRealtimeCapability(graph: BackendStateGraph): boolean {
  return Object.keys(graph.realtime?.channels || {}).length > 0
}

function hasPushNotifications(graph: BackendStateGraph): boolean {
  // Check if push notifications capability exists
  return false // TODO: Add capability detection
}

function hasAuth(graph: BackendStateGraph): boolean {
  return Object.values(graph.auth?.providers || {}).some(p => p?.enabled === true)
}

function hasEmailVerification(graph: BackendStateGraph): boolean {
  return graph.auth?.providers?.email?.enabled === true
}

function hasFileStorage(graph: BackendStateGraph): boolean {
  return Object.keys(graph.storage.buckets).length > 0
}

function hasImageProcessing(graph: BackendStateGraph): boolean {
  // Check for image processing configuration
  return false // TODO: Add detection
}

function hasUserContent(graph: BackendStateGraph): boolean {
  const entities = Object.values(graph.entities) as EntityState[]
  return entities.some(e => 
    e.name.includes('post') || 
    e.name.includes('comment') ||
    e.name.includes('review')
  )
}

function hasModeration(graph: BackendStateGraph): boolean {
  // Check for moderation capability
  return false // TODO: Add detection
}

function hasPayments(graph: BackendStateGraph): boolean {
  // Check for payment integration
  return false // TODO: Add detection
}

function hasSubscriptions(graph: BackendStateGraph): boolean {
  const entities = Object.values(graph.entities) as EntityState[]
  return entities.some(e => e.name.includes('subscription'))
}

function hasSearch(graph: BackendStateGraph): boolean {
  // Check for search capability
  return graph.search?.enabled === true
}

function hasRateLimiting(graph: BackendStateGraph): boolean {
  // Check for rate limiting
  return false // TODO: Add detection
}

function hasSocialFeatures(graph: BackendStateGraph): boolean {
  const entities = Object.values(graph.entities) as EntityState[]
  return entities.some(e => 
    e.name.includes('follow') || 
    e.name.includes('like') ||
    e.name.includes('friend')
  )
}

function hasActivityFeed(graph: BackendStateGraph): boolean {
  const entities = Object.values(graph.entities) as EntityState[]
  return entities.some(e => e.name.includes('activity') || e.name.includes('feed'))
}

function getEntityCount(graph: BackendStateGraph): number {
  return Object.keys(graph.entities).length
}

function getAPICount(graph: BackendStateGraph): number {
  return Object.keys(graph.apis || {}).length
}

/**
 * UI component can call this to display suggestions
 */
export function shouldShowGuidance(suggestions: GuidanceSuggestion[]): boolean {
  return suggestions.length > 0
}

/**
 * Get top priority suggestion
 */
export function getTopSuggestion(suggestions: GuidanceSuggestion[]): GuidanceSuggestion | null {
  if (suggestions.length === 0) return null
  
  // Sort by priority and confidence
  const sorted = [...suggestions].sort((a, b) => {
    const priorityWeight = { high: 3, medium: 2, low: 1 }
    const scoreA = priorityWeight[a.priority] * a.confidence
    const scoreB = priorityWeight[b.priority] * b.confidence
    return scoreB - scoreA
  })
  
  return sorted[0]
}
