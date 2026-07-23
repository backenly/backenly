/**
 * Schema Normalization Layer
 * 
 * Transforms human-style inferred entities into engine-safe schema specifications
 * that always pass validation.
 * 
 * RESILIENCE PRINCIPLE: This layer REPAIRS issues, doesn't abort.
 * - Auto-fixes camelCase → snake_case
 * - Auto-repairs invalid field names
 * - Retries validation after repair
 * 
 * Pipeline: Entity Inference → Schema Normalizer → Spec Validator → Execution
 * 
 * This is critical orchestration infrastructure - NOT UI work.
 */

import { logger } from '@/lib/logger'
import { InferredEntity } from './entity-inference'

export interface NormalizedField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'timestamp' | 'uuid' | 'json' | 'relation'
  primary?: boolean
  required?: boolean
  unique?: boolean
  relationTo?: string
  defaultValue?: any
}

export interface NormalizedEntity {
  name: string
  fields: NormalizedField[]
  description?: string
}

export interface NormalizationResult {
  success: boolean
  entities: NormalizedEntity[]
  errors: string[]
  warnings: string[]
  stats: {
    totalEntities: number
    totalFields: number
    relationsDetected: number
    defaultFieldsInjected: number
  }
}

/**
 * Convert camelCase or PascalCase to snake_case
 * RESILIENCE: Always produces valid snake_case, never throws
 */
function toSnakeCase(str: string): string {
  if (!str) return 'unnamed_field'
  
  return str
    // Insert underscore before uppercase letters
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    // Remove leading underscore
    .replace(/^_/, '')
    // Replace spaces with underscores
    .replace(/\s+/g, '_')
    // Replace multiple underscores with single
    .replace(/_+/g, '_')
    // Remove any non-alphanumeric except underscore
    .replace(/[^a-z0-9_]/g, '')
    // Ensure doesn't start with number
    .replace(/^(\d)/, '_$1')
}

/**
 * Auto-repair a field name to be valid
 * RESILIENCE: Never fails, always returns a valid name
 */
function repairFieldName(fieldName: string): string {
  if (!fieldName) return 'unknown_field'
  
  // First convert to snake_case
  let repaired = toSnakeCase(fieldName)
  
  // If still invalid, apply aggressive repair
  if (!isValidFieldName(repaired)) {
    repaired = repaired
      .replace(/[^a-z0-9_]/gi, '_')
      .toLowerCase()
      .replace(/^_+/, '')
      .replace(/_+/g, '_')
  }
  
  // Final fallback
  if (!isValidFieldName(repaired) || !repaired) {
    repaired = 'field_' + Math.random().toString(36).slice(2, 6)
  }
  
  return repaired
}

/**
 * Check if field name is valid (snake_case with optional numbers)
 */
function isValidFieldName(name: string): boolean {
  // Allow lowercase letters, numbers, and underscores
  // Must start with letter or underscore
  return /^[a-z_][a-z0-9_]*$/.test(name)
}

/**
 * Detect if a field name represents a timestamp
 */
function isTimestampField(fieldName: string): boolean {
  const timestampPatterns = [
    /created_at/i,
    /updated_at/i,
    /deleted_at/i,
    /start_date/i,
    /end_date/i,
    /timestamp/i,
    /date/i,
  ]
  
  return timestampPatterns.some(pattern => pattern.test(fieldName))
}

/**
 * Detect if a field represents a relation to another entity
 */
function isRelationField(fieldName: string): { isRelation: boolean; targetEntity?: string } {
  // Patterns: userId, user_id, planId, plan_id
  const relationPattern = /^(.+?)(_)?id$/i
  const match = fieldName.match(relationPattern)
  
  if (match) {
    const entityName = match[1].replace(/_/g, '')
    return {
      isRelation: true,
      targetEntity: toSnakeCase(entityName) + 's' // Pluralize: user → users
    }
  }
  
  return { isRelation: false }
}

/**
 * Infer field type from field name using heuristics
 */
function inferFieldType(fieldName: string, fieldType?: string): NormalizedField['type'] {
  const lowerName = fieldName.toLowerCase()
  
  // If explicit type provided, use it
  if (fieldType) {
    const typeMap: Record<string, NormalizedField['type']> = {
      'string': 'string',
      'number': 'number',
      'boolean': 'boolean',
      'date': 'timestamp',
      'timestamp': 'timestamp',
      'json': 'json',
      'relation': 'relation',
      'uuid': 'uuid',
    }
    return typeMap[fieldType.toLowerCase()] || 'string'
  }
  
  // Timestamp detection
  if (isTimestampField(fieldName)) {
    return 'timestamp'
  }
  
  // Heuristic patterns
  if (lowerName.includes('email')) return 'string'
  if (lowerName.includes('password')) return 'string'
  if (lowerName.includes('name')) return 'string'
  if (lowerName.includes('title')) return 'string'
  if (lowerName.includes('description')) return 'string'
  if (lowerName.includes('text')) return 'string'
  if (lowerName.includes('content')) return 'string'
  if (lowerName.includes('url')) return 'string'
  if (lowerName.includes('path')) return 'string'
  if (lowerName.includes('file')) return 'string'
  
  if (lowerName.includes('price')) return 'number'
  if (lowerName.includes('amount')) return 'number'
  if (lowerName.includes('count')) return 'number'
  if (lowerName.includes('size')) return 'number'
  if (lowerName.includes('quantity')) return 'number'
  
  if (lowerName.includes('active')) return 'boolean'
  if (lowerName.includes('enabled')) return 'boolean'
  if (lowerName.includes('verified')) return 'boolean'
  if (lowerName.includes('is_')) return 'boolean'
  if (lowerName.includes('has_')) return 'boolean'
  
  if (lowerName.includes('data')) return 'json'
  if (lowerName.includes('meta')) return 'json'
  if (lowerName.includes('config')) return 'json'
  if (lowerName.includes('settings')) return 'json'
  
  // Default fallback
  return 'string'
}

/**
 * Normalize a single entity
 */
function normalizeEntity(
  entity: InferredEntity,
  allEntities: InferredEntity[]
): { normalized: NormalizedEntity; warnings: string[]; stats: any } {
  const warnings: string[] = []
  const stats = {
    defaultFieldsInjected: 0,
    relationsDetected: 0,
  }
  
  // Normalize entity name to snake_case
  const normalizedName = toSnakeCase(entity.name)
  
  const normalizedFields: NormalizedField[] = []
  const processedFieldNames = new Set<string>()
  
  // RULE 1: Ensure primary key exists
  const hasId = entity.fields.some(f => f.name.toLowerCase() === 'id')
  if (!hasId) {
    normalizedFields.push({
      name: 'id',
      type: 'uuid',
      primary: true,
      required: true,
    })
    stats.defaultFieldsInjected++
    processedFieldNames.add('id')
  }
  
  // RULE 2: Process each field
  for (const field of entity.fields) {
    const originalName = field.name
    const normalizedFieldName = toSnakeCase(originalName)
    
    // Skip if already processed (e.g., id)
    if (processedFieldNames.has(normalizedFieldName)) {
      continue
    }
    
    // RULE 3: Skip reserved raw fields (will be normalized)
    if (['createdAt', 'updatedAt', 'deletedAt'].includes(originalName)) {
      warnings.push(`Skipping raw field "${originalName}" - will be normalized`)
      continue
    }
    
    // RULE 4: Detect relations
    const relationCheck = isRelationField(normalizedFieldName)
    if (relationCheck.isRelation) {
      // Verify target entity exists
      const targetExists = allEntities.some(e => 
        toSnakeCase(e.name) === relationCheck.targetEntity
      )
      
      if (targetExists || relationCheck.targetEntity) {
        normalizedFields.push({
          name: normalizedFieldName,
          type: 'relation',
          relationTo: relationCheck.targetEntity,
          required: field.required,
        })
        stats.relationsDetected++
        processedFieldNames.add(normalizedFieldName)
        continue
      }
    }
    
    // RULE 5: Infer type
    const fieldType = inferFieldType(normalizedFieldName, field.type)
    
    normalizedFields.push({
      name: normalizedFieldName,
      type: fieldType,
      required: field.required,
      unique: field.unique,
    })
    
    processedFieldNames.add(normalizedFieldName)
  }
  
  // RULE 6: Ensure timestamp fields exist
  const hasCreatedAt = normalizedFields.some(f => f.name === 'created_at')
  const hasUpdatedAt = normalizedFields.some(f => f.name === 'updated_at')
  
  if (!hasCreatedAt) {
    normalizedFields.push({
      name: 'created_at',
      type: 'timestamp',
      required: true,
    })
    stats.defaultFieldsInjected++
  }
  
  if (!hasUpdatedAt) {
    normalizedFields.push({
      name: 'updated_at',
      type: 'timestamp',
      required: true,
    })
    stats.defaultFieldsInjected++
  }
  
  return {
    normalized: {
      name: normalizedName,
      fields: normalizedFields,
      description: entity.description,
    },
    warnings,
    stats,
  }
}

/**
 * Validate normalized schema for safety
 * RESILIENCE: Attempts auto-repair before reporting errors
 */
function validateNormalizedSchema(entities: NormalizedEntity[]): { errors: string[]; repaired: boolean } {
  const errors: string[] = []
  let repaired = false
  
  for (const entity of entities) {
    // Check entity has name
    if (!entity.name || entity.name.trim() === '') {
      errors.push('Entity missing name')
      continue
    }
    
    // Check entity has fields
    if (!entity.fields || entity.fields.length === 0) {
      errors.push(`Entity "${entity.name}" has no fields`)
      continue
    }
    
    // Check for primary key
    const hasPrimaryKey = entity.fields.some(f => f.primary || f.name === 'id')
    if (!hasPrimaryKey) {
      errors.push(`Entity "${entity.name}" missing primary key`)
    }
    
    // Validate and AUTO-REPAIR field names
    for (const field of entity.fields) {
      if (!field.name || !isValidFieldName(field.name)) {
        // RESILIENCE: Auto-repair instead of failing
        const originalName = field.name
        field.name = repairFieldName(originalName)
        repaired = true
        
        logger.info('[Schema Normalizer] Auto-repaired field name', {
          entity: entity.name,
          original: originalName,
          repaired: field.name,
        })
      }
      
      // Validate relations have relationTo
      if (field.type === 'relation' && !field.relationTo) {
        errors.push(`Relation field "${entity.name}.${field.name}" missing relationTo`)
      }
    }
  }
  
  return { errors, repaired }
}

/**
 * Auth-entity names that should always be normalized to "users".
 * When any entity represents the primary account/person that authenticates,
 * rename it to "users" so auth endpoints always have a predictable target.
 * A "role" / "account_type" field is injected to preserve domain semantics.
 */
const AUTH_ENTITY_ALIASES = new Set([
  'member', 'members',
  'founder', 'founders',
  'provider', 'providers',
  'customer', 'customers',
  'client', 'clients',
  'account', 'accounts',
  'person', 'people',
  'participant', 'participants',
  'host', 'hosts',
  'buyer', 'buyers',
  'seller', 'sellers',
  'owner', 'owners',
  'professional', 'professionals',
  'agent', 'agents',
  'instructor', 'instructors',
  'student', 'students',
  'seeker', 'seekers',
  'applicant', 'applicants',
  'vendor', 'vendors',
  'operator', 'operators',
  'administrator', 'administrators',
  'subscriber', 'subscribers',
  'writer', 'writers',
  'reader', 'readers',
  'organizer', 'organizers',
  'attendee', 'attendees',
  'sitter', 'sitters',
])

/**
 * Detect whether a normalized entity is an auth entity by:
 * 1. It has both email AND password(-like) fields, OR
 * 2. Its name is in the AUTH_ENTITY_ALIASES list
 */
function isAuthEntity(entity: NormalizedEntity): boolean {
  const name = entity.name.toLowerCase()
  if (AUTH_ENTITY_ALIASES.has(name)) return true
  const fieldNames = entity.fields.map(f => f.name.toLowerCase())
  const hasEmail = fieldNames.some(n => n === 'email' || n.includes('email'))
  const hasPassword = fieldNames.some(n =>
    n === 'password' || n.includes('password') || n === 'hashed_password' || n === 'password_hash'
  )
  return hasEmail && hasPassword
}

/**
 * Post-process: rename auth entities to "users" and inject a "role" field
 * so multi-account-type apps (e.g. owner + sitter) converge on one users table.
 */
function normalizeAuthEntityNames(entities: NormalizedEntity[]): { entities: NormalizedEntity[]; warnings: string[] } {
  const warnings: string[] = []
  // Collect original names that are auth aliases (will be renamed to 'users')
  const aliasesToRename: string[] = []

  // First pass: identify which entities need renaming
  for (const entity of entities) {
    if (entity.name !== 'users' && isAuthEntity(entity)) {
      aliasesToRename.push(entity.name)
    }
  }

  if (aliasesToRename.length === 0) return { entities, warnings }

  // Check if a 'users' entity already exists
  const usersEntityExists = entities.some(e => e.name === 'users')

  const renamed: NormalizedEntity[] = []
  let mergedUsersEntity: NormalizedEntity | null = null

  for (const entity of entities) {
    if (aliasesToRename.includes(entity.name)) {
      warnings.push(`Auth entity "${entity.name}" renamed to "users" — injecting role field`)

      if (!usersEntityExists && !mergedUsersEntity) {
        // First alias becomes the users table
        const hasRoleField = entity.fields.some(f => f.name === 'role' || f.name === 'account_type')
        const updatedFields: NormalizedField[] = [...entity.fields]
        if (!hasRoleField) {
          updatedFields.push({ name: 'role', type: 'string', required: false })
        }
        mergedUsersEntity = { ...entity, name: 'users', fields: updatedFields }
        renamed.push(mergedUsersEntity)
      } else if (mergedUsersEntity) {
        // Subsequent aliases: don't create a second users table — just note it
        warnings.push(`Duplicate auth entity "${entity.name}" merged into "users" table via role field`)
      } else {
        // users already exists — don't create a duplicate, just drop this alias
        warnings.push(`Auth entity "${entity.name}" dropped — "users" table already present`)
      }
    } else {
      renamed.push(entity)
    }
  }

  // Update any relations that pointed at the old alias name(s)
  for (const entity of renamed) {
    for (const field of entity.fields) {
      if (field.type === 'relation' && field.relationTo && aliasesToRename.includes(field.relationTo)) {
        field.relationTo = 'users'
      }
    }
  }

  return { entities: renamed, warnings }
}

/**
 * Main normalization function
 * 
 * Converts human-style inferred entities into engine-safe schema specs
 */
export function normalizeEntities(
  inferredEntities: InferredEntity[]
): NormalizationResult {
  console.log('[Schema Normalizer] Starting normalization')
  console.log('[DEBUG NORMALIZER INPUT]', JSON.stringify(inferredEntities, null, 2))
  console.log('[Schema Normalizer] Input entities:', inferredEntities.map(e => ({
    name: e.name,
    fieldCount: e.fields?.length || 0,
    fields: e.fields?.map(f => f.name)
  })))
  
  const normalizedEntities: NormalizedEntity[] = []
  const allWarnings: string[] = []
  const allStats = {
    totalEntities: 0,
    totalFields: 0,
    relationsDetected: 0,
    defaultFieldsInjected: 0,
  }
  
  // Normalize each entity
  for (const entity of inferredEntities) {
    console.log(`[Schema Normalizer] Normalizing entity: ${entity.name}`)
    console.log(`[Schema Normalizer] Entity fields before:`, entity.fields?.map(f => f.name))
    
    const { normalized, warnings, stats } = normalizeEntity(entity, inferredEntities)
    
    console.log(`[Schema Normalizer] Entity fields after:`, normalized.fields.map(f => f.name))
    
    normalizedEntities.push(normalized)
    allWarnings.push(...warnings)
    
    allStats.totalEntities++
    allStats.totalFields += normalized.fields.length
    allStats.relationsDetected += stats.relationsDetected
    allStats.defaultFieldsInjected += stats.defaultFieldsInjected
  }
  
  // POST-PROCESS: Rename auth entity aliases → "users", inject role field
  const authNorm = normalizeAuthEntityNames(normalizedEntities)
  const finalEntities = authNorm.entities
  allWarnings.push(...authNorm.warnings)

  if (authNorm.warnings.length > 0) {
    console.log('[Schema Normalizer] Auth entity normalization:', authNorm.warnings)
  }

  console.log('[Schema Normalizer] Normalization complete')
  console.log('[DEBUG NORMALIZER OUTPUT]', JSON.stringify(finalEntities, null, 2))
  console.log('[Schema Normalizer] Output entities:', finalEntities.map(e => ({
    name: e.name,
    fieldCount: e.fields.length,
    fields: e.fields.map(f => f.name)
  })))
  
  // Validate normalized schema (with auto-repair)
  const validation = validateNormalizedSchema(finalEntities)
  
  const success = validation.errors.length === 0
  
  // If repairs were made, add to warnings
  if (validation.repaired) {
    allWarnings.push('Some field names were auto-repaired to valid snake_case')
  }
  
  logger.info('[Schema Normalizer] Normalization complete', {
    success,
    stats: allStats,
    errorCount: validation.errors.length,
    warningCount: allWarnings.length,
    repaired: validation.repaired,
  })
  
  if (!success) {
    logger.error('[Schema Normalizer] Validation failed', {
      errors: validation.errors,
    })
  }
  
  return {
    success,
    entities: finalEntities,
    errors: validation.errors,
    warnings: allWarnings,
    stats: allStats,
  }
}

/**
 * Convert normalized entities to batch plan format
 * 
 * Used to integrate with existing batch planner
 */
export function normalizedToBatchPlan(normalized: NormalizedEntity[]): any {
  return {
    entities: normalized.map(entity => ({
      name: entity.name,
      fields: entity.fields.map(field => ({
        name: field.name,
        type: field.type,
        required: field.required,
        unique: field.unique,
        relationTo: field.relationTo,
      })),
    })),
  }
}
