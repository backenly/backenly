/**
 * Suggestion Storage Layer
 * 
 * Project-scoped, graph-version-aware suggestion persistence.
 * Suggestions are tied to specific graph versions for auditability.
 */

import { prisma } from '@/lib/db'
import { Suggestion } from './suggestion-engine'

export interface StoredSuggestion extends Suggestion {
  graphId: string
}

/**
 * Store suggestions for a project
 * 
 * Associates suggestions with the specific graph version they were generated from.
 * This enables version-aware suggestion history.
 */
export async function storeSuggestions(
  projectId: string,
  graphId: string,
  suggestions: Suggestion[]
): Promise<void> {
  if (suggestions.length === 0) {
    console.log(`[Suggestion Store] No suggestions to store for ${projectId}`)
    return
  }
  
  try {
    // Delete old suggestions for this graph (idempotent)
    await prisma.projectSuggestion.deleteMany({
      where: { projectId, graphId }
    })
    
    // Store new suggestions
    const data = suggestions.map(s => ({
      projectId,
      graphId,
      type: s.type,
      severity: s.severity,
      message: s.message,
      rationale: s.rationale,
      suggestedPrompt: s.suggestedPrompt,
      createdAt: s.createdAt,
    }))
    
    await prisma.projectSuggestion.createMany({ data })
    
    console.log(`[Suggestion Store] Stored ${suggestions.length} suggestions for ${projectId} (graph: ${graphId.slice(0, 8)}...)`)
  } catch (error) {
    console.error('[Suggestion Store] Failed to store suggestions:', error)
    // Non-critical: don't fail execution if suggestion storage fails
  }
}

/**
 * Get active suggestions for a project
 * 
 * Returns suggestions tied to the current active graph version.
 */
export async function getActiveSuggestions(projectId: string): Promise<StoredSuggestion[]> {
  try {
    // Get current active graph
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { activeGraphId: true }
    })
    
    if (!project?.activeGraphId) {
      return []
    }
    
    // Get suggestions for active graph
    const suggestions = await prisma.projectSuggestion.findMany({
      where: {
        projectId,
        graphId: project.activeGraphId,
      },
      orderBy: [
        { severity: 'desc' },
        { createdAt: 'desc' },
      ],
    })
    
    return suggestions.map(s => ({
      id: s.id,
      graphId: s.graphId,
      type: s.type as Suggestion['type'],
      severity: s.severity as Suggestion['severity'],
      message: s.message,
      rationale: s.rationale,
      suggestedPrompt: s.suggestedPrompt || undefined,
      createdAt: s.createdAt,
    }))
  } catch (error) {
    console.error('[Suggestion Store] Failed to get suggestions:', error)
    return []
  }
}

/**
 * Get suggestion history for a project
 * 
 * Returns all suggestions across all graph versions.
 */
export async function getSuggestionHistory(
  projectId: string,
  limit: number = 50
): Promise<StoredSuggestion[]> {
  try {
    const suggestions = await prisma.projectSuggestion.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    
    return suggestions.map(s => ({
      id: s.id,
      graphId: s.graphId,
      type: s.type as Suggestion['type'],
      severity: s.severity as Suggestion['severity'],
      message: s.message,
      rationale: s.rationale,
      suggestedPrompt: s.suggestedPrompt || undefined,
      createdAt: s.createdAt,
    }))
  } catch (error) {
    console.error('[Suggestion Store] Failed to get history:', error)
    return []
  }
}

/**
 * Clear suggestions for a project (e.g., after undo)
 * 
 * Removes suggestions tied to graphs that are no longer active.
 */
export async function clearInactiveSuggestions(projectId: string): Promise<number> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { activeGraphId: true }
    })
    
    if (!project?.activeGraphId) {
      return 0
    }
    
    const result = await prisma.projectSuggestion.deleteMany({
      where: {
        projectId,
        graphId: { not: project.activeGraphId },
      },
    })
    
    console.log(`[Suggestion Store] Cleared ${result.count} inactive suggestions for ${projectId}`)
    return result.count
  } catch (error) {
    console.error('[Suggestion Store] Failed to clear inactive:', error)
    return 0
  }
}
