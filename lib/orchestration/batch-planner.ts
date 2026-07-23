/**
 * BATCH BUILD MODE - The Winning UX
 * 
 * Parses ALL entities/features from ONE prompt and builds everything at once.
 * This is the default mode that makes Backenly feel fast and confident.
 * 
 * Input: "I need a blog with users, posts, comments, and likes"
 * Output: Complete execution plan for ALL 4 tables + APIs + relationships
 * 
 * NO questions. NO incremental prompts. ONE build.
 */

import { getOpenAIClient } from '@/lib/ai/openai-service'
import { BackendStateGraph } from './backend-state-graph'
import { CanonicalIntent } from './types'
import { IntentSpec, validateIntentSpec, intentSpecToBatchPlan } from './intent-spec'

export type ExecutionMode = 'BATCH' | 'GUIDED'

export interface BatchEntity {
  name: string
  description: string
  fields: Array<{
    name: string
    type: 'string' | 'number' | 'boolean' | 'date' | 'reference'
    required: boolean
    unique?: boolean
    referenceTo?: string // For foreign keys
  }>
  dependsOn: string[] // Other entities this depends on (for topological sort)
  // PRODUCTION-GRADE INVARIANTS (1-5)
  uniqueConstraints?: Array<{
    fields: string[] // Compound unique constraint (e.g., ['idea_id', 'user_id'])
    reason: string // Human explanation (e.g., 'One vote per user per idea')
  }>
  quotas?: Array<{
    tier: string // 'free' | 'paid'
    limit: number // Max count (-1 = unlimited)
    action: 'create' // What action is limited
    reason: string // Human explanation
  }>
  ownership?: {
    enabled: boolean
    field: string // Field name for owner (e.g., 'created_by', 'user_id')
    writeProtection: boolean // Only owner can edit/delete
  }
  readIsolation?: {
    enabled: boolean
    field: string // Field to filter by (e.g., 'created_by')
    reason: string // Human explanation
  }
  softDelete?: {
    enabled: boolean
    anonymizeFields?: string[] // Fields to anonymize (e.g., ['name', 'email'])
    replacement: string // What to show (e.g., 'Deleted User')
  }
  // PRODUCTION-GRADE INVARIANTS (6-15)
  capacityLimits?: {
    enabled: boolean
    field: string // Field that tracks capacity (e.g., 'seats', 'slots')
    checkField?: string // Field to check against (e.g., 'booked_count')
    onExceeded: 'block' | 'waitlist' // What to do when full
    reason: string
  }
  stateMachine?: {
    enabled: boolean
    field: string // Field that stores state (e.g., 'status')
    states: Array<{
      name: string
      allowedTransitions: string[] // States this can transition to
      isTerminal?: boolean // Cannot transition from this state
    }>
    reason: string
  }
  tierGating?: Array<{
    tier: string // 'free' | 'paid'
    allowedOperations: ('read' | 'write')[] // What operations are allowed
    blockedFields?: string[] // Fields that are gated (e.g., 'content' for premium)
    reason: string
  }>
  conflictDetection?: {
    enabled: boolean
    type: 'time_overlap' | 'range_overlap'
    fields: string[] // Fields to check (e.g., ['start_time', 'end_time'])
    scope?: string // Scope field (e.g., 'provider_id')
    reason: string
  }
  derivedFields?: Array<{
    name: string // Field name (e.g., 'like_count')
    sourceEntity: string // Entity to count/aggregate from (e.g., 'likes')
    aggregation: 'count' | 'sum' | 'avg'
    condition?: string // Optional filter (e.g., 'status = active')
    reason: string
  }>
  sideEffects?: Array<{
    trigger: 'create' | 'update' | 'delete'
    targetEntity: string // Entity to update (e.g., 'users')
    targetField: string // Field to update (e.g., 'reputation')
    operation: 'increment' | 'decrement' | 'set'
    value?: number | string
    condition?: string // When to trigger (e.g., 'action = upvote')
    preventSelfAction?: boolean // Prevent voting on own content
    reason: string
  }>
  accessRules?: Array<{
    operation: 'read' | 'write' | 'delete'
    requires: 'ownership' | 'enrollment' | 'permission'
    field?: string // Field to check (e.g., 'enrolled_users')
    reason: string
  }>
  storagePermissions?: {
    enabled: boolean
    ownershipField: string // Field that stores owner (e.g., 'uploaded_by')
    sharedWith?: string // Field for shared users
    deleteRequiresOwnership: boolean
    reason: string
  }
}

export interface BatchRelationship {
  from: string
  to: string
  type: 'one-to-one' | 'one-to-many' | 'many-to-many'
  foreignKey?: string
}

export interface BatchPlan {
  entities: BatchEntity[]
  relationships: BatchRelationship[]
  auth: {
    enabled: boolean
    signupEnabled: boolean
    loginEnabled: boolean
  }
  storage: {
    enabled: boolean
    buckets: string[]
  }
  userIntent: string
  isBatchMode: true
  executionOrder: string[] // Topologically sorted entity names
  summary: string // Human-readable "I'll build: ..."
  policy?: {
    type: string
    role: string
    resource: string
    action: string
    operation: string
  }
}

/**
 * Deterministically extract inline field list from natural language
 * Example: "create products with name, price, and quantity" → [{name:"name",type:"string"}, ...]
 */
interface ExtractedField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'reference'
  required: boolean
  referenceTo?: string // For foreign keys
}

function extractInlineFields(prompt: string): ExtractedField[] {
  // Match patterns like:
  // "create X with field1, field2, and field3"
  // "add X with field1, field2"
  // "X table with field1, field2"
  console.log('[extractInlineFields] Input:', prompt)
  
  // Try multiple patterns for better extraction
  const patterns = [
    /with\s+(.+?)(?:\s+(?:table|entity|for|to|from|in|on)\s|$)/i,
    /(?:table|entity|model)\s+with\s+(.+?)(?:\.|$)/i,
    /(?:fields?|columns?):\s*(.+?)(?:\.|$)/i,
  ]
  
  let fieldPart: string | null = null
  for (const pattern of patterns) {
    const match = prompt.match(pattern)
    if (match && match[1]) {
      fieldPart = match[1]
      console.log('[extractInlineFields] Matched pattern:', pattern.source)
      break
    }
  }
  
  console.log('[extractInlineFields] Field part:', fieldPart)
  if (!fieldPart) return []

  // Split by comma or 'and', clean up, remove trailing punctuation and schema keywords
  const fields = fieldPart
    .split(/,|\band\b/i)
    .map(f => f.trim().replace(/[.!?;:]$/, ''))
    .map(f => f.replace(/\s+(field|fields|column|columns)$/i, '').trim()) // Strip trailing schema keywords
    .filter(f => f.length > 0 && f.length < 50) // Filter out overly long matches (likely noise)
    .filter(f => !f.match(/^(table|entity|model|collection)s?$/i))
  
  console.log('[extractInlineFields] Extracted fields:', fields)

  return fields.map(name => ({
    name: name.toLowerCase().replace(/\s+/g, '_'),
    type: inferTypeFromName(name),
    required: false
  }))
}

/**
 * Infer field type from common naming patterns
 */
function inferTypeFromName(name: string): 'string' | 'number' | 'boolean' | 'date' | 'reference' {
  const lower = name.toLowerCase()
  if (/price|amount|cost|total|count|quantity|stock|number|age|score|rating/i.test(lower)) return 'number'
  if (/date|time|at|on|created|updated/i.test(lower)) return 'date'
  if (/is_|has_|can_|should_|active|enabled|verified|published/i.test(lower)) return 'boolean'
  if (/email|url|link|path/i.test(lower)) return 'string'
  return 'string'
}

/**
 * Get default fields for common entity types
 * This enables fast deterministic table creation without LLM
 */
function getDefaultFieldsForEntity(entityName: string): ExtractedField[] {
  const defaults: Record<string, ExtractedField[]> = {
    // Payment/Billing entities
    payments: [
      { name: 'amount', type: 'number', required: true },
      { name: 'status', type: 'string', required: true },
      { name: 'created_at', type: 'date', required: false },
    ],
    // Content entities
    articles: [
      { name: 'title', type: 'string', required: true },
      { name: 'content', type: 'string', required: false },
      { name: 'published', type: 'boolean', required: false },
    ],
    // User-related
    profiles: [
      { name: 'bio', type: 'string', required: false },
      { name: 'avatar_url', type: 'string', required: false },
    ],
    // E-commerce
    products: [
      { name: 'name', type: 'string', required: true },
      { name: 'price', type: 'number', required: true },
      { name: 'description', type: 'string', required: false },
    ],
    categories: [
      { name: 'name', type: 'string', required: true },
      { name: 'slug', type: 'string', required: true },
    ],
    // Social
    reviews: [
      { name: 'rating', type: 'number', required: true },
      { name: 'content', type: 'string', required: false },
      { name: 'created_at', type: 'date', required: false },
    ],
    // Communication
    messages: [
      { name: 'content', type: 'string', required: true },
      { name: 'read', type: 'boolean', required: false },
      { name: 'created_at', type: 'date', required: false },
    ],
    notifications: [
      { name: 'title', type: 'string', required: true },
      { name: 'message', type: 'string', required: false },
      { name: 'read', type: 'boolean', required: false },
    ],
    // Tasks/Projects
    tasks: [
      { name: 'title', type: 'string', required: true },
      { name: 'completed', type: 'boolean', required: false },
      { name: 'due_date', type: 'date', required: false },
      { name: 'userId', type: 'reference', required: true, referenceTo: 'users' },
      { name: 'projectId', type: 'reference', required: false, referenceTo: 'projects' },
    ],
    projects: [
      { name: 'name', type: 'string', required: true },
      { name: 'description', type: 'string', required: false },
      { name: 'status', type: 'string', required: false },
      { name: 'userId', type: 'reference', required: true, referenceTo: 'users' },
    ],
    comments: [
      { name: 'content', type: 'string', required: true },
      { name: 'userId', type: 'reference', required: true, referenceTo: 'users' },
    ],
    posts: [
      { name: 'title', type: 'string', required: true },
      { name: 'content', type: 'string', required: false },
      { name: 'published', type: 'boolean', required: false },
      { name: 'userId', type: 'reference', required: true, referenceTo: 'users' },
    ],
    orders: [
      { name: 'total', type: 'number', required: true },
      { name: 'status', type: 'string', required: true },
      { name: 'userId', type: 'reference', required: true, referenceTo: 'users' },
    ],
    // Subscriptions
    subscriptions: [
      { name: 'plan', type: 'string', required: true },
      { name: 'status', type: 'string', required: true },
      { name: 'start_date', type: 'date', required: false },
      { name: 'end_date', type: 'date', required: false },
    ],
  }
  
  // Return defaults for known entities, or minimal generic fields
  return defaults[entityName] || [
    { name: 'name', type: 'string', required: true },
    { name: 'created_at', type: 'date', required: false },
  ]
}

/**
 * Extract entity name from creation prompt
 */
function extractEntityName(prompt: string): string | null {
  // Match patterns like:
  // "create a products table" → products
  // "add users" → users
  // "build an order system" → orders
  // "products table with name" → products
  const patterns = [
    /create\s+(?:a|an)?\s*(\w+)\s+(?:table|entity|model)/i,
    /add\s+(?:a|an)?\s*(\w+)\s+(?:table|entity|model)/i,
    /build\s+(?:a|an)?\s*(\w+)\s+(?:table|entity|model)/i,
    /make\s+(?:a|an)?\s*(\w+)\s+(?:table|entity|model)/i,
    /(\w+)\s+(?:table|entity|model)\s+with/i,
    /(?:table|entity|model)\s+(?:called|named)\s+(\w+)/i,
    /(?:for|called)\s+(\w+)\s+(?:table|entity|model)/i,
  ]

  for (const pattern of patterns) {
    const match = prompt.match(pattern)
    if (match && match[1]) {
      const entityName = match[1].toLowerCase().replace(/\s+/g, '_')
      // Filter out common words that aren't entity names
      if (!['a', 'an', 'the', 'with', 'and', 'or'].includes(entityName)) {
        return entityName
      }
    }
  }
  return null
}

interface ExtractedRelationship {
  from: string
  to: string
  type: 'one-to-many' | 'many-to-one' | 'one-to-one'
  foreignKey?: string
}

/**
 * Extract relationships from prompt
 * Detects patterns like "belongs to X", "has many X", "references X"
 */
function extractRelationships(prompt: string, fromEntity: string | null): ExtractedRelationship[] {
  if (!fromEntity) return []
  
  const relationships: ExtractedRelationship[] = []
  const lower = prompt.toLowerCase()
  
  // Pattern: "belongs to X" or "that belongs to X"
  const belongsMatch = lower.match(/belongs?\s+to\s+(\w+)/i)
  if (belongsMatch) {
    const toEntity = belongsMatch[1].toLowerCase()
    // Convert plural entity name to singular for foreign key (e.g., "users" -> "userId")
    const singularEntity = toEntity.replace(/s$/, '')
    relationships.push({
      from: fromEntity,
      to: toEntity,
      type: 'many-to-one',
      foreignKey: `${singularEntity}Id`
    })
  }
  
  // Pattern: "has many X"
  const hasManyMatch = lower.match(/has\s+many\s+(\w+)/i)
  if (hasManyMatch) {
    const toEntity = hasManyMatch[1].toLowerCase()
    relationships.push({
      from: fromEntity,
      to: toEntity,
      type: 'one-to-many'
    })
  }
  
  // Pattern: "references X" or "references the X table"
  const referencesMatch = lower.match(/references\s+(?:the\s+)?(\w+)(?:\s+table)?/i)
  if (referencesMatch) {
    const toEntity = referencesMatch[1].toLowerCase()
    // Convert plural entity name to singular for foreign key (e.g. "users" -> "userId")
    const singularEntity = toEntity.replace(/s$/, '')
    relationships.push({
      from: fromEntity,
      to: toEntity,
      type: 'many-to-one',
      foreignKey: `${singularEntity}Id`
    })
  }
  
  // Pattern: "linked to X" or "linked to the X table"
  const linkedToMatch = lower.match(/linked\s+to\s+(?:the\s+)?(\w+)(?:\s+table)?/i)
  if (linkedToMatch) {
    const toEntity = linkedToMatch[1].toLowerCase()
    // Convert plural entity name to singular for foreign key (e.g. "users" -> "userId")
    const singularEntity = toEntity.replace(/s$/, '')
    relationships.push({
      from: fromEntity,
      to: toEntity,
      type: 'many-to-one',
      foreignKey: `${singularEntity}Id`
    })
  }
  
  return relationships
}

/**
 * Detect policy intents like "Only admins can delete orders"
 * Returns a policy intent if detected, null otherwise
 */
function detectPolicyIntent(prompt: string): { type: 'policy'; role: string; resource: string; action: 'allow' | 'restrict' } | null {
  const lower = prompt.toLowerCase()
  
  // Pattern: "Only {role} can {action} {resource}"
  // Examples: "Only admins can delete orders", "Only owners can edit posts"
  const onlyRolePattern = /only\s+(\w+)\s+can\s+(\w+)\s+(\w+)/i
  const onlyMatch = prompt.match(onlyRolePattern)
  if (onlyMatch) {
    const role = onlyMatch[1].toLowerCase()
    const operation = onlyMatch[2].toLowerCase()
    const resource = onlyMatch[3].toLowerCase()
    return {
      type: 'policy',
      role,
      resource,
      action: 'restrict' // "Only X can" implies restriction for others
    }
  }
  
  // Pattern: "{role} can {action} {resource}"
  const roleCanPattern = /(\w+)\s+can\s+(\w+)\s+(\w+)/i
  const canMatch = prompt.match(roleCanPattern)
  if (canMatch) {
    const role = canMatch[1].toLowerCase()
    const resource = canMatch[3].toLowerCase()
    return {
      type: 'policy',
      role,
      resource,
      action: 'allow'
    }
  }
  
  return null
}

/**
 * TEMPLATE FAST PATH - Zero LLM latency for common patterns
 * Returns pre-built batch plans for templates like "SaaS blog", "E-commerce", etc.
 */
/**
 * Detect if a prompt is complex enough that a hardcoded template would be a disservice.
 * Complex prompts should go to the LLM for full extraction.
 */
function isComplexPrompt(lower: string): boolean {
  // If prompt is very long it likely describes a multi-feature system
  if (lower.length > 300) return true

  // Count how many distinct feature/entity keywords are mentioned
  const featureKeywords = [
    'workspace', 'organization', 'subscription', 'billing', 'payment',
    'role', 'rbac', 'permission', 'invite', 'team', 'member',
    'notification', 'audit', 'log', 'webhook', 'integration',
    'analytics', 'report', 'dashboard', 'attachment', 'file',
    'comment', 'activity', 'timeline', 'label', 'tag', 'category',
    'priority', 'milestone', 'sprint', 'board', 'column',
    'collaborat', 'multi-user', 'multiuser', 'multi user',
  ]
  const matches = featureKeywords.filter(kw => lower.includes(kw))
  return matches.length >= 3
}

function matchTemplatePattern(userMessage: string): BatchPlan | null {
  const lower = userMessage.toLowerCase()

  // Skip templates for complex multi-feature prompts — let the LLM handle them
  if (isComplexPrompt(lower)) return null
  
  // SaaS Blog template
  if (lower.includes('blog') || lower.includes('saas blog')) {
    return {
      entities: [
        {
          name: 'users',
          fields: [
            { name: 'email', type: 'string', required: true },
            { name: 'name', type: 'string', required: true },
            { name: 'role', type: 'string', required: false },
          ],
          description: 'User accounts for the blog',
          dependsOn: []
        },
        {
          name: 'posts',
          fields: [
            { name: 'title', type: 'string', required: true },
            { name: 'content', type: 'string', required: true },
            { name: 'published', type: 'boolean', required: false },
            { name: 'userId', type: 'reference', required: true },
          ],
          description: 'Blog posts written by users',
          dependsOn: ['users']
        },
        {
          name: 'comments',
          fields: [
            { name: 'content', type: 'string', required: true },
            { name: 'postId', type: 'reference', required: true },
            { name: 'userId', type: 'reference', required: true },
          ],
          description: 'Comments on posts',
          dependsOn: ['posts', 'users']
        },
        {
          name: 'likes',
          fields: [
            { name: 'postId', type: 'reference', required: true },
            { name: 'userId', type: 'reference', required: true },
          ],
          description: 'Likes on posts',
          dependsOn: ['posts', 'users']
        }
      ],
      relationships: [
        { from: 'posts', to: 'users', type: 'one-to-many', foreignKey: 'userId' },
        { from: 'comments', to: 'posts', type: 'one-to-many', foreignKey: 'postId' },
        { from: 'comments', to: 'users', type: 'one-to-many', foreignKey: 'userId' },
        { from: 'likes', to: 'posts', type: 'one-to-many', foreignKey: 'postId' },
        { from: 'likes', to: 'users', type: 'one-to-many', foreignKey: 'userId' },
      ],
      auth: { enabled: true, signupEnabled: true, loginEnabled: true },
      storage: { enabled: false, buckets: [] },
      userIntent: userMessage,
      isBatchMode: true,
      executionOrder: ['users', 'posts', 'comments', 'likes'],
      summary: 'Create SaaS blog with users, posts, comments, and likes'
    }
  }
  
  // E-commerce template
  if (lower.includes('e-commerce') || lower.includes('ecommerce') || lower.includes('shop')) {
    return {
      entities: [
        {
          name: 'products',
          fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'description', type: 'string', required: false },
            { name: 'price', type: 'number', required: true },
            { name: 'inventory', type: 'number', required: false },
          ],
          description: 'Products for sale',
          dependsOn: []
        },
        {
          name: 'orders',
          fields: [
            { name: 'status', type: 'string', required: true },
            { name: 'total', type: 'number', required: true },
            { name: 'userId', type: 'reference', required: true },
          ],
          description: 'Customer orders',
          dependsOn: ['users']
        },
        {
          name: 'orderItems',
          fields: [
            { name: 'quantity', type: 'number', required: true },
            { name: 'price', type: 'number', required: true },
            { name: 'orderId', type: 'reference', required: true },
            { name: 'productId', type: 'reference', required: true },
          ],
          description: 'Items in each order',
          dependsOn: ['orders', 'products']
        },
        {
          name: 'cart',
          fields: [
            { name: 'quantity', type: 'number', required: true },
            { name: 'userId', type: 'reference', required: true },
            { name: 'productId', type: 'reference', required: true },
          ],
          description: 'Shopping cart items',
          dependsOn: ['users', 'products']
        }
      ],
      relationships: [
        { from: 'orders', to: 'users', type: 'one-to-many', foreignKey: 'userId' },
        { from: 'orderItems', to: 'orders', type: 'one-to-many', foreignKey: 'orderId' },
        { from: 'orderItems', to: 'products', type: 'one-to-many', foreignKey: 'productId' },
        { from: 'cart', to: 'users', type: 'one-to-many', foreignKey: 'userId' },
        { from: 'cart', to: 'products', type: 'one-to-many', foreignKey: 'productId' },
      ],
      auth: { enabled: true, signupEnabled: true, loginEnabled: true },
      storage: { enabled: false, buckets: [] },
      userIntent: userMessage,
      isBatchMode: true,
      executionOrder: ['products', 'users', 'orders', 'orderItems', 'cart'],
      summary: 'Create e-commerce backend with products, orders, cart'
    }
  }
  
  // Chat App template
  if (lower.includes('chat') || lower.includes('messaging')) {
    return {
      entities: [
        {
          name: 'rooms',
          fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'type', type: 'string', required: false },
          ],
          description: 'Chat rooms',
          dependsOn: []
        },
        {
          name: 'messages',
          fields: [
            { name: 'content', type: 'string', required: true },
            { name: 'roomId', type: 'reference', required: true },
            { name: 'userId', type: 'reference', required: true },
          ],
          description: 'Messages in rooms',
          dependsOn: ['rooms', 'users']
        },
        {
          name: 'roomMembers',
          fields: [
            { name: 'role', type: 'string', required: false },
            { name: 'roomId', type: 'reference', required: true },
            { name: 'userId', type: 'reference', required: true },
          ],
          description: 'Users in rooms',
          dependsOn: ['rooms', 'users']
        }
      ],
      relationships: [
        { from: 'messages', to: 'rooms', type: 'one-to-many', foreignKey: 'roomId' },
        { from: 'messages', to: 'users', type: 'one-to-many', foreignKey: 'userId' },
        { from: 'roomMembers', to: 'rooms', type: 'one-to-many', foreignKey: 'roomId' },
        { from: 'roomMembers', to: 'users', type: 'one-to-many', foreignKey: 'userId' },
      ],
      auth: { enabled: true, signupEnabled: true, loginEnabled: true },
      storage: { enabled: false, buckets: [] },
      userIntent: userMessage,
      isBatchMode: true,
      executionOrder: ['users', 'rooms', 'messages', 'roomMembers'],
      summary: 'Create chat app with rooms, messages, and members'
    }
  }
  
  // Task Manager / Project Management template
  if (lower.includes('task') || lower.includes('todo') || lower.includes('project management') || lower.includes('kanban')) {
    return {
      entities: [
        {
          name: 'users',
          fields: [
            { name: 'email', type: 'string', required: true },
            { name: 'name', type: 'string', required: true },
            { name: 'avatar_url', type: 'string', required: false },
          ],
          description: 'User accounts',
          dependsOn: []
        },
        {
          name: 'projects',
          fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'description', type: 'string', required: false },
            { name: 'status', type: 'string', required: false },
            { name: 'color', type: 'string', required: false },
            { name: 'userId', type: 'reference', required: true, referenceTo: 'users' },
          ],
          description: 'Projects owned by users',
          dependsOn: ['users']
        },
        {
          name: 'tasks',
          fields: [
            { name: 'title', type: 'string', required: true },
            { name: 'description', type: 'string', required: false },
            { name: 'status', type: 'string', required: false },
            { name: 'priority', type: 'string', required: false },
            { name: 'completed', type: 'boolean', required: false },
            { name: 'due_date', type: 'date', required: false },
            { name: 'userId', type: 'reference', required: true, referenceTo: 'users' },
            { name: 'projectId', type: 'reference', required: false, referenceTo: 'projects' },
          ],
          description: 'Tasks assigned to users and projects',
          dependsOn: ['users', 'projects']
        },
        {
          name: 'comments',
          fields: [
            { name: 'content', type: 'string', required: true },
            { name: 'taskId', type: 'reference', required: true, referenceTo: 'tasks' },
            { name: 'userId', type: 'reference', required: true, referenceTo: 'users' },
          ],
          description: 'Comments on tasks',
          dependsOn: ['tasks', 'users']
        },
        {
          name: 'labels',
          fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'color', type: 'string', required: false },
            { name: 'projectId', type: 'reference', required: true, referenceTo: 'projects' },
          ],
          description: 'Labels/tags for tasks',
          dependsOn: ['projects']
        },
        {
          name: 'task_labels',
          fields: [
            { name: 'taskId', type: 'reference', required: true, referenceTo: 'tasks' },
            { name: 'labelId', type: 'reference', required: true, referenceTo: 'labels' },
          ],
          description: 'Junction table linking tasks to labels',
          dependsOn: ['tasks', 'labels']
        }
      ],
      relationships: [
        { from: 'projects', to: 'users', type: 'one-to-many', foreignKey: 'userId' },
        { from: 'tasks', to: 'users', type: 'one-to-many', foreignKey: 'userId' },
        { from: 'tasks', to: 'projects', type: 'one-to-many', foreignKey: 'projectId' },
        { from: 'comments', to: 'tasks', type: 'one-to-many', foreignKey: 'taskId' },
        { from: 'comments', to: 'users', type: 'one-to-many', foreignKey: 'userId' },
        { from: 'labels', to: 'projects', type: 'one-to-many', foreignKey: 'projectId' },
        { from: 'task_labels', to: 'tasks', type: 'one-to-many', foreignKey: 'taskId' },
        { from: 'task_labels', to: 'labels', type: 'one-to-many', foreignKey: 'labelId' },
      ],
      auth: { enabled: true, signupEnabled: true, loginEnabled: true },
      storage: { enabled: false, buckets: [] },
      userIntent: userMessage,
      isBatchMode: true,
      executionOrder: ['users', 'projects', 'tasks', 'comments', 'labels', 'task_labels'],
      summary: 'Create task manager with users, projects, tasks, comments, and labels'
    }
  }

  // SaaS Starter template
  if (lower.includes('saas starter') || lower.includes('teams')) {
    return {
      entities: [
        {
          name: 'teams',
          fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'plan', type: 'string', required: false },
          ],
          description: 'Teams/organizations',
          dependsOn: []
        },
        {
          name: 'teamMembers',
          fields: [
            { name: 'role', type: 'string', required: true },
            { name: 'teamId', type: 'reference', required: true },
            { name: 'userId', type: 'reference', required: true },
          ],
          description: 'Users in teams',
          dependsOn: ['teams', 'users']
        },
        {
          name: 'subscriptions',
          fields: [
            { name: 'status', type: 'string', required: true },
            { name: 'plan', type: 'string', required: true },
            { name: 'teamId', type: 'reference', required: true },
          ],
          description: 'Team subscriptions',
          dependsOn: ['teams']
        }
      ],
      relationships: [
        { from: 'teamMembers', to: 'teams', type: 'one-to-many', foreignKey: 'teamId' },
        { from: 'teamMembers', to: 'users', type: 'one-to-many', foreignKey: 'userId' },
        { from: 'subscriptions', to: 'teams', type: 'one-to-many', foreignKey: 'teamId' },
      ],
      auth: { enabled: true, signupEnabled: true, loginEnabled: true },
      storage: { enabled: false, buckets: [] },
      userIntent: userMessage,
      isBatchMode: true,
      executionOrder: ['users', 'teams', 'teamMembers', 'subscriptions'],
      summary: 'Create SaaS starter with teams, billing, and auth'
    }
  }
  
  return null
}

/**
 * Parse EVERYTHING from user prompt at once
 * 
 * This is the CORE of batch mode - extract ALL entities, not just one
 */
export async function parseBatchPlan(userMessage: string): Promise<BatchPlan> {
  console.log('[Batch Planner] 🚀 Parsing complete batch plan from prompt')
  console.log(`[Batch Planner] Input: "${userMessage.substring(0, 200)}..."`)
  
  // PHASE 0.5: TEMPLATE FAST PATH (Zero LLM latency)
  // Check for template patterns first - instant response for common backends
  const templatePlan = matchTemplatePattern(userMessage)
  if (templatePlan) {
    console.log('[Batch Planner] ⚡ Template match - zero LLM latency!')
    return templatePlan
  }
  
  // PHASE 0: POLICY INTENT DETECTION
  // Check for policy intents before entity extraction
  const policyIntent = detectPolicyIntent(userMessage)
  if (policyIntent) {
    console.log('[Batch Planner] ✅ Policy intent detected:', policyIntent)
    
    // Return a batch plan with no entities but with policy metadata
    // The policy will be handled by the execution plan generator
    return {
      entities: [], // No new entities for policy intents
      relationships: [],
      auth: { enabled: false, signupEnabled: false, loginEnabled: false },
      storage: { enabled: false, buckets: [] },
      userIntent: userMessage,
      isBatchMode: true,
      executionOrder: [],
      summary: `Policy: Only ${policyIntent.role} can ${policyIntent.action} ${policyIntent.resource}`,
      // Policy metadata for execution plan generator
      policy: {
        type: 'RBAC_POLICY',
        role: policyIntent.role,
        resource: policyIntent.resource,
        action: policyIntent.action,
        operation: policyIntent.action === 'restrict' ? 'delete' : 'all'
      }
    }
  }
  
  // PHASE 1: DETERMINISTIC INLINE FIELD EXTRACTION
  // Extract fields from patterns like "create X with field1, field2, field3"
  const inlineFields = extractInlineFields(userMessage)
  const entityName = extractEntityName(userMessage)
  
  // PHASE 1.5: RELATIONSHIP DETECTION
  // Detect patterns like "belongs to X", "has many X", "references X"
  const relationships = extractRelationships(userMessage, entityName)
  
  // Add relationship fields to inline fields
  for (const rel of relationships) {
    if (rel.foreignKey) {
      inlineFields.push({
        name: rel.foreignKey,
        type: 'reference',
        required: false,
        referenceTo: rel.to
      })
    }
  }
  
  console.log('[Batch Planner] Deterministic extraction:')
  console.log('[Batch Planner]   Entity:', entityName)
  console.log('[Batch Planner]   Inline fields:', inlineFields.map(f => f.name).join(', ') || '(none)')
  console.log('[Batch Planner]   Relationships:', relationships.length)
  
  // If we have a valid entity name, use deterministic path without LLM
  // This handles: "add payments table" → creates payments with default fields
  if (entityName) {
    console.log('[Batch Planner] ✅ Using deterministic extraction (no LLM needed)')
    
    // For simple table creation without explicit fields, add smart defaults
    let finalFields = inlineFields
    if (inlineFields.length === 0) {
      // Add default fields based on common patterns
      finalFields = getDefaultFieldsForEntity(entityName)
      console.log('[Batch Planner]   Added default fields:', finalFields.map(f => f.name).join(', '))
    }
    
    // Convert extracted relationships to batch relationships
    const batchRelationships: BatchRelationship[] = relationships.map(rel => ({
      from: rel.from,
      to: rel.to,
      type: rel.type === 'many-to-one' ? 'one-to-many' : rel.type,
      foreignKey: rel.foreignKey
    }))
    
    return {
      entities: [{
        name: entityName,
        fields: finalFields,
        description: `${entityName} table with ${finalFields.length} fields`,
        dependsOn: relationships.filter(r => r.foreignKey).map(r => r.to) // Depend on referenced entities
      }],
      relationships: batchRelationships,
      auth: { enabled: false, signupEnabled: false, loginEnabled: false },
      storage: { enabled: false, buckets: [] },
      userIntent: userMessage,
      isBatchMode: true,
      executionOrder: [entityName],
      summary: `Create ${entityName} table${finalFields.length > 0 ? ' with ' + finalFields.map(f => f.name).join(', ') : ''}`
    }
  }
  
  // PHASE 1: LLM-BASED PLANNING (fallback for complex cases)
  // INTEGRATION MODE: Skip LLM entirely, use deterministic extraction
  if (process.env.ENGINE_MODE === 'integration') {
    console.log('[Batch Planner] 🔧 INTEGRATION MODE - Using deterministic extraction (no LLM)')
    
    // Better fallback: Try harder to extract entity name
    let finalEntityName = entityName
    if (!finalEntityName) {
      // Try to extract from first word that looks like a plural noun
      const words = userMessage.toLowerCase().match(/\b\w+s\b/g)
      if (words && words.length > 0) {
        // Take first plural word that's not a common word
        const commonWords = ['users', 'this', 'has', 'was', 'is', 'as']
        finalEntityName = words.find(w => !commonWords.includes(w)) || 'items'
      } else {
        finalEntityName = 'entity'
      }
    }
    
    // Better fallback for fields: at least try to extract some meaningful fields
    let finalFields = inlineFields
    if (finalFields.length === 0) {
      console.log('[Batch Planner] No inline fields found, checking for implicit field mentions')
      // Look for common field keywords in the message
      const fieldKeywords = ['name', 'title', 'email', 'description', 'price', 'amount', 'status']
      const foundFields: ExtractedField[] = []
      
      for (const keyword of fieldKeywords) {
        if (userMessage.toLowerCase().includes(keyword)) {
          foundFields.push({
            name: keyword,
            type: inferTypeFromName(keyword),
            required: keyword === 'name' || keyword === 'title'
          })
        }
      }
      
      // If we found any implicit fields, use them; otherwise use minimal fallback
      finalFields = foundFields.length > 0 
        ? foundFields 
        : [{ name: 'name', type: 'string' as const, required: true }]
    }
    
    // Convert extracted relationships to batch relationships
    const batchRelationships: BatchRelationship[] = relationships.map(rel => ({
      from: rel.from,
      to: rel.to,
      type: rel.type === 'many-to-one' ? 'one-to-many' : rel.type,
      foreignKey: rel.foreignKey
    }))
    
    console.log('[Batch Planner] Integration mode result:')
    console.log('[Batch Planner]   Entity:', finalEntityName)
    console.log('[Batch Planner]   Fields:', finalFields.map(f => f.name).join(', '))
    
    return {
      entities: [{
        name: finalEntityName,
        fields: finalFields,
        description: `${finalEntityName} table with ${finalFields.length} fields`,
        dependsOn: relationships.filter(r => r.foreignKey).map(r => r.to)
      }],
      relationships: batchRelationships,
      auth: { enabled: false, signupEnabled: false, loginEnabled: false },
      storage: { enabled: false, buckets: [] },
      userIntent: userMessage,
      isBatchMode: true,
      executionOrder: [finalEntityName],
      summary: `Create ${finalEntityName} table with ${finalFields.map(f => f.name).join(', ')}`
    }
  }
  
  console.log('[Batch Planner] 🧠 Falling back to LLM planning')
  
  const openai = getOpenAIClient()
  
  const systemPrompt = `You are Backenly's Intent Specification Generator.

**CRITICAL: You MUST output a complete IntentSpec JSON. This is NON-NEGOTIABLE.**

**ENTITY EXTRACTION MANDATE:**
Extract EVERY entity/table implied by the user prompt. A complex backend prompt may describe 5-15+ entities — you MUST identify and include ALL of them.

**What counts as an entity (always create a table for these):**
- Any explicit noun the user names: users, products, orders, workspaces, teams, subscriptions, notifications, roles, invitations, attachments, activities, comments, labels, etc.
- Any junction/pivot table needed for many-to-many relationships
- Any entity implied by ownership patterns: "users belong to workspaces" → workspaces entity

**COMPLETENESS RULE:**
If the user describes a complex system (multiple nouns, multi-feature prompt), you MUST output ALL entities. A 10-entity prompt should produce 10 entities. NEVER truncate to 3-5 entities when more are described.

**EXAMPLES:**
✅ "Build a project management SaaS with workspaces, teams, projects, tasks, comments, labels, notifications" → 7+ entities
✅ "I need a platform with users, subscriptions, billing, roles, audit logs" → 5+ entities
✅ "Users create projects and tasks" → entities: [users, projects, tasks]

**RULE: If in doubt, include the entity. Missing entities break the user's backend. Extra entities can be removed later.**

## YOUR JOB (Explicit, Not Implicit)

You are NOT inferring rules.
You are NOT detecting patterns.
You are NOT guessing.

You are **DECLARING** what the system will build.

## FIELD EXTRACTION MANDATE (CRITICAL)

When a user describes a table creation using natural language such as:
"create a products table with name, price, and stock quantity"

You MUST extract every mentioned business field.

**Extraction Rules:**
1. If the sentence includes a list after "with", treat it as field definitions
2. If a field type is not specified, infer it conservatively:
   - name, title, description, email → string
   - price, amount, cost → decimal
   - count, quantity, number, age → number
   - active, enabled, verified → boolean
   - date, time, at → timestamp
3. NEVER ignore inline field lists
4. It is INVALID to create a table with empty fields if the user mentioned field names

**Example Mapping:**

User Input: "create a products table with name, price, and stock quantity"

Expected Output:
{
  "entities": [
    {
      "name": "products",
      "fields": [
        { "name": "name", "type": "string" },
        { "name": "price", "type": "decimal" },
        { "name": "stock_quantity", "type": "number" }
      ]
    }
  ]
}

## RELATIONSHIP MANDATE (CRITICAL — NON-NEGOTIABLE)

When multiple entities are created together and one clearly "belongs to" or "is owned by" another, you MUST add FK reference fields on the child entity. This is NOT optional.

**Rules:**
1. If entity B belongs to entity A → entity B MUST have a field: { "name": "<singular_A>Id", "type": "reference", "required": true, "referenceTo": "<A>" }
2. These FK fields must ALWAYS be included even if the user didn't mention them — infer from the relationship
3. Set "dependsOn" on the child entity to list the parent entity name

**Common patterns you MUST always apply:**
- tasks → MUST have userId (referenceTo: "users") and any other obvious parent (e.g., projectId if projects exist)
- comments → MUST have userId (referenceTo: "users") and postId/articleId etc.
- posts/articles → MUST have userId (referenceTo: "users")
- orders → MUST have userId (referenceTo: "users")
- messages → MUST have senderId (referenceTo: "users")
- Any child entity → MUST reference its logical parent(s)

**Example — "build a task manager with users, projects, tasks":**

WRONG (no FK fields):
{ "name": "tasks", "fields": [{ "name": "title", "type": "string" }], "dependsOn": [] }

CORRECT (FK fields added):
{
  "name": "tasks",
  "fields": [
    { "name": "title", "type": "string", "required": true },
    { "name": "userId", "type": "reference", "required": true, "referenceTo": "users" },
    { "name": "projectId", "type": "reference", "required": true, "referenceTo": "projects" }
  ],
  "dependsOn": ["users", "projects"]
}

**RULE: Never create a child entity without its parent FK reference fields. If in doubt, add the FK.**



## OUTPUT STRUCTURE (ALL FIELDS REQUIRED)

{
  "entities": [...],
  "actions": [...],
  "invariants": {
    "uniqueness": [],
    "ownership": [],
    "readIsolation": [],
    "quotas": [],
    "tierGating": [],
    "stateMachines": [],
    "capacityLimits": [],
    "conflictDetection": [],
    "softDelete": [],
    "derivedFields": [],
    "sideEffects": [],
    "accessRules": [],
    "storagePermissions": []
  },
  "auth": {
    "enabled": boolean,
    "providers": [],
    "signupEnabled": boolean,
    "loginEnabled": boolean
  },
  "storage": {
    "enabled": boolean,
    "buckets": []
  },
  "summary": "Human-readable description"
}

## RULES FOR INVARIANTS (CRITICAL)

1. **Empty arrays are ALLOWED** - If no such invariant exists, return []
2. **Missing fields are FORBIDDEN** - All 12 invariant types MUST be present
3. **Explicit enumeration ONLY** - No post-hoc inference
4. **Silence ≠ false** - If not mentioned, return empty array

## INVARIANT DETECTION PATTERNS

### uniqueness
Phrase: "one vote per user per idea" | "user can like only once" | "one booking per user"
Output:
{
  "entity": "votes",
  "fields": ["idea_id", "user_id"],
  "reason": "One vote per user per idea"
}

### ownership
Phrase: "users can edit only their own posts" | "only creator can delete"
Output:
{
  "entity": "posts",
  "field": "created_by",
  "writeProtection": true,
  "reason": "Ownership enforcement"
}

### readIsolation
Phrase: "private notes" | "users see only their own" | "each user's data isolated"
Output:
{
  "entity": "notes",
  "field": "created_by",
  "reason": "Privacy critical"
}

### quotas
Phrase: "free users can create only 3 ideas" | "paid unlimited"
Output:
{
  "entity": "ideas",
  "tier": "free",
  "limit": 3,
  "action": "create",
  "reason": "Free tier limit"
}

### tierGating
Phrase: "only paid users can read full articles" | "premium content"
Output:
{
  "entity": "articles",
  "tier": "free",
  "allowedOperations": [],
  "blockedFields": ["content"],
  "reason": "Premium content"
}

### stateMachines
Phrase: "draft then published then sold" | "once sold, never purchasable" | "products start as X, become Y, end as Z" | "published can't go back to draft"
Pattern: Lifecycle workflows with one-way transitions between states.
Output:
{
  "entity": "products",
  "field": "status",
  "states": [
    { "name": "draft", "allowedTransitions": ["published"], "isTerminal": false },
    { "name": "published", "allowedTransitions": ["sold"], "isTerminal": false },
    { "name": "sold", "allowedTransitions": [], "isTerminal": true }
  ],
  "reason": "Product lifecycle enforcement"
}

### capacityLimits
Phrase: "max 100 seats" | "never oversell" | "waitlist when full" | "once event is full" | "maximum bookings"
Pattern: Physical capacity constraints with overflow handling.
Output:
{
  "entity": "events",
  "field": "max_seats",
  "checkField": "current_bookings",
  "onExceeded": "waitlist",
  "reason": "Prevent overselling event capacity"
}

### conflictDetection
Phrase: "no overlapping time slots" | "prevent double booking" | "provider can't have conflicts" | "ranges can't overlap"
Pattern: Temporal or spatial overlap prevention within a scope.
Output:
{
  "entity": "time_slots",
  "type": "time_overlap",
  "fields": ["start_time", "end_time"],
  "scope": "provider_id",
  "reason": "Prevent provider double-booking"
}

### softDelete
Phrase: "if user deletes account, comments remain" | "show Deleted User" | "name replaced" | "preserve content"
Pattern: Content preservation + identity anonymization on user deletion.

**SEMANTIC NORMALIZATION:**
If the prompt contains 2+ of these signals:
- User account deletion mentioned
- Content/posts/comments "remain" or "preserve" or "should remain"
- Name/email "replaced" or "anonymized" or "hidden"
- "Deleted User" or "Anonymous" mentioned

Then this is a softDelete invariant, regardless of exact wording.

Output:
{
  "entity": "users",
  "anonymizeFields": ["name", "email"],
  "replacement": "Deleted User",
  "reason": "Preserve content when user is deleted"
}
}

### derivedFields
Phrase: "like counts always accurate" | "show post like count"
Output:
{
  "entity": "posts",
  "name": "like_count",
  "sourceEntity": "likes",
  "aggregation": "count",
  "reason": "Auto-calculated"
}

### sideEffects
Phrase: "when upvoted, author gains reputation" | "when answer upvoted, increase user rep" | "cannot vote on own content" | "reputation updates automatically" | "voting affects author"
Pattern: Cross-entity automatic updates triggered by actions on related entities.
Output:
{
  "entity": "votes",
  "trigger": "create",
  "targetEntity": "users",
  "targetField": "reputation",
  "operation": "increment",
  "value": 10,
  "condition": "vote_type = 'upvote'",
  "preventSelfAction": true,
  "reason": "Auto-increment author reputation on upvotes"
}

### accessRules (aka tierGating for data access)
Phrase: "only enrolled users can access lessons" | "only course members see content" | "enrolled students only" | "requires enrollment to view"
Pattern: Access gates based on relationships or membership.
If the prompt mentions "only X can read/access Y" where X is determined by a relationship:
Output:
{
  "entity": "lessons",
  "requiredRelationship": "enrollments",
  "accessCondition": "user must be enrolled in course",
  "reason": "Lesson access restricted to enrolled students"
}

NOTE: If "only paid users can read full content" → use tierGating instead.
If "only enrolled users can access" → use accessRules (relationship-based).

### storagePermissions
Phrase: "only uploader can delete file" | "shared users download only"
Output:
{
  "entity": "files",
  "ownershipField": "uploaded_by",
  "deleteRequiresOwnership": true,
  "reason": "File ownership"
}

## EXAMPLE COMPLETE OUTPUT

User: "I want a voting app. Users can vote on ideas. A user can vote only once per idea."

Output:
{
  "entities": [
    {
      "name": "users",
      "description": "User accounts",
      "fields": [
        { "name": "email", "type": "string", "required": true, "unique": true },
        { "name": "password", "type": "string", "required": true }
      ]
    },
    {
      "name": "ideas",
      "description": "Ideas to vote on",
      "fields": [
        { "name": "title", "type": "string", "required": true },
        { "name": "description", "type": "string", "required": true }
      ]
    },
    {
      "name": "votes",
      "description": "User votes on ideas",
      "fields": [
        { "name": "idea_id", "type": "reference", "required": true, "referenceTo": "ideas" },
        { "name": "user_id", "type": "reference", "required": true, "referenceTo": "users" }
      ]
    }
  ],
  "actions": [
    { "entity": "users", "operation": "create", "requiresAuth": false, "description": "Sign up" },
    { "entity": "ideas", "operation": "create", "requiresAuth": true, "description": "Create idea" },
    { "entity": "votes", "operation": "create", "requiresAuth": true, "description": "Vote on idea" }
  ],
  "invariants": {
    "uniqueness": [
      {
        "entity": "votes",
        "fields": ["idea_id", "user_id"],
        "reason": "One vote per user per idea"
      }
    ],
    "ownership": [],
    "readIsolation": [],
    "quotas": [],
    "tierGating": [],
    "stateMachines": [],
    "capacityLimits": [],
    "conflictDetection": [],
    "softDelete": [],
    "derivedFields": [],
    "sideEffects": [],
    "accessRules": [],
    "storagePermissions": []
  },
  "auth": {
    "enabled": true,
    "providers": ["email"],
    "signupEnabled": true,
    "loginEnabled": true
  },
  "storage": {
    "enabled": false,
    "buckets": []
  },
  "summary": "Voting app with uniqueness constraint enforcement"
}

**REMEMBER: You are DECLARING contracts, not inferring patterns. Empty arrays are valid. Missing fields are errors.**

## COMPLETE WORKING EXAMPLES FOR COMPLEX INVARIANTS

### Example 1: State Machine (Product Lifecycle)
User: "I want to sell products. Products start as draft, then can be published, then sold. Once sold, they cannot be purchased again."

Output:
{
  "entities": [
    { "name": "products", "description": "Products for sale", "fields": [
      { "name": "title", "type": "string", "required": true },
      { "name": "status", "type": "string", "required": true }
    ]}
  ],
  "actions": [
    { "entity": "products", "operation": "create", "requiresAuth": true, "description": "Create draft product" },
    { "entity": "products", "operation": "update", "requiresAuth": true, "description": "Publish or mark sold" }
  ],
  "invariants": {
    "uniqueness": [],
    "ownership": [],
    "readIsolation": [],
    "quotas": [],
    "tierGating": [],
    "stateMachines": [{
      "entity": "products",
      "field": "status",
      "states": [
        { "name": "draft", "allowedTransitions": ["published"], "isTerminal": false },
        { "name": "published", "allowedTransitions": ["sold"], "isTerminal": false },
        { "name": "sold", "allowedTransitions": [], "isTerminal": true }
      ],
      "reason": "Product lifecycle state machine"
    }],
    "capacityLimits": [],
    "conflictDetection": [],
    "softDelete": [],
    "derivedFields": [],
    "sideEffects": [],
    "accessRules": [],
    "storagePermissions": []
  },
  "auth": { "enabled": true, "providers": ["email"], "signupEnabled": true, "loginEnabled": true },
  "storage": { "enabled": false, "buckets": [] },
  "summary": "Product selling with state machine enforcement"
}

### Example 2: Tier Gating (Premium Content)
User: "I want to publish articles. Anyone can see titles. Only paid users can read full content."

Output:
{
  "entities": [
    { "name": "users", "description": "Users", "fields": [
      { "name": "email", "type": "string", "required": true },
      { "name": "tier", "type": "string", "required": true }
    ]},
    { "name": "articles", "description": "Articles", "fields": [
      { "name": "title", "type": "string", "required": true },
      { "name": "content", "type": "string", "required": true }
    ]}
  ],
  "actions": [
    { "entity": "articles", "operation": "create", "requiresAuth": true, "description": "Create article" },
    { "entity": "articles", "operation": "read", "requiresAuth": false, "description": "Read articles" }
  ],
  "invariants": {
    "uniqueness": [],
    "ownership": [],
    "readIsolation": [],
    "quotas": [],
    "tierGating": [{
      "entity": "articles",
      "tier": "free",
      "allowedOperations": ["read"],
      "blockedFields": ["content"],
      "reason": "Free users see title only, paid users see full content"
    }],
    "stateMachines": [],
    "capacityLimits": [],
    "conflictDetection": [],
    "softDelete": [],
    "derivedFields": [],
    "sideEffects": [],
    "accessRules": [],
    "storagePermissions": []
  },
  "auth": { "enabled": true, "providers": ["email"], "signupEnabled": true, "loginEnabled": true },
  "storage": { "enabled": false, "buckets": [] },
  "summary": "Article platform with tier-based access control"
}

### Example 3: Conflict Detection (Time Slot Overlaps)
User: "Providers create time slots. A provider should never have overlapping time slots."

Output:
{
  "entities": [
    { "name": "providers", "description": "Service providers", "fields": [
      { "name": "name", "type": "string", "required": true }
    ]},
    { "name": "time_slots", "description": "Available time slots", "fields": [
      { "name": "provider_id", "type": "reference", "required": true, "referenceTo": "providers" },
      { "name": "start_time", "type": "datetime", "required": true },
      { "name": "end_time", "type": "datetime", "required": true }
    ]}
  ],
  "actions": [
    { "entity": "time_slots", "operation": "create", "requiresAuth": true, "description": "Create slot" }
  ],
  "invariants": {
    "uniqueness": [],
    "ownership": [],
    "readIsolation": [],
    "quotas": [],
    "tierGating": [],
    "stateMachines": [],
    "capacityLimits": [],
    "conflictDetection": [{
      "entity": "time_slots",
      "type": "time_overlap",
      "fields": ["start_time", "end_time"],
      "scope": "provider_id",
      "reason": "Prevent provider double-booking"
    }],
    "softDelete": [],
    "derivedFields": [],
    "sideEffects": [],
    "accessRules": [],
    "storagePermissions": []
  },
  "auth": { "enabled": true, "providers": ["email"], "signupEnabled": true, "loginEnabled": true },
  "storage": { "enabled": false, "buckets": [] },
  "summary": "Time slot booking with conflict detection"
}

### Example 4: Side Effects (Reputation System)
User: "Q&A platform. When answer is upvoted, author gains reputation. Users cannot vote on their own answers."

Output:
{
  "entities": [
    { "name": "users", "description": "Users", "fields": [
      { "name": "email", "type": "string", "required": true },
      { "name": "reputation", "type": "number", "required": true }
    ]},
    { "name": "answers", "description": "Answers", "fields": [
      { "name": "content", "type": "string", "required": true },
      { "name": "author_id", "type": "reference", "required": true, "referenceTo": "users" }
    ]},
    { "name": "votes", "description": "Votes on answers", "fields": [
      { "name": "answer_id", "type": "reference", "required": true, "referenceTo": "answers" },
      { "name": "user_id", "type": "reference", "required": true, "referenceTo": "users" },
      { "name": "vote_type", "type": "string", "required": true }
    ]}
  ],
  "actions": [
    { "entity": "votes", "operation": "create", "requiresAuth": true, "description": "Vote on answer" }
  ],
  "invariants": {
    "uniqueness": [],
    "ownership": [],
    "readIsolation": [],
    "quotas": [],
    "tierGating": [],
    "stateMachines": [],
    "capacityLimits": [],
    "conflictDetection": [],
    "softDelete": [],
    "derivedFields": [],
    "sideEffects": [{
      "entity": "votes",
      "trigger": "create",
      "targetEntity": "users",
      "targetField": "reputation",
      "operation": "increment",
      "value": 10,
      "condition": "vote_type = 'upvote'",
      "preventSelfAction": true,
      "reason": "Auto-increment author reputation on upvotes"
    }],
    "accessRules": [],
    "storagePermissions": []
  },
  "auth": { "enabled": true, "providers": ["email"], "signupEnabled": true, "loginEnabled": true },
  "storage": { "enabled": false, "buckets": [] },
  "summary": "Q&A platform with reputation system"
}

### Example 5: Storage Permissions (File Ownership)
User: "Users upload files. Only the uploader can delete a file. Shared users can only download."

Output:
{
  "entities": [
    { "name": "users", "description": "Users", "fields": [
      { "name": "email", "type": "string", "required": true }
    ]},
    { "name": "files", "description": "Uploaded files", "fields": [
      { "name": "name", "type": "string", "required": true },
      { "name": "uploaded_by", "type": "reference", "required": true, "referenceTo": "users" },
      { "name": "shared_with", "type": "string", "required": false }
    ]}
  ],
  "actions": [
    { "entity": "files", "operation": "create", "requiresAuth": true, "description": "Upload file" },
    { "entity": "files", "operation": "delete", "requiresAuth": true, "description": "Delete file" }
  ],
  "invariants": {
    "uniqueness": [],
    "ownership": [],
    "readIsolation": [],
    "quotas": [],
    "tierGating": [],
    "stateMachines": [],
    "capacityLimits": [],
    "conflictDetection": [],
    "softDelete": [],
    "derivedFields": [],
    "sideEffects": [],
    "accessRules": [],
    "storagePermissions": [{
      "entity": "files",
      "ownershipField": "uploaded_by",
      "sharedWith": "shared_with",
      "deleteRequiresOwnership": true,
      "reason": "Only uploader can delete, shared users can download"
    }]
  },
  "auth": { "enabled": true, "providers": ["email"], "signupEnabled": true, "loginEnabled": true },
  "storage": { "enabled": true, "buckets": ["files"] },
  "summary": "File sharing with ownership-based permissions"
}

**CRITICAL: Use these examples as templates. When you see similar patterns in the user prompt, output the corresponding invariant structure.**`

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3, // Slightly increased for better pattern recognition
      max_tokens: 6000, // Increased for complex schemas
      response_format: { type: 'json_object' },
    })

    const rawContent = response.choices[0].message.content || '{}'
    const intentSpec: IntentSpec = JSON.parse(rawContent)

    // DEBUG: Log extracted entities and fields
    console.log('[Batch Planner] Extracted IntentSpec:')
    console.log('[Batch Planner] Entities:', intentSpec.entities?.map((e: any) => ({
      name: e.name,
      fieldCount: e.fields?.length || 0,
      fields: e.fields?.map((f: any) => f.name)
    })))

    // STEP 1: Validate IntentSpec (DETERMINISTIC)
    console.log('[Intent Spec] Validating spec structure...')
    const validation = validateIntentSpec(intentSpec)
    
    if (!validation.valid) {
      console.error('[Intent Spec] ❌ VALIDATION FAILED')
      console.error('[Refusal Guarantee] Backenly refuses to proceed with incomplete specification')
      validation.errors.forEach(err => console.error(`  - ${err}`))
      
      // REFUSAL GUARANTEE ENFORCEMENT
      // "If Backenly is unsure, it will refuse and ask for clarity — it will never guess."
      // This is NOT a limitation. This is a SAFETY GUARANTEE.
      
      console.error('[Refusal Guarantee] ❌ EXECUTION BLOCKED')
      console.error('[Refusal Guarantee] Reason: Incomplete or ambiguous specification')
      console.error('[Refusal Guarantee] Action Required: User must clarify requirements')
      
      return {
        entities: [],
        relationships: [],
        auth: { enabled: false, signupEnabled: false, loginEnabled: false },
        storage: { enabled: false, buckets: [] },
        userIntent: userMessage,
        isBatchMode: true,
        executionOrder: [],
        summary: `⚠️ REFUSED: Specification incomplete. ${validation.errors.join('. ')}. Please clarify your requirements.`,
      }
    }
    
    if (validation.warnings.length > 0) {
      console.warn('[Intent Spec] ⚠️  WARNINGS:')
      validation.warnings.forEach(warn => console.warn(`  - ${warn}`))
    }
    
    console.log('[Intent Spec] ✅ Validation passed')
    
    // Log invariant counts (for debugging)
    const invariantCounts = Object.entries(intentSpec.invariants).map(([key, val]) => 
      `${key}: ${Array.isArray(val) ? val.length : 0}`
    ).join(', ')
    console.log(`[Intent Spec] Invariants: ${invariantCounts}`)
    
    // STEP 2: Convert IntentSpec to BatchPlan (DETERMINISTIC)
    const plan = intentSpecToBatchPlan(intentSpec)

    // STEP 2.5: AUTH AUTO-ENABLE
    // If the plan has a users entity and the prompt implies authentication
    // (or any users table exists), force auth.enabled = true.
    // The LLM sometimes forgets to set this even when it's clearly needed.
    if (!plan.auth.enabled) {
      const hasUsersEntity = plan.entities.some(e => e.name.toLowerCase() === 'users')
      const lower = userMessage.toLowerCase()
      const impliesAuth = hasUsersEntity && (
        lower.includes('auth') || lower.includes('login') || lower.includes('sign') ||
        lower.includes('register') || lower.includes('user') || lower.includes('saas') ||
        lower.includes('account') || lower.includes('password') || lower.includes('jwt')
      )
      if (impliesAuth) {
        plan.auth = { enabled: true, signupEnabled: true, loginEnabled: true }
        console.log('[Batch Planner] ✅ Auth auto-enabled (users entity + auth keywords detected)')
      }
    }

    console.log(`[Batch Planner] ✅ Parsed ${plan.entities.length} entities`)
    console.log(`[Batch Planner] ✅ Found ${plan.relationships.length} relationships`)
    console.log(`[Batch Planner] ✅ Auth: ${plan.auth.enabled ? 'YES' : 'NO'}`)
    console.log(`[Batch Planner] ✅ Storage: ${plan.storage.enabled ? 'YES' : 'NO'}`)

    plan.entities.forEach((e, i) => {
      console.log(`[Batch Planner]   ${i + 1}. ${e.name} (${e.fields.length} fields)`)
    })

    return plan
  } catch (error) {
    console.error('[Batch Planner] ❌ Failed to parse batch plan:', error)
    
    // Fallback: return empty plan
    return {
      entities: [],
      relationships: [],
      auth: { enabled: false, signupEnabled: false, loginEnabled: false },
      storage: { enabled: false, buckets: [] },
      userIntent: userMessage,
      isBatchMode: true,
      executionOrder: [],
      summary: 'No entities found to build',
    }
  }
}

/**
 * Convert batch plan to multiple canonical intents
 * 
 * This bridges batch mode to the existing execution system
 * 
 * EXECUTION ORDER:
 * 1. Storage buckets FIRST (before tables that might reference them)
 * 2. Tables in topological order (dependencies first)
 * 3. Auth AFTER users table exists
 * 4. APIs LAST (after all tables exist)
 */
export function batchPlanToIntents(plan: BatchPlan): CanonicalIntent[] {
  const intents: CanonicalIntent[] = []
  const timestamp = new Date().toISOString()
  let executionPriority = 0

  // STEP 0: Handle policy intents FIRST
  if (plan.policy) {
    console.log('[Batch Planner] Generating policy intent:', plan.policy)
    intents.push({
      intent_type: 'ACCESS_CONTROL',
      domain: 'AUTH',
      action: plan.policy.action === 'restrict' ? 'RESTRICT' : 'ALLOW',
      target: plan.policy.resource,
      feature: 'RBAC_POLICY',
      constraints: {
        role: plan.policy.role,
        resource: plan.policy.resource,
        operation: plan.policy.operation,
        isPolicy: true,
        executionPriority: executionPriority++,
      },
      source_text: plan.userIntent,
      timestamp: `${timestamp}_policy`,
      confidence: 0.95,
      status: 'COMMITTED',
    })
  }

  // STEP 1: Add storage intents FIRST (priority 0-99)
  if (plan.storage.enabled) {
    plan.storage.buckets.forEach((bucket, index) => {
      intents.push({
        intent_type: 'FEATURE_ADD',
        domain: 'STORAGE',
        action: 'ENABLE',
        target: bucket,
        feature: 'FILE_UPLOAD',
        constraints: {
          isPublic: false,
          maxSize: '10MB',
          executionPriority: executionPriority++, // 0, 1, 2...
        },
        source_text: `Enable file storage for ${bucket}`,
        timestamp: `${timestamp}_storage_${index}`,
        confidence: 0.95,
        status: 'COMMITTED',
      })
    })
  }

  // STEP 2: Create intents for each entity IN TOPOLOGICAL ORDER (priority 100+)
  executionPriority = 100
  plan.executionOrder.forEach((entityName) => {
    const entity = plan.entities.find(e => e.name === entityName)
    if (!entity) return
    
    intents.push({
      intent_type: 'DATA_MODEL_ADD',
      domain: 'DATABASE',
      action: 'CREATE',
      target: entity.name,
      feature: undefined,
      constraints: {
        fields: entity.fields,
        description: entity.description,
        executionPriority: executionPriority++, // 100, 101, 102...
        // PRODUCTION-GRADE INVARIANTS: Pass ALL through to execution (1-15)
        uniqueConstraints: entity.uniqueConstraints,
        quotas: entity.quotas,
        ownership: entity.ownership,
        readIsolation: entity.readIsolation,
        softDelete: entity.softDelete,
        capacityLimits: entity.capacityLimits,
        stateMachine: entity.stateMachine,
        tierGating: entity.tierGating,
        conflictDetection: entity.conflictDetection,
        derivedFields: entity.derivedFields,
        sideEffects: entity.sideEffects,
        accessRules: entity.accessRules,
        storagePermissions: entity.storagePermissions,
      },
      source_text: `Create ${entity.name} table`,
      timestamp: `${timestamp}_entity_${entityName}`,
      confidence: 0.95,
      status: 'COMMITTED', // Auto-commit batch intents
    })
  })

  // STEP 3: Add auth intent AFTER tables (priority 200+)
  if (plan.auth.enabled) {
    executionPriority = 200
    intents.push({
      intent_type: 'FEATURE_ADD',
      domain: 'AUTH',
      action: 'ENABLE',
      target: 'users',
      feature: 'EMAIL_SIGN_IN',
      constraints: {
        provider: 'email', // CRITICAL: Must specify provider for generateAuthSteps
        signupEnabled: plan.auth.signupEnabled,
        loginEnabled: plan.auth.loginEnabled,
        executionPriority: executionPriority++, // 200
      },
      source_text: 'Enable authentication',
      timestamp: `${timestamp}_auth`,
      confidence: 0.95,
      status: 'COMMITTED',
    })
  }

  // STEP 4: Generate ACTION-BASED API endpoints for each entity (priority 300+)
  // CRITICAL: This derives specific actions from the user's intent, NOT generic CRUD
  executionPriority = 300
  plan.entities.forEach((entity, index) => {
    // Derive action-based endpoints from entity and relationships
    const endpoints: any[] = []
    
    // Basic read operations (safe, always enabled)
    endpoints.push(
      {
        method: 'GET',
        path: '',
        enabled: true,
        auth: false,
        description: `List all ${entity.name}`
      },
      {
        method: 'GET',
        path: '/:id',
        enabled: true,
        auth: false,
        description: `Get single ${entity.name.slice(0, -1)}`
      }
    )
    
    // Write operations (require auth)
    endpoints.push(
      {
        method: 'POST',
        path: '',
        enabled: true,
        auth: true,
        description: `Create new ${entity.name.slice(0, -1)}`
      },
      {
        method: 'PATCH',
        path: '/:id',
        enabled: true,
        auth: true,
        description: `Update ${entity.name.slice(0, -1)}`
      },
      {
        method: 'DELETE',
        path: '/:id',
        enabled: true,
        auth: true,
        description: `Delete ${entity.name.slice(0, -1)}`
      }
    )
    
    // Action-based endpoints for specific entities
    if (entity.name === 'posts') {
      // Find if likes/comments exist
      const hasLikes = plan.entities.some(e => e.name === 'likes')
      const hasComments = plan.entities.some(e => e.name === 'comments')
      
      if (hasLikes) {
        endpoints.push(
          {
            method: 'POST',
            path: '/:id/like',
            enabled: true,
            auth: true,
            description: 'Like a post (once per user)'
          },
          {
            method: 'DELETE',
            path: '/:id/like',
            enabled: true,
            auth: true,
            description: 'Unlike a post'
          }
        )
      }
      
      if (hasComments) {
        endpoints.push({
          method: 'POST',
          path: '/:id/comments',
          enabled: true,
          auth: true,
          description: 'Add comment to post'
        })
      }
    }
    
    if (entity.name === 'users') {
      // User-specific actions
      if (plan.auth.enabled) {
        endpoints.push(
          {
            method: 'POST',
            path: '/signup',
            enabled: true,
            auth: false,
            description: 'User registration'
          },
          {
            method: 'POST',
            path: '/login',
            enabled: true,
            auth: false,
            description: 'User login'
          },
          {
            method: 'GET',
            path: '/me',
            enabled: true,
            auth: true,
            description: 'Get current user profile'
          },
          {
            method: 'PATCH',
            path: '/me',
            enabled: true,
            auth: true,
            description: 'Update current user profile'
          }
        )
      }
      
      // Upload profile picture if storage enabled
      if (plan.storage.enabled) {
        endpoints.push({
          method: 'POST',
          path: '/me/avatar',
          enabled: true,
          auth: true,
          description: 'Upload profile picture'
        })
      }
    }
    
    // Create FEATURE_ADD intent for API generation
    intents.push({
      intent_type: 'FEATURE_ADD',
      domain: 'API',
      action: 'CREATE',
      target: entity.name,
      feature: 'CUSTOM_ENDPOINTS',
      constraints: {
        tableName: entity.name,
        basePath: `/${entity.name}`,
        customEndpoints: endpoints,
        operations: {
          list: false,
          get: false,
          create: false,
          update: false,
          delete: false,
          search: false,
          bulk: false,
        },
        executionPriority: executionPriority++, // 300, 301, 302...
      },
      source_text: `Generate action-based API for ${entity.name}`,
      timestamp: `${timestamp}_api_${entity.name}`,
      confidence: 0.95,
      status: 'COMMITTED',
    })
  })

  return intents
}

/**
 * Check if prompt should use batch mode
 * 
 * Batch mode is DEFAULT unless explicitly incremental
 */
/**
 * Determines if batch mode should be used
 * 
 * NEW PHILOSOPHY (Post-IntentSpec):
 * Batch mode is the DEFAULT for product intents.
 * Incremental mode is ONLY for follow-up edits on existing backends.
 * 
 * Users don't think in entities. They think in products.
 * "I want to sell products" = product intent → batch mode
 * "Also add reviews" = incremental intent → incremental mode
 * 
 * ⚠️  FROZEN v1.0 - DO NOT MODIFY WITHOUT ARCHITECTURAL REVIEW
 * This routing logic achieved 15/15 (100%) test pass rate.
 * Any changes risk breaking deterministic behavior.
 * 
 * DO NOT:
 * - Add more domain keywords aggressively
 * - Try fuzzy matching or ML-based classification
 * - Optimize for edge cases
 * - Add configuration toggles
 * 
 * This is the CORRECT STOPPING POINT for v1.
 */
export function shouldUseBatchMode(userMessage: string, graph: BackendStateGraph): boolean {
  const lower = userMessage.toLowerCase()

  // Rule 0: Storage/auth feature requests are single-intent — bypass batch mode
  // so parseIntent() can handle them via its FEATURE_ADD/STORAGE patterns.
  // "create a file storage bucket", "add a video bucket", "enable storage", etc.
  const isStorageFeatureRequest =
    /\b(bucket|file.?storage|filestorage|storage.?bucket)\b/i.test(lower) &&
    /\b(create|add|enable|setup|implement|build|make)\b/i.test(lower)
  if (isStorageFeatureRequest) {
    console.log('[Batch Mode Check] ❌ INCREMENTAL - Storage feature request (not a product)')
    return false
  }

  // Rule 1: If backend is empty → ALWAYS batch
  const isEmpty = Object.keys(graph.entities).length === 0
  if (isEmpty) {
    console.log('[Batch Mode Check] ✅ BATCH MODE - Empty graph (new project)')
    return true
  }

  // Rule 2: Explicit incremental indicators (user wants guidance)
  const incrementalPhrases = [
    'also add',
    'now add',
    'next add',
    'then add',
    'step by step',
    'one at a time',
    'guide me',
    'help me decide',
    'not sure',
    'what should',
  ]

  const isExplicitlyIncremental = incrementalPhrases.some(phrase => lower.includes(phrase))
  if (isExplicitlyIncremental) {
    console.log('[Batch Mode Check] ❌ INCREMENTAL - User wants guidance')
    return false
  }

  // Rule 3: Product intent detection (semantic, not entity counting)
  const isProduct = isProductIntent(lower)
  if (isProduct) {
    console.log('[Batch Mode Check] ✅ BATCH MODE - Product intent detected')
    return true
  }

  // Rule 4: Fallback for non-empty graphs with ambiguous intent
  console.log('[Batch Mode Check] ❌ INCREMENTAL - Ambiguous intent on existing graph')
  return false
}

/**
 * Detects if user is describing a PRODUCT (not a tweak)
 * 
 * This uses semantic signals, not entity counts or prompt length.
 * Short prompts can describe complex systems.
 * 
 * Examples that SHOULD trigger:
 * - "I want to sell products"
 * - "Build a Q&A platform"
 * - "Create a blog"
 * - "Marketplace for sellers"
 * 
 * Examples that should NOT trigger:
 * - "Also add a field"
 * - "Change the user table"
 * - "Fix the API"
 * 
 * ⚠️  FROZEN v1.0 - DO NOT EXPAND AGGRESSIVELY
 * This keyword list is intentionally conservative.
 * It covers 95%+ of use cases.
 * 
 * DO NOT add keywords without production evidence of need.
 * Over-expansion reduces clarity and introduces edge cases.
 */
function isProductIntent(message: string): boolean {
  // Product verbs (user is BUILDING something)
  const PRODUCT_VERBS = [
    'build', 'create', 'make', 'develop', 'launch',
    'want', 'need', 'starting',
  ]

  // Product nouns (system-level concepts)
  const PRODUCT_NOUNS = [
    'app', 'platform', 'system', 'tool', 'service',
    'marketplace', 'dashboard', 'backend', 'website',
    'blog', 'forum', 'store', 'shop',
  ]

  // Domain keywords (imply a complete system)
  const DOMAIN_KEYWORDS = [
    'sell', 'shop', 'ecommerce', 'store',      // E-commerce
    'q&a', 'questions', 'answers', 'forum',    // Forums
    'articles', 'blog', 'publish', 'content',  // Content
    'courses', 'lessons', 'learn', 'education',// Education
    'booking', 'appointments', 'schedule',     // Scheduling
    'social', 'feed', 'posts', 'community',    // Social
  ]

  const hasProductVerb = PRODUCT_VERBS.some(v => message.includes(v))
  const hasProductNoun = PRODUCT_NOUNS.some(n => message.includes(n))
  const hasDomainKeyword = DOMAIN_KEYWORDS.some(k => message.includes(k))

  // If user says "build a X" or "I want to sell" → product intent
  return hasProductVerb || hasProductNoun || hasDomainKeyword
}

/**
 * Topological sort for entity execution order
 * 
 * Ensures dependencies are created before dependents
 * Example: Users → Posts → Comments (Comments depend on both)
 */
function topologicalSort(entities: BatchEntity[]): string[] {
  const sorted: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  const visit = (entityName: string): void => {
    if (visited.has(entityName)) return
    if (visiting.has(entityName)) {
      console.warn(`[Batch Planner] Circular dependency detected involving ${entityName}`)
      return
    }
    
    visiting.add(entityName)
    
    const entity = entities.find(e => e.name === entityName)
    if (entity) {
      // Visit dependencies first
      entity.dependsOn.forEach(dep => visit(dep))
    }
    
    visiting.delete(entityName)
    visited.add(entityName)
    sorted.push(entityName)
  }
  
  // Visit all entities
  entities.forEach(e => visit(e.name))
  
  console.log(`[Batch Planner] Execution order: ${sorted.join(' → ')}`)
  return sorted
}

/**
 * Generate human-readable build summary
 * 
 * This is what shows in the "Build Preview" - confident, non-editable
 */
function generateBuildSummary(plan: {
  entities: BatchEntity[]
  auth: { enabled: boolean }
  storage: { enabled: boolean; buckets: string[] }
}): string {
  const parts: string[] = []
  
  // Auth
  if (plan.auth.enabled) {
    parts.push('User authentication')
  }
  
  // Main entities
  const mainEntities = plan.entities.filter(e => e.name !== 'users')
  if (mainEntities.length > 0) {
    const names = mainEntities.map(e => e.description || e.name).join(', ')
    parts.push(names)
  }
  
  // Storage
  if (plan.storage.enabled) {
    parts.push('File storage')
  }
  
  // Relations/permissions (inferred)
  const hasRelations = plan.entities.some(e => e.dependsOn.length > 0)
  if (hasRelations) {
    parts.push('Relationships & permissions')
  }
  
  return parts.join(' • ')
}

/**
 * STEP 1: SINGLE SOURCE OF TRUTH
 * 
 * Create batch plan directly from normalized entities (no LLM re-parsing)
 * This prevents field loss during pipeline transitions
 * 
 * @param normalizedEntities - Already normalized entities with fields preserved
 * @param userMessage - Original user message for context
 * @param semanticUnderstanding - Semantic analysis result
 */
export async function createBatchPlanFromNormalizedEntities(
  normalizedEntities: Array<{
    name: string
    fields: Array<{
      name: string
      type: string
      primary?: boolean
      required?: boolean
      unique?: boolean
      relationTo?: string
    }>
    description?: string
  }>,
  userMessage: string,
  semanticUnderstanding: any
): Promise<BatchPlan> {
  console.log('[Batch Planner] Creating plan from normalized entities (no re-parsing)')
  
  // Convert normalized entities to batch entities
  const batchEntities: BatchEntity[] = normalizedEntities.map(entity => {
    // Map fields to batch format
    const batchFields = entity.fields
      .filter(f => f.name !== 'id' && f.name !== 'created_at' && f.name !== 'updated_at') // Skip system fields
      .map(field => {
        // Map normalized types to batch types
        let type: 'string' | 'number' | 'boolean' | 'date' | 'reference'
        if (field.type === 'relation') {
          type = 'reference'
        } else if (field.type === 'number') {
          type = 'number'
        } else if (field.type === 'boolean') {
          type = 'boolean'
        } else if (field.type === 'timestamp') {
          type = 'date'
        } else {
          type = 'string'
        }
        
        return {
          name: field.name,
          type,
          required: field.required || false,
          unique: field.unique,
          referenceTo: field.relationTo,
        }
      })
    
    // Detect dependencies from relations
    const dependsOn = entity.fields
      .filter(f => f.type === 'relation' && f.relationTo)
      .map(f => f.relationTo!)
      .filter(name => name !== entity.name) // No self-reference
        
    // Remove duplicates
    const uniqueDependsOn = Array.from(new Set(dependsOn))
        
    return {
      name: entity.name,
      description: entity.description || entity.name,
      fields: batchFields,
      dependsOn: uniqueDependsOn,
    }
  })
  
  // Detect relationships from entity fields
  const relationships: BatchRelationship[] = []
  for (const entity of normalizedEntities) {
    for (const field of entity.fields) {
      if (field.type === 'relation' && field.relationTo) {
        relationships.push({
          from: entity.name,
          to: field.relationTo,
          type: 'one-to-many', // Default, can be refined
          foreignKey: field.name,
        })
      }
    }
  }
  
  // Detect auth intent from semantic understanding
  const authEnabled = semanticUnderstanding?.authIntent || 
                     batchEntities.some(e => e.name === 'users')
  
  // Detect storage intent
  const storageEnabled = semanticUnderstanding?.storageIntent || false
  
  // Calculate execution order (topological sort)
  const executionOrder = topologicalSort(batchEntities)
  
  // Generate summary
  const summary = generateBuildSummary({
    entities: batchEntities,
    auth: { enabled: authEnabled },
    storage: { enabled: storageEnabled, buckets: [] },
  })
  
  console.log('[Batch Planner] ✅ Created batch plan with', batchEntities.length, 'entities')
  console.log('[Batch Planner] Total fields preserved:', 
    batchEntities.reduce((sum, e) => sum + e.fields.length, 0))
  
  return {
    entities: batchEntities,
    relationships,
    auth: {
      enabled: authEnabled,
      signupEnabled: authEnabled,
      loginEnabled: authEnabled,
    },
    storage: {
      enabled: storageEnabled,
      buckets: storageEnabled ? ['uploads'] : [],
    },
    userIntent: userMessage,
    isBatchMode: true,
    executionOrder,
    summary,
  }
}
