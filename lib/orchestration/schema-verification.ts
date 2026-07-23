/**
 * PHASE 2: SCHEMA VERIFICATION LAYER
 * 
 * Compares extracted intent vs planned schema before execution.
 * Catches missing fields, type mismatches, and constraint violations.
 * 
 * This is a SAFETY NET - prevents execution if extraction is incomplete.
 */

import { CanonicalIntent } from './types'
import { ExecutionPlan } from './execution-plan-generator'

export interface VerificationError {
  type: 'missing_field' | 'type_mismatch' | 'constraint_violation' | 'reference_invalid'
  field?: string
  entity: string
  expected?: any
  actual?: any
  severity: 'error' | 'warning'
  message: string
  suggestion?: string
}

export interface VerificationResult {
  valid: boolean
  errors: VerificationError[]
  warnings: VerificationError[]
  confidence: number // 0-1
  summary: string
}

/**
 * Verify that execution plan matches user intent
 * 
 * This prevents silent field loss by validating BEFORE execution.
 */
export function verifySchemaAlignment(
  intent: CanonicalIntent,
  executionPlan: ExecutionPlan,
  sourceText: string
): VerificationResult {
  const errors: VerificationError[] = []
  const warnings: VerificationError[] = []
  
  // Find table creation step
  const tableSteps = executionPlan.steps.filter(s => s.action === 'CREATE_TABLE')
  
  if (tableSteps.length === 0) {
    errors.push({
      type: 'missing_field',
      entity: intent.target || 'unknown',
      severity: 'error',
      message: 'No table creation step found in execution plan',
      suggestion: 'Check if intent was properly converted to execution steps',
    })
    
    return {
      valid: false,
      errors,
      warnings,
      confidence: 0,
      summary: 'Execution plan is missing table creation steps',
    }
  }
  
  // Verify each table
  tableSteps.forEach(step => {
    const tableName = step.target
    const columns = step.params.columns || []
    const intentFields = intent.constraints.fields || []
    
    // Check if user specified fields in intent
    if (intentFields.length > 0) {
      // Verify all intent fields are present in execution plan
      intentFields.forEach((intentField: any) => {
        const fieldName = intentField.type === 'reference' && intentField.referenceTo
          ? `${intentField.referenceTo}_id`
          : intentField.name
        
        const columnExists = columns.some((col: any) => col.name === fieldName)
        
        if (!columnExists) {
          errors.push({
            type: 'missing_field',
            field: intentField.name,
            entity: tableName,
            severity: 'error',
            message: `Field "${intentField.name}" from intent is missing in execution plan`,
            suggestion: `Add column "${fieldName}" to ${tableName} table`,
          })
        }
      })
    } else {
      // No explicit fields in intent - check if this is expected
      const systemColumnsOnly = columns.every((col: any) => 
        col.name === 'id' || col.name === 'createdAt' || col.name === 'updatedAt'
      )
      
      if (systemColumnsOnly) {
        warnings.push({
          type: 'missing_field',
          entity: tableName,
          severity: 'warning',
          message: `Table "${tableName}" has only system fields (id, timestamps). User may have expected custom fields.`,
          suggestion: `Consider asking user: "What fields should ${tableName} have?"`,
        })
      }
    }
    
    // Verify reference fields point to valid entities
    columns.forEach((col: any) => {
      if (col.referenceTo) {
        // Check if referenced entity exists or will be created
        const referencedTableExists = tableSteps.some(s => s.target === col.referenceTo)
        
        if (!referencedTableExists) {
          warnings.push({
            type: 'reference_invalid',
            field: col.name,
            entity: tableName,
            expected: col.referenceTo,
            severity: 'warning',
            message: `Field "${col.name}" references "${col.referenceTo}" but that table is not being created`,
            suggestion: `Ensure "${col.referenceTo}" table exists or will be created first`,
          })
        }
      }
    })
  })
  
  // Calculate confidence based on errors and warnings
  const errorWeight = errors.length * 0.3
  const warningWeight = warnings.length * 0.1
  const confidence = Math.max(0, 1 - errorWeight - warningWeight)
  
  // Generate summary
  let summary = ''
  if (errors.length === 0 && warnings.length === 0) {
    summary = '✅ Schema verification passed - all fields aligned with intent'
  } else if (errors.length > 0) {
    summary = `❌ Schema verification failed - ${errors.length} error(s) found`
  } else {
    summary = `⚠️  Schema verification passed with ${warnings.length} warning(s)`
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    confidence,
    summary,
  }
}

/**
 * Verify field extraction quality
 * 
 * Checks if extracted fields match common patterns and expectations.
 */
export function verifyFieldExtraction(
  entityName: string,
  extractedFields: any[],
  sourceText: string
): VerificationResult {
  const errors: VerificationError[] = []
  const warnings: VerificationError[] = []
  
  // Common field expectations for specific entity types
  const ENTITY_EXPECTATIONS: Record<string, string[]> = {
    users: ['email', 'name', 'password'],
    posts: ['title', 'content'],
    articles: ['title', 'content'],
    products: ['name', 'price'],
    comments: ['content', 'user_id', 'post_id'],
    profiles: ['name', 'bio'],
    projects: ['name', 'description'],
    tasks: ['title', 'description'],
  }
  
  const expectedFields = ENTITY_EXPECTATIONS[entityName.toLowerCase()]
  
  if (expectedFields) {
    expectedFields.forEach(expectedField => {
      const fieldExists = extractedFields.some(f => 
        f.name === expectedField || f.name.includes(expectedField)
      )
      
      if (!fieldExists) {
        // Check if user explicitly mentioned this field
        const lowerText = sourceText.toLowerCase()
        const fieldMentioned = lowerText.includes(expectedField)
        
        if (fieldMentioned) {
          errors.push({
            type: 'missing_field',
            field: expectedField,
            entity: entityName,
            severity: 'error',
            message: `User mentioned "${expectedField}" but it's missing from extracted fields`,
            suggestion: `Add "${expectedField}" field to ${entityName}`,
          })
        } else {
          warnings.push({
            type: 'missing_field',
            field: expectedField,
            entity: entityName,
            severity: 'warning',
            message: `Common field "${expectedField}" not found in ${entityName} entity`,
            suggestion: `Consider asking: "Should ${entityName} have a ${expectedField} field?"`,
          })
        }
      }
    })
  }
  
  // Verify field names are valid
  extractedFields.forEach(field => {
    // Check for invalid characters
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field.name)) {
      errors.push({
        type: 'constraint_violation',
        field: field.name,
        entity: entityName,
        severity: 'error',
        message: `Invalid field name: "${field.name}" (must start with letter/underscore, contain only letters/numbers/underscores)`,
        suggestion: `Rename to a valid identifier like "${field.name.replace(/[^a-zA-Z0-9_]/g, '_')}"`,
      })
    }
    
    // Check for SQL reserved keywords
    const RESERVED_KEYWORDS = ['select', 'from', 'where', 'group', 'order', 'table', 'user', 'index']
    if (RESERVED_KEYWORDS.includes(field.name.toLowerCase())) {
      warnings.push({
        type: 'constraint_violation',
        field: field.name,
        entity: entityName,
        severity: 'warning',
        message: `Field "${field.name}" is a SQL reserved keyword`,
        suggestion: `Consider renaming to "${field.name}_value" or "${entityName}_${field.name}"`,
      })
    }
  })
  
  const confidence = errors.length === 0 ? 0.95 : 0.5
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    confidence,
    summary: errors.length === 0 
      ? `✅ Extracted ${extractedFields.length} fields for ${entityName}`
      : `❌ Field extraction incomplete for ${entityName}`,
  }
}

/**
 * Generate clarification question if verification fails
 */
export function generateClarificationQuestion(verificationResult: VerificationResult): string | null {
  if (verificationResult.valid) {
    return null
  }
  
  const missingFields = verificationResult.errors
    .filter(e => e.type === 'missing_field')
    .map(e => e.field)
    .filter(Boolean)
  
  if (missingFields.length > 0) {
    const entity = verificationResult.errors[0].entity
    return `I want to create the ${entity} entity, but I need clarification on the fields. You mentioned: ${missingFields.join(', ')}. Could you confirm what fields ${entity} should have? For example: "${entity} should have: name (text), email (required), bio (optional)"`
  }
  
  return 'I need more details about the data structure. Could you specify what fields each entity should have?'
}
