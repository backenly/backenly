/**
 * PHASE 2: ARCHITECTURAL MEMORY SYSTEM
 * 
 * Persists architectural decisions and user preferences per project.
 * Enables the agent to learn user style and adapt future suggestions.
 * 
 * This transforms Backenly from "stateless architect" to "learning collaborator".
 */

import { prisma } from '@/lib/db/prisma'
import { logger } from '@/lib/logger'

/**
 * Architectural memory for a project
 */
export interface ArchitecturalMemory {
  projectId: string
  
  // Naming conventions learned from user
  namingStyle: {
    entityCase: 'camelCase' | 'snake_case' | 'PascalCase' | 'mixed'
    fieldCase: 'camelCase' | 'snake_case' | 'mixed'
    preferredSuffixes: string[] // e.g., ['_id', 'Id', 'ID']
  }
  
  // Relation preferences
  preferredRelations: {
    strategy: 'explicit' | 'implicit' | 'mixed'
    foreignKeyPattern: string // e.g., 'userId' vs 'user_id'
    junctionTablePattern: string // e.g., 'user_posts' vs 'users_posts'
  }
  
  // Entities user rejected or removed
  rejectedEntities: Array<{
    name: string
    reason?: string
    timestamp: string
  }>
  
  // Integration patterns user chose
  integrationPatterns: Array<{
    scenario: string // e.g., 'adding reviews to learning platform'
    chosenOption: string // e.g., 'fully_integrated'
    optionTitle: string
    timestamp: string
  }>
  
  // Schema evolution history
  schemaHistory: Array<{
    action: 'create' | 'extend' | 'modify' | 'delete'
    entityName: string
    description: string
    timestamp: string
  }>
  
  // User corrections (when they fix AI inference)
  userCorrections: Array<{
    aiSuggested: string
    userCorrected: string
    context: string
    timestamp: string
  }>
  
  // Last updated
  updatedAt: string
}

/**
 * Initialize empty memory for a project
 */
export function createEmptyMemory(projectId: string): ArchitecturalMemory {
  return {
    projectId,
    namingStyle: {
      entityCase: 'snake_case', // Default to snake_case
      fieldCase: 'camelCase',
      preferredSuffixes: [],
    },
    preferredRelations: {
      strategy: 'explicit',
      foreignKeyPattern: 'userId',
      junctionTablePattern: 'user_posts',
    },
    rejectedEntities: [],
    integrationPatterns: [],
    schemaHistory: [],
    userCorrections: [],
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Load architectural memory for a project
 */
export async function loadArchitecturalMemory(
  projectId: string
): Promise<ArchitecturalMemory> {
  try {
    logger.info('[Arch Memory] Loading memory', { projectId })
    
    // Load from project metadata
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        architecturalMemory: true,
      },
    })
    
    if (!project) {
      logger.warn('[Arch Memory] Project not found, creating empty memory', { projectId })
      return createEmptyMemory(projectId)
    }
    
    // Parse stored memory
    if (project.architecturalMemory) {
      const memory = JSON.parse(project.architecturalMemory as string)
      logger.info('[Arch Memory] Memory loaded', {
        projectId,
        integrationPatterns: memory.integrationPatterns?.length || 0,
        corrections: memory.userCorrections?.length || 0,
      })
      return memory
    }
    
    // First time - create empty memory
    logger.info('[Arch Memory] No memory found, creating new', { projectId })
    return createEmptyMemory(projectId)
    
  } catch (error: any) {
    logger.error('[Arch Memory] Load failed', {
      projectId,
      error: error.message,
    })
    return createEmptyMemory(projectId)
  }
}

/**
 * Save architectural memory for a project
 */
export async function saveArchitecturalMemory(
  memory: ArchitecturalMemory
): Promise<boolean> {
  try {
    memory.updatedAt = new Date().toISOString()
    
    logger.info('[Arch Memory] Saving memory', {
      projectId: memory.projectId,
      integrationPatterns: memory.integrationPatterns.length,
      corrections: memory.userCorrections.length,
    })
    
    await prisma.project.update({
      where: { id: memory.projectId },
      data: {
        architecturalMemory: JSON.stringify(memory),
      },
    })
    
    logger.info('[Arch Memory] Memory saved successfully', {
      projectId: memory.projectId,
    })
    
    return true
    
  } catch (error: any) {
    logger.error('[Arch Memory] Save failed', {
      projectId: memory.projectId,
      error: error.message,
    })
    return false
  }
}

/**
 * Record an integration pattern choice
 */
export async function recordIntegrationChoice(
  projectId: string,
  scenario: string,
  chosenOptionId: string,
  chosenOptionTitle: string
): Promise<void> {
  try {
    const memory = await loadArchitecturalMemory(projectId)
    
    memory.integrationPatterns.push({
      scenario,
      chosenOption: chosenOptionId,
      optionTitle: chosenOptionTitle,
      timestamp: new Date().toISOString(),
    })
    
    await saveArchitecturalMemory(memory)
    
    logger.info('[Arch Memory] Integration choice recorded', {
      projectId,
      scenario,
      option: chosenOptionId,
    })
    
  } catch (error: any) {
    logger.error('[Arch Memory] Failed to record integration choice', {
      projectId,
      error: error.message,
    })
  }
}

/**
 * Record a schema change
 */
export async function recordSchemaChange(
  projectId: string,
  action: 'create' | 'extend' | 'modify' | 'delete',
  entityName: string,
  description: string
): Promise<void> {
  try {
    const memory = await loadArchitecturalMemory(projectId)
    
    memory.schemaHistory.push({
      action,
      entityName,
      description,
      timestamp: new Date().toISOString(),
    })
    
    // Learn naming style from entity names
    if (action === 'create') {
      detectAndUpdateNamingStyle(memory, entityName)
    }
    
    await saveArchitecturalMemory(memory)
    
    logger.info('[Arch Memory] Schema change recorded', {
      projectId,
      action,
      entityName,
    })
    
  } catch (error: any) {
    logger.error('[Arch Memory] Failed to record schema change', {
      projectId,
      error: error.message,
    })
  }
}

/**
 * Record a rejected entity
 */
export async function recordRejectedEntity(
  projectId: string,
  entityName: string,
  reason?: string
): Promise<void> {
  try {
    const memory = await loadArchitecturalMemory(projectId)
    
    memory.rejectedEntities.push({
      name: entityName,
      reason,
      timestamp: new Date().toISOString(),
    })
    
    await saveArchitecturalMemory(memory)
    
    logger.info('[Arch Memory] Rejected entity recorded', {
      projectId,
      entityName,
    })
    
  } catch (error: any) {
    logger.error('[Arch Memory] Failed to record rejection', {
      projectId,
      error: error.message,
    })
  }
}

/**
 * Record a user correction
 */
export async function recordUserCorrection(
  projectId: string,
  aiSuggested: string,
  userCorrected: string,
  context: string
): Promise<void> {
  try {
    const memory = await loadArchitecturalMemory(projectId)
    
    memory.userCorrections.push({
      aiSuggested,
      userCorrected,
      context,
      timestamp: new Date().toISOString(),
    })
    
    await saveArchitecturalMemory(memory)
    
    logger.info('[Arch Memory] User correction recorded', {
      projectId,
      correction: `${aiSuggested} → ${userCorrected}`,
    })
    
  } catch (error: any) {
    logger.error('[Arch Memory] Failed to record correction', {
      projectId,
      error: error.message,
    })
  }
}

/**
 * Detect naming style from entity name
 */
function detectAndUpdateNamingStyle(
  memory: ArchitecturalMemory,
  entityName: string
): void {
  // Check casing
  if (entityName === entityName.toLowerCase()) {
    if (entityName.includes('_')) {
      memory.namingStyle.entityCase = 'snake_case'
    } else {
      memory.namingStyle.entityCase = 'camelCase'
    }
  } else if (entityName[0] === entityName[0].toUpperCase()) {
    memory.namingStyle.entityCase = 'PascalCase'
  } else {
    memory.namingStyle.entityCase = 'camelCase'
  }
}

/**
 * Generate memory context for AI prompts
 */
export function generateMemoryContext(memory: ArchitecturalMemory): string {
  const parts: string[] = []
  
  // Naming preferences
  parts.push(`NAMING STYLE: ${memory.namingStyle.entityCase} for entities, ${memory.namingStyle.fieldCase} for fields`)
  
  // Relation preferences
  parts.push(`RELATIONS: ${memory.preferredRelations.strategy} strategy, foreign keys like "${memory.preferredRelations.foreignKeyPattern}"`)
  
  // Rejected entities
  if (memory.rejectedEntities.length > 0) {
    const rejected = memory.rejectedEntities.slice(-3).map(r => r.name).join(', ')
    parts.push(`AVOID: User previously rejected ${rejected}`)
  }
  
  // Integration patterns
  if (memory.integrationPatterns.length > 0) {
    const recent = memory.integrationPatterns.slice(-2)
    const patterns = recent.map(p => `${p.scenario} → chose "${p.optionTitle}"`).join('; ')
    parts.push(`PAST CHOICES: ${patterns}`)
  }
  
  // User corrections
  if (memory.userCorrections.length > 0) {
    const recent = memory.userCorrections.slice(-2)
    const corrections = recent.map(c => `"${c.aiSuggested}" → "${c.userCorrected}"`).join('; ')
    parts.push(`LEARNED CORRECTIONS: ${corrections}`)
  }
  
  return parts.join('\n')
}

/**
 * Check if an entity was previously rejected
 */
export function wasEntityRejected(
  memory: ArchitecturalMemory,
  entityName: string
): boolean {
  return memory.rejectedEntities.some(
    r => r.name.toLowerCase() === entityName.toLowerCase()
  )
}

/**
 * Get preferred integration strategy based on history
 */
export function getPreferredIntegrationStrategy(
  memory: ArchitecturalMemory
): 'simple' | 'integrated' | 'comprehensive' | null {
  if (memory.integrationPatterns.length === 0) {
    return null
  }
  
  // Analyze recent choices
  const recent = memory.integrationPatterns.slice(-5)
  const choices = recent.map(p => p.chosenOption)
  
  // Count preference patterns
  const simpleCount = choices.filter(c => c.includes('simple') || c.includes('standalone')).length
  const integratedCount = choices.filter(c => c.includes('integrated')).length
  const comprehensiveCount = choices.filter(c => c.includes('comprehensive') || c.includes('full')).length
  
  if (comprehensiveCount > integratedCount && comprehensiveCount > simpleCount) {
    return 'comprehensive'
  } else if (integratedCount > simpleCount) {
    return 'integrated'
  } else if (simpleCount > 0) {
    return 'simple'
  }
  
  return null
}
