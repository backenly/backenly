/**
 * PHASE 4: SCHEMA EVOLUTION INTELLIGENCE
 * 
 * Detects schema quality issues and proposes structural refactoring.
 * Enables the schema to evolve and improve over time.
 */

import { logger } from '@/lib/logger'
import type { BackendStateGraph, EntityState } from '@/lib/orchestration/backend-state-graph'

/**
 * Schema issue types
 */
export type IssueType = 
  | 'duplicate_entities'
  | 'similar_entities'
  | 'overgrown_entity'
  | 'denormalized_data'
  | 'missing_relation'
  | 'poor_naming'
  | 'redundant_fields'

/**
 * Schema quality issue
 */
export interface SchemaIssue {
  type: IssueType
  severity: 'low' | 'medium' | 'high'
  entities: string[]
  description: string
  impact: string
}

/**
 * Refactoring suggestion
 */
export interface RefactoringSuggestion {
  id: string
  type: 'merge' | 'split' | 'normalize' | 'rename' | 'add_relation'
  title: string
  description: string
  before: {
    entities: string[]
    structure: string
  }
  after: {
    entities: string[]
    structure: string
  }
  benefits: string[]
  risks: string[]
  effort: 'low' | 'medium' | 'high'
}

/**
 * Schema evolution analysis result
 */
export interface EvolutionAnalysis {
  health: {
    score: number // 0-100
    grade: 'A' | 'B' | 'C' | 'D' | 'F'
  }
  issues: SchemaIssue[]
  suggestions: RefactoringSuggestion[]
  metrics: {
    entityCount: number
    relationCount: number
    avgFieldsPerEntity: number
    namingConsistency: number
  }
}

/**
 * Analyze schema health and evolution opportunities
 */
export function analyzeSchemaEvolution(graph: BackendStateGraph): EvolutionAnalysis {
  const startTime = Date.now()
  
  logger.info('[Schema Evolution] Starting analysis', {
    entities: Object.keys(graph.entities).length,
  })
  
  const issues: SchemaIssue[] = []
  const suggestions: RefactoringSuggestion[] = []
  
  // Calculate metrics
  const entityCount = Object.keys(graph.entities).length
  const entities = Object.values(graph.entities)
  
  let totalFields = 0
  let totalRelations = 0
  
  for (const entity of entities) {
    const fields = Object.values(entity.fields || {})
    totalFields += fields.length
    totalRelations += fields.filter(f => f.type === 'relation').length
  }
  
  const avgFieldsPerEntity = entityCount > 0 ? totalFields / entityCount : 0
  
  // Detect issues
  detectDuplicateEntities(graph, issues, suggestions)
  detectSimilarEntities(graph, issues, suggestions)
  detectOvergrownEntities(graph, issues, suggestions)
  detectMissingRelations(graph, issues, suggestions)
  detectPoorNaming(graph, issues)
  
  // Calculate naming consistency
  const namingConsistency = calculateNamingConsistency(graph)
  
  // Calculate health score
  const healthScore = calculateHealthScore(issues, entityCount, avgFieldsPerEntity, namingConsistency)
  const healthGrade = getHealthGrade(healthScore)
  
  const duration = Date.now() - startTime
  logger.info('[Schema Evolution] Analysis complete', {
    healthScore,
    healthGrade,
    issues: issues.length,
    suggestions: suggestions.length,
    duration,
  })
  
  return {
    health: {
      score: healthScore,
      grade: healthGrade,
    },
    issues,
    suggestions,
    metrics: {
      entityCount,
      relationCount: totalRelations,
      avgFieldsPerEntity: Math.round(avgFieldsPerEntity * 10) / 10,
      namingConsistency: Math.round(namingConsistency * 100),
    },
  }
}

/**
 * Detect duplicate entities (exact same purpose)
 */
function detectDuplicateEntities(
  graph: BackendStateGraph,
  issues: SchemaIssue[],
  suggestions: RefactoringSuggestion[]
): void {
  const entityNames = Object.keys(graph.entities)
  
  // Check for plural/singular variations
  for (let i = 0; i < entityNames.length; i++) {
    for (let j = i + 1; j < entityNames.length; j++) {
      const name1 = entityNames[i].toLowerCase()
      const name2 = entityNames[j].toLowerCase()
      
      if (
        (name1 + 's' === name2) ||
        (name1 === name2 + 's') ||
        (name1.replace(/s$/, '') === name2.replace(/s$/, ''))
      ) {
        issues.push({
          type: 'duplicate_entities',
          severity: 'high',
          entities: [entityNames[i], entityNames[j]],
          description: `"${entityNames[i]}" and "${entityNames[j]}" appear to be duplicates`,
          impact: 'Data fragmentation, confusion',
        })
        
        suggestions.push({
          id: `merge_${entityNames[i]}_${entityNames[j]}`,
          type: 'merge',
          title: `Merge "${entityNames[i]}" and "${entityNames[j]}"`,
          description: 'Consolidate into a single entity',
          before: {
            entities: [entityNames[i], entityNames[j]],
            structure: 'Two separate tables with similar data',
          },
          after: {
            entities: [entityNames[i]],
            structure: 'Single consolidated table',
          },
          benefits: ['Data consistency', 'Simpler queries', 'No duplication'],
          risks: ['Requires data migration', 'May need relation updates'],
          effort: 'medium',
        })
      }
    }
  }
}

/**
 * Detect similar entities (could be merged)
 */
function detectSimilarEntities(
  graph: BackendStateGraph,
  issues: SchemaIssue[],
  suggestions: RefactoringSuggestion[]
): void {
  const entityNames = Object.keys(graph.entities)
  
  // Pattern: user_posts and blog_posts (could be just "posts")
  const patterns = [
    { prefix: 'user_', suffix: '' },
    { prefix: 'blog_', suffix: '' },
    { prefix: '', suffix: '_items' },
  ]
  
  for (const pattern of patterns) {
    const matches = entityNames.filter(name => 
      name.startsWith(pattern.prefix) && name.endsWith(pattern.suffix)
    )
    
    if (matches.length > 1) {
      issues.push({
        type: 'similar_entities',
        severity: 'medium',
        entities: matches,
        description: `Multiple "${pattern.prefix}*${pattern.suffix}" entities could potentially be consolidated`,
        impact: 'Increased complexity',
      })
    }
  }
}

/**
 * Detect overgrown entities (too many fields)
 */
function detectOvergrownEntities(
  graph: BackendStateGraph,
  issues: SchemaIssue[],
  suggestions: RefactoringSuggestion[]
): void {
  const FIELD_THRESHOLD = 15
  
  for (const [entityName, entity] of Object.entries(graph.entities)) {
    const fieldCount = Object.keys(entity.fields || {}).length
    
    if (fieldCount > FIELD_THRESHOLD) {
      issues.push({
        type: 'overgrown_entity',
        severity: 'medium',
        entities: [entityName],
        description: `"${entityName}" has ${fieldCount} fields (threshold: ${FIELD_THRESHOLD})`,
        impact: 'Hard to maintain, performance concerns',
      })
      
      suggestions.push({
        id: `split_${entityName}`,
        type: 'split',
        title: `Split "${entityName}" into smaller entities`,
        description: 'Extract related fields into separate tables',
        before: {
          entities: [entityName],
          structure: `Single table with ${fieldCount} fields`,
        },
        after: {
          entities: [entityName, `${entityName}_details`, `${entityName}_settings`],
          structure: 'Multiple focused tables with relations',
        },
        benefits: ['Better organization', 'Faster queries', 'Clearer responsibility'],
        risks: ['More complex joins', 'Migration required'],
        effort: 'high',
      })
    }
  }
}

/**
 * Detect missing relations (entities that should be linked)
 */
function detectMissingRelations(
  graph: BackendStateGraph,
  issues: SchemaIssue[],
  suggestions: RefactoringSuggestion[]
): void {
  const entityNames = Object.keys(graph.entities)
  
  // Common patterns
  const relatedPairs = [
    ['users', 'posts'],
    ['users', 'comments'],
    ['posts', 'comments'],
    ['courses', 'lessons'],
    ['orders', 'order_items'],
  ]
  
  for (const [entity1, entity2] of relatedPairs) {
    const has1 = entityNames.some(n => n.toLowerCase().includes(entity1))
    const has2 = entityNames.some(n => n.toLowerCase().includes(entity2))
    
    if (has1 && has2) {
      const actualEntity1 = entityNames.find(n => n.toLowerCase().includes(entity1))!
      const actualEntity2 = entityNames.find(n => n.toLowerCase().includes(entity2))!
      
      // Check if relation exists
      const entity2Fields = Object.values(graph.entities[actualEntity2]?.fields || {})
      const hasRelation = entity2Fields.some(f => {
        if (f.type === 'relation') {
          const relationField = f as any
          return relationField.relationTo && relationField.relationTo.toLowerCase().includes(entity1)
        }
        return false
      })
      
      if (!hasRelation) {
        issues.push({
          type: 'missing_relation',
          severity: 'medium',
          entities: [actualEntity1, actualEntity2],
          description: `"${actualEntity2}" should probably link to "${actualEntity1}"`,
          impact: 'Disconnected data',
        })
        
        suggestions.push({
          id: `link_${actualEntity2}_to_${actualEntity1}`,
          type: 'add_relation',
          title: `Link "${actualEntity2}" to "${actualEntity1}"`,
          description: `Add foreign key relationship`,
          before: {
            entities: [actualEntity2],
            structure: 'No relation to users',
          },
          after: {
            entities: [actualEntity2],
            structure: `Links to ${actualEntity1} via foreign key`,
          },
          benefits: ['Data integrity', 'Query efficiency', 'Clear ownership'],
          risks: ['Existing data may need userId'],
          effort: 'low',
        })
      }
    }
  }
}

/**
 * Detect poor naming conventions
 */
function detectPoorNaming(graph: BackendStateGraph, issues: SchemaIssue[]): void {
  for (const entityName of Object.keys(graph.entities)) {
    // Check for inconsistent casing
    if (entityName !== entityName.toLowerCase() && entityName !== entityName.toUpperCase()) {
      const hasMixedCase = /[a-z]/.test(entityName) && /[A-Z]/.test(entityName)
      if (hasMixedCase && !entityName.includes('_')) {
        issues.push({
          type: 'poor_naming',
          severity: 'low',
          entities: [entityName],
          description: `"${entityName}" uses mixed casing without underscores`,
          impact: 'Naming inconsistency',
        })
      }
    }
  }
}

/**
 * Calculate naming consistency score
 */
function calculateNamingConsistency(graph: BackendStateGraph): number {
  const entityNames = Object.keys(graph.entities)
  if (entityNames.length === 0) return 1.0
  
  const isSnakeCase = (name: string) => name === name.toLowerCase() && name.includes('_')
  const isCamelCase = (name: string) => /^[a-z][a-zA-Z]*$/.test(name)
  const isPascalCase = (name: string) => /^[A-Z][a-zA-Z]*$/.test(name)
  
  const snakeCount = entityNames.filter(isSnakeCase).length
  const camelCount = entityNames.filter(isCamelCase).length
  const pascalCount = entityNames.filter(isPascalCase).length
  
  const maxCount = Math.max(snakeCount, camelCount, pascalCount)
  return maxCount / entityNames.length
}

/**
 * Calculate overall health score
 */
function calculateHealthScore(
  issues: SchemaIssue[],
  entityCount: number,
  avgFields: number,
  namingConsistency: number
): number {
  let score = 100
  
  // Penalize for issues
  for (const issue of issues) {
    if (issue.severity === 'high') score -= 15
    else if (issue.severity === 'medium') score -= 8
    else score -= 3
  }
  
  // Penalize for too many entities (complexity)
  if (entityCount > 20) score -= (entityCount - 20) * 2
  
  // Penalize for poor naming consistency
  score -= (1 - namingConsistency) * 20
  
  // Bonus for good field count
  if (avgFields >= 4 && avgFields <= 10) score += 5
  
  return Math.max(0, Math.min(100, Math.round(score)))
}

/**
 * Convert score to letter grade
 */
function getHealthGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  return 'F'
}
