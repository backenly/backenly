/**
 * Mutation Classifier
 * 
 * Detects incremental schema mutations vs full schema construction.
 * Routes to appropriate execution pipeline.
 */

import { BackendStateGraph } from './backend-state-graph'

export type MutationType = 
  | 'ADD_FIELD'
  | 'REMOVE_FIELD'
  | 'RENAME_FIELD'
  | 'CHANGE_FIELD_TYPE'
  | 'ADD_UNIQUE_CONSTRAINT'
  | 'REMOVE_UNIQUE_CONSTRAINT'
  | 'ADD_RELATIONSHIP'
  | 'REMOVE_RELATIONSHIP'
  | 'RENAME_ENTITY'
  | 'ADD_INDEX'
  | 'ENABLE_AUTH'
  | 'ENABLE_STORAGE'
  | 'REMOVE_TABLE'
  | 'FULL_BUILD'
  | 'UNKNOWN'

export interface MutationIntent {
  type: MutationType
  entity: string // Target entity name
  field?: {
    name: string
    type?: string
    oldName?: string // For renames
    required?: boolean
    unique?: boolean
  }
  relationship?: {
    to: string
    type: 'one-to-one' | 'one-to-many' | 'many-to-many'
    foreignKey?: string
  }
  confidence: number
  rawIntent: string
}

/**
 * Classify user intent into mutation type
 */
export function classifyMutation(
  userMessage: string,
  currentGraph: BackendStateGraph
): MutationIntent | null {
  const msg = userMessage.toLowerCase()
  
  console.log('[MutationClassifier] Analyzing message:', userMessage.substring(0, 50))
  console.log('[MutationClassifier] Graph entities:', Object.keys(currentGraph.entities).join(', '))
  
  // Pattern: Add field X to Y
  // Supports: "add price to products", "add a price field to products", "add totalAmount to orders"
  // The field/column keyword is optional, but we need to handle spacing carefully
  const addFieldPattern = /add\s+(?:a\s+)?([\w]+)(?:\s+(?:field|column|of\s+type\s+\w+))?\s+(?:to|in)\s+(\w+)/i
  const addFieldMatch = userMessage.match(addFieldPattern)
  console.log('[MutationClassifier] Add field pattern match:', addFieldMatch)
  if (addFieldMatch) {
    const fieldPart = addFieldMatch[1].trim()
    const entityName = addFieldMatch[2]
    
    // Extract field name (first word) and optional type
    const fieldTokens = fieldPart.split(/\s+/)
    const fieldName = fieldTokens[0]
    
    // Check if entity exists (case-insensitive)
    const entityNames = Object.keys(currentGraph.entities)
    const matchingEntity = entityNames.find(e => 
      e.toLowerCase() === entityName.toLowerCase()
    )
    if (!matchingEntity) {
      console.log('[MutationClassifier] Entity not found:', entityName)
      console.log('[MutationClassifier] Available entities:', entityNames.join(', '))
      return null
    }
    
    // Use the actual entity name from graph (preserve case)
    const actualEntityName = matchingEntity
    
    // Infer type from field name and full user message
    const fieldType = inferFieldType(fieldName, userMessage)
    
    return {
      type: 'ADD_FIELD',
      entity: actualEntityName,
      field: {
        name: fieldName, // Preserve original case (e.g., totalAmount)
        type: fieldType,
        required: msg.includes('required') || msg.includes('not null'),
        unique: msg.includes('unique'),
      },
      confidence: 0.9,
      rawIntent: userMessage,
    }
  }
  
  // Pattern: Add unique constraint to field
  // Supports: "make users.email unique", "add unique constraint on email", "email should be unique"
  const uniqueConstraintPattern = /(?:make|add\s+unique\s+constraint\s+(?:on\s+)?)?(\w+)\.(\w+)\s+(?:should\s+be\s+)?unique/i
  const uniqueConstraintMatch = userMessage.match(uniqueConstraintPattern)
  console.log('[MutationClassifier] Unique constraint pattern match:', uniqueConstraintMatch)
  
  if (uniqueConstraintMatch) {
    const entityName = uniqueConstraintMatch[1]
    const fieldName = uniqueConstraintMatch[2]
    
    // Check if entity exists
    const entityNames = Object.keys(currentGraph.entities)
    const matchingEntity = entityNames.find(e => 
      e.toLowerCase() === entityName.toLowerCase()
    )
    if (!matchingEntity) {
      console.log('[MutationClassifier] Entity not found for unique constraint:', entityName)
      return null
    }
    
    // Check if field exists
    const entity = currentGraph.entities[matchingEntity]
    const matchingField = Object.keys(entity.fields).find(f => 
      f.toLowerCase() === fieldName.toLowerCase()
    )
    if (!matchingField) {
      console.log('[MutationClassifier] Field not found for unique constraint:', fieldName)
      return null
    }
    
    return {
      type: 'ADD_UNIQUE_CONSTRAINT',
      entity: matchingEntity,
      field: {
        name: matchingField,
        unique: true,
      },
      confidence: 0.95,
      rawIntent: userMessage,
    }
  }
  
  // Pattern: Remove table/entity X
  // Supports: "remove orders table", "delete orders", "drop table orders", "remove the orders entity"
  // BUT NOT: "Only admins can delete orders" (policy statement)
  const removeTablePattern = /(?:remove|delete|drop)\s+(?:table\s+)?(\w+)(?:\s+(?:table|entity))?/i
  const removeTableMatch = userMessage.match(removeTablePattern)
  console.log('[MutationClassifier] Remove table pattern match:', removeTableMatch)
  
  // Check if this is actually a policy statement (e.g., "Only admins can delete orders")
  const isPolicyStatement = /only\s+\w+\s+can\s+\w+/i.test(userMessage)
  
  if (removeTableMatch && !isPolicyStatement) {
    const entityName = removeTableMatch[1]
    
    // Check if entity exists (case-insensitive)
    const entityNames = Object.keys(currentGraph.entities)
    const matchingEntity = entityNames.find(e => 
      e.toLowerCase() === entityName.toLowerCase()
    )
    if (!matchingEntity) {
      console.log('[MutationClassifier] Entity not found for remove table:', entityName)
      return null
    }
    
    // Use the actual entity name from graph (preserve case)
    const actualEntityName = matchingEntity
    
    return {
      type: 'REMOVE_TABLE',
      entity: actualEntityName,
      confidence: 0.9,
      rawIntent: userMessage,
    }
  }
  
  // Pattern: Remove field X from Y
  // Supports: "remove field description from products", "remove description from products", "delete description field from products"
  const removeFieldPattern = /(?:remove|delete|drop)\s+(?:(?:field|column)\s+)?(\w+)(?:\s+(?:field|column))?\s+from\s+(\w+)/i
  const removeFieldMatch = userMessage.match(removeFieldPattern)
  console.log('[MutationClassifier] Remove field pattern match:', removeFieldMatch)
  if (removeFieldMatch) {
    const fieldName = removeFieldMatch[1]
    const entityName = removeFieldMatch[2]
    
    // Check if entity exists (case-insensitive)
    const entityNames = Object.keys(currentGraph.entities)
    const matchingEntity = entityNames.find(e => 
      e.toLowerCase() === entityName.toLowerCase()
    )
    if (!matchingEntity) {
      console.log('[MutationClassifier] Entity not found for remove:', entityName)
      return null
    }
    
    // Use the actual entity name from graph (preserve case)
    const actualEntityName = matchingEntity
    
    return {
      type: 'REMOVE_FIELD',
      entity: actualEntityName,
      field: {
        name: fieldName, // Preserve original case
      },
      confidence: 0.9,
      rawIntent: userMessage,
    }
  }
  
  // Pattern: Change field type
  // Supports: "change category to number in products", "change field type of category to number in products"
  const changeTypePattern = /change\s+(?:(?:field|column)\s+)?(?:type\s+(?:of\s+)?)?(\w+)\s+to\s+(\w+)\s+(?:in|on)\s+(\w+)/i
  const changeTypeMatch = userMessage.match(changeTypePattern)
  console.log('[MutationClassifier] Change type pattern match:', changeTypeMatch)
  if (changeTypeMatch) {
    const fieldName = changeTypeMatch[1]
    const newType = changeTypeMatch[2]
    const entityName = changeTypeMatch[3]
    
    // Check if entity exists (case-insensitive)
    const entityNames = Object.keys(currentGraph.entities)
    const matchingEntity = entityNames.find(e => 
      e.toLowerCase() === entityName.toLowerCase()
    )
    if (!matchingEntity) {
      console.log('[MutationClassifier] Entity not found for change type:', entityName)
      return null
    }
    
    // Use the actual entity name from graph (preserve case)
    const actualEntityName = matchingEntity
    
    return {
      type: 'CHANGE_FIELD_TYPE',
      entity: actualEntityName,
      field: {
        name: fieldName.toLowerCase(),
        type: newType.toLowerCase(),
      },
      confidence: 0.9,
      rawIntent: userMessage,
    }
  }
  
  // Pattern: Rename field X to Y in Z
  const renameFieldPattern = /rename\s+(?:field|column)\s+(\w+)\s+to\s+(\w+)\s+(?:in|on)\s+(\w+)/i
  const renameFieldMatch = userMessage.match(renameFieldPattern)
  if (renameFieldMatch) {
    const oldName = renameFieldMatch[1]
    const newName = renameFieldMatch[2]
    const entityName = renameFieldMatch[3]
    
    if (!currentGraph.entities[entityName] && !currentGraph.entities[entityName.toLowerCase()]) {
      return null
    }
    
    return {
      type: 'RENAME_FIELD',
      entity: entityName.toLowerCase(),
      field: {
        name: newName.toLowerCase(),
        oldName: oldName.toLowerCase(),
      },
      confidence: 0.9,
      rawIntent: userMessage,
    }
  }
  
  // Pattern: Rename table X to Y
  const renameEntityPattern = /rename\s+(?:table|entity)\s+(\w+)\s+to\s+(\w+)/i
  const renameEntityMatch = userMessage.match(renameEntityPattern)
  if (renameEntityMatch) {
    const oldName = renameEntityMatch[1]
    const newName = renameEntityMatch[2]
    
    if (!currentGraph.entities[oldName] && !currentGraph.entities[oldName.toLowerCase()]) {
      return null
    }
    
    return {
      type: 'RENAME_ENTITY',
      entity: oldName.toLowerCase(),
      field: {
        name: newName.toLowerCase(),
      },
      confidence: 0.9,
      rawIntent: userMessage,
    }
  }
  
  // Pattern: Add relationship from X to Y
  const addRelationPattern = /add\s+(?:a\s+)?relationship\s+(?:from\s+)?(\w+)\s+to\s+(\w+)/i
  const addRelationMatch = userMessage.match(addRelationPattern)
  if (addRelationMatch) {
    const fromEntity = addRelationMatch[1]
    const toEntity = addRelationMatch[2]
    
    if (!currentGraph.entities[fromEntity] && !currentGraph.entities[fromEntity.toLowerCase()]) {
      return null
    }
    
    return {
      type: 'ADD_RELATIONSHIP',
      entity: fromEntity.toLowerCase(),
      relationship: {
        to: toEntity.toLowerCase(),
        type: 'one-to-many', // Default
      },
      confidence: 0.85,
      rawIntent: userMessage,
    }
  }
  
  return null
}

/**
 * Infer field type from field name and context
 */
function inferFieldType(fieldName: string, context: string): string {
  const name = fieldName.toLowerCase()
  const ctx = context.toLowerCase()
  
  // Explicit type mentions
  if (ctx.includes('string') || ctx.includes('text')) return 'string'
  if (ctx.includes('number') || ctx.includes('integer') || ctx.includes('int')) return 'number'
  if (ctx.includes('decimal') || ctx.includes('float') || ctx.includes('price') || ctx.includes('amount')) return 'Float'
  if (ctx.includes('boolean') || ctx.includes('bool') || ctx.includes('flag')) return 'boolean'
  if (ctx.includes('date') || ctx.includes('timestamp')) return 'timestamp'
  if (ctx.includes('json') || ctx.includes('object')) return 'json'
  
  // Infer from field name
  if (name.includes('id') && !name.startsWith('id')) return 'uuid'
  if (name.includes('email')) return 'string'
  if (name.includes('name') || name.includes('title') || name.includes('description')) return 'string'
  if (name.includes('price') || name.includes('amount') || name.includes('cost')) return 'Float'
  if (name.includes('count') || name.includes('quantity') || name.includes('age')) return 'number'
  if (name.includes('active') || name.includes('enabled') || name.includes('verified')) return 'boolean'
  if (name.includes('date') || name.includes('time') || name.includes('at')) return 'timestamp'
  
  // Default
  return 'string'
}

/**
 * Check if intent should use incremental mode
 */
export function shouldUseIncrementalMode(
  userMessage: string,
  currentGraph: BackendStateGraph
): boolean {
  console.log('[MutationClassifier] 🔥🔥🔥 shouldUseIncrementalMode called 🔥🔥🔥')
  console.log('[MutationClassifier] Graph has', Object.keys(currentGraph.entities).length, 'entities')
  console.log('[MutationClassifier] Message:', userMessage.substring(0, 100))
  
  // If graph is empty, always use batch mode
  if (!currentGraph.entities || Object.keys(currentGraph.entities).length === 0) {
    console.log('[MutationClassifier] ❌ Graph empty, using batch mode')
    return false
  }
  
  // Try to classify as mutation
  const mutation = classifyMutation(userMessage, currentGraph)
  console.log('[MutationClassifier] Classify result:', mutation?.type || 'null')
  
  // If we detected a valid mutation, use incremental mode
  if (mutation && mutation.type !== 'FULL_BUILD' && mutation.type !== 'UNKNOWN') {
    console.log('[MutationClassifier] ✅✅✅ Incremental mode ENABLED ✅✅✅')
    return true
  }
  
  console.log('[MutationClassifier] ❌ Incremental mode DISABLED')
  return false
}
