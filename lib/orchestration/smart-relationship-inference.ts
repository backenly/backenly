/**
 * Smart Relationship Inference
 * 
 * Implements the "Bolt/Cursor quality" UX for table creation:
 * 1. Always execute the user's request (never block)
 * 2. Suggest improvements when potential relationships are detected
 * 3. Use intelligent inference based on common patterns
 * 
 * Example flow:
 * User: "add payments table"
 * System: Creates table + suggests "payments → users" relationship
 */

import type { BackendStateGraph } from './backend-state-graph'

/**
 * Common relationship patterns
 * Maps entity names to their likely parent/owner entities
 */
export const COMMON_RELATIONSHIP_PATTERNS: Record<string, {
  likelyParents: string[]
  reason: string
  priority: 'high' | 'medium' | 'low'
}> = {
  // Financial entities
  payments: {
    likelyParents: ['users', 'orders', 'customers'],
    reason: 'Payments typically belong to a user or order',
    priority: 'high'
  },
  orders: {
    likelyParents: ['users', 'customers'],
    reason: 'Orders are usually placed by users',
    priority: 'high'
  },
  invoices: {
    likelyParents: ['users', 'customers', 'orders'],
    reason: 'Invoices belong to customers or orders',
    priority: 'high'
  },
  transactions: {
    likelyParents: ['users', 'accounts', 'wallets'],
    reason: 'Transactions belong to users or accounts',
    priority: 'high'
  },
  subscriptions: {
    likelyParents: ['users', 'customers'],
    reason: 'Subscriptions are tied to users',
    priority: 'high'
  },
  
  // Content entities
  posts: {
    likelyParents: ['users', 'authors'],
    reason: 'Posts are authored by users',
    priority: 'high'
  },
  comments: {
    likelyParents: ['users', 'posts', 'articles'],
    reason: 'Comments belong to users and content',
    priority: 'high'
  },
  reviews: {
    likelyParents: ['users', 'products', 'services'],
    reason: 'Reviews are written by users about items',
    priority: 'high'
  },
  articles: {
    likelyParents: ['users', 'authors', 'categories'],
    reason: 'Articles are written by authors',
    priority: 'medium'
  },
  
  // Social entities
  likes: {
    likelyParents: ['users', 'posts', 'comments'],
    reason: 'Likes are given by users to content',
    priority: 'high'
  },
  followers: {
    likelyParents: ['users'],
    reason: 'Follow relationships are between users',
    priority: 'high'
  },
  messages: {
    likelyParents: ['users', 'conversations', 'threads'],
    reason: 'Messages are sent by users',
    priority: 'high'
  },
  notifications: {
    likelyParents: ['users'],
    reason: 'Notifications are sent to users',
    priority: 'high'
  },
  
  // E-commerce entities
  products: {
    likelyParents: ['categories', 'stores', 'vendors'],
    reason: 'Products belong to categories or stores',
    priority: 'medium'
  },
  cart_items: {
    likelyParents: ['users', 'carts', 'orders'],
    reason: 'Cart items belong to users or carts',
    priority: 'high'
  },
  wishlist_items: {
    likelyParents: ['users', 'wishlists'],
    reason: 'Wishlist items belong to users',
    priority: 'high'
  },
  
  // File/Media entities
  uploads: {
    likelyParents: ['users'],
    reason: 'Uploads are made by users',
    priority: 'high'
  },
  attachments: {
    likelyParents: ['users', 'posts', 'messages'],
    reason: 'Attachments belong to content or users',
    priority: 'medium'
  },
  media: {
    likelyParents: ['users', 'posts', 'products'],
    reason: 'Media is uploaded by users or attached to content',
    priority: 'medium'
  },
  
  // Task/Project entities
  tasks: {
    likelyParents: ['users', 'projects', 'teams'],
    reason: 'Tasks are assigned to users or belong to projects',
    priority: 'high'
  },
  projects: {
    likelyParents: ['users', 'teams', 'organizations'],
    reason: 'Projects are owned by users or teams',
    priority: 'medium'
  },
  
  // Support entities
  tickets: {
    likelyParents: ['users', 'customers'],
    reason: 'Support tickets are created by users',
    priority: 'high'
  },
  feedback: {
    likelyParents: ['users', 'customers'],
    reason: 'Feedback is provided by users',
    priority: 'high'
  },
}

/**
 * Suggested relationship for a newly created table
 */
export interface RelationshipSuggestion {
  id: string
  tableName: string
  suggestedRelation: {
    from: string      // The new table
    to: string        // The existing table to link to
    type: 'one-to-one' | 'one-to-many' | 'many-to-many'
    foreignKeyField: string
    reason: string
  }
  confidence: 'high' | 'medium' | 'low'
  priority: 'high' | 'medium' | 'low'
}

/**
 * Result of analyzing a new table for relationship opportunities
 */
export interface RelationshipInferenceResult {
  tableName: string
  hasSuggestion: boolean
  suggestion?: RelationshipSuggestion
  allPossibleRelations: Array<{
    to: string
    reason: string
    confidence: 'high' | 'medium' | 'low'
  }>
}

/**
 * Check if an entity name matches a pattern (handles pluralization)
 */
function matchesPattern(entityName: string, pattern: string): boolean {
  const normalizedEntity = entityName.toLowerCase().replace(/[_-]/g, '')
  const normalizedPattern = pattern.toLowerCase()
  
  // Direct match
  if (normalizedEntity === normalizedPattern) return true
  
  // Singular/plural variations
  const singular = normalizedPattern.replace(/s$/, '')
  const plural = normalizedPattern + 's'
  
  if (normalizedEntity === singular) return true
  if (normalizedEntity === plural) return true
  
  // Contains pattern
  if (normalizedEntity.includes(normalizedPattern)) return true
  if (normalizedPattern.includes(normalizedEntity)) return true
  
  return false
}

/**
 * Find the best matching parent entity from existing tables
 */
function findBestParentEntity(
  likelyParents: string[],
  existingEntities: string[]
): string | null {
  for (const parent of likelyParents) {
    // Look for exact or close match in existing entities
    const match = existingEntities.find(entity => 
      entity.toLowerCase() === parent.toLowerCase() ||
      entity.toLowerCase() === parent.toLowerCase() + 's' ||
      entity.toLowerCase().replace(/s$/, '') === parent.toLowerCase()
    )
    if (match) return match
  }
  return null
}

/**
 * Infer potential relationships for a newly created table
 * 
 * This is called AFTER the table is created - it never blocks,
 * only suggests improvements.
 */
export function inferRelationshipsForNewTable(
  tableName: string,
  graph: BackendStateGraph
): RelationshipInferenceResult {
  const existingEntities = Object.keys(graph.entities)
  const allPossibleRelations: Array<{ to: string; reason: string; confidence: 'high' | 'medium' | 'low' }> = []
  
  // Check against known patterns
  for (const [pattern, config] of Object.entries(COMMON_RELATIONSHIP_PATTERNS)) {
    if (matchesPattern(tableName, pattern)) {
      const bestParent = findBestParentEntity(config.likelyParents, existingEntities)
      
      if (bestParent) {
        // Check if relation already exists
        const entity = graph.entities[tableName]
        const hasExistingRelation = entity?.relationships?.some(r => 
          r.to.toLowerCase() === bestParent.toLowerCase()
        )
        
        if (!hasExistingRelation) {
          allPossibleRelations.push({
            to: bestParent,
            reason: config.reason,
            confidence: config.priority === 'high' ? 'high' : 'medium'
          })
        }
      }
    }
  }
  
  // Sort by confidence
  allPossibleRelations.sort((a, b) => {
    const confidenceOrder = { high: 3, medium: 2, low: 1 }
    return confidenceOrder[b.confidence] - confidenceOrder[a.confidence]
  })
  
  // Get the best suggestion
  const bestRelation = allPossibleRelations[0]
  
  if (bestRelation) {
    const pattern = Object.entries(COMMON_RELATIONSHIP_PATTERNS).find(([key]) => 
      matchesPattern(tableName, key)
    )
    
    return {
      tableName,
      hasSuggestion: true,
      suggestion: {
        id: `rel_${tableName}_${bestRelation.to}_${Date.now()}`,
        tableName,
        suggestedRelation: {
          from: tableName,
          to: bestRelation.to,
          type: 'many-to-many',
          foreignKeyField: `${bestRelation.to.replace(/s$/, '').toLowerCase()}Id`,
          reason: bestRelation.reason
        },
        confidence: bestRelation.confidence,
        priority: pattern?.[1].priority || 'medium'
      },
      allPossibleRelations
    }
  }
  
  return {
    tableName,
    hasSuggestion: false,
    allPossibleRelations
  }
}

/**
 * Generate a user-friendly message for the relationship suggestion
 */
export function generateSuggestionMessage(result: RelationshipInferenceResult): string {
  if (!result.hasSuggestion || !result.suggestion) {
    return `I've created the **${result.tableName}** table.`
  }
  
  const { suggestedRelation, priority } = result.suggestion
  
  // High priority = very likely needed
  if (priority === 'high') {
    return `I've created the **${result.tableName}** table.

${suggestedRelation.reason}. Would you like me to link it to **${suggestedRelation.to}**?`
  }
  
  // Medium/low priority = suggest as improvement
  return `I've created the **${result.tableName}** table.

You might also want to connect it to **${suggestedRelation.to}** — ${suggestedRelation.reason.toLowerCase()}.`
}

/**
 * Check if a table already has a relationship to a specific entity
 */
export function hasRelationshipTo(
  tableName: string,
  targetEntity: string,
  graph: BackendStateGraph
): boolean {
  const entity = graph.entities[tableName]
  if (!entity) return false
  
  return entity.relationships?.some(r => 
    r.to.toLowerCase() === targetEntity.toLowerCase()
  ) ?? false
}

/**
 * Apply a suggested relationship to the graph
 * Returns the updated graph with the new relationship
 */
export function applySuggestedRelationship(
  suggestion: RelationshipSuggestion,
  graph: BackendStateGraph
): BackendStateGraph {
  const { tableName, suggestedRelation } = suggestion
  
  if (!graph.entities[tableName]) {
    throw new Error(`Table ${tableName} not found in graph`)
  }
  
  // Add the foreign key field (as a string field that references another table)
  const fieldName = suggestedRelation.foreignKeyField
  graph.entities[tableName].fields[fieldName] = {
    name: fieldName,
    type: 'string', // Foreign key reference stored as string
    nullable: true,
    unique: false,
    default: null,
    createdAt: new Date().toISOString(),
    createdBy: 'smart_relationship_inference',
    reason: `${suggestedRelation.reason} (references ${suggestedRelation.to})`,
    usedBy: []
  }
  
  // Add the relationship
  if (!graph.entities[tableName].relationships) {
    graph.entities[tableName].relationships = []
  }
  
  graph.entities[tableName].relationships!.push({
    from: tableName,
    to: suggestedRelation.to,
    type: suggestedRelation.type,
    foreignKey: fieldName,
    reason: suggestedRelation.reason,
    createdBy: 'smart_relationship_inference'
  })
  
  return graph
}
