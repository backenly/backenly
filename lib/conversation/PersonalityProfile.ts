/**
 * MISSING PIECE 3: CONVERSATIONAL PERSONALITY CONTINUITY
 * 
 * Stateful personality that adapts to user style
 * Remembers: verbosity preference, explanation depth, confirmation strictness
 * 
 * CRITICAL CONSTRAINTS:
 * - Profile stored client-side (localStorage/state)
 * - Does NOT affect execution logic
 * - Only affects response tone and UI verbosity
 * - Non-invasive: defaults to standard behavior
 */

export interface PersonalityProfile {
  projectId: string
  userId?: string
  
  // Communication style preferences
  verbosityLevel: 'terse' | 'normal' | 'detailed' // Learned from interactions
  explanationDepth: 'minimal' | 'standard' | 'comprehensive' // User preference
  confirmationStrictness: 'relaxed' | 'balanced' | 'strict' // Based on confidence patterns
  
  // Interaction patterns (learned)
  averagePromptLength: number // Word count average
  prefersExamples: boolean // User often asks "show me an example"
  prefersStepByStep: boolean // User asks for breakdowns
  prefersTechnicalTerms: boolean // User uses technical language
  
  // Trust signals (behavioral)
  rollbackFrequency: number // How often user rolls back (0-1)
  editFrequency: number // How often user edits intent before confirm (0-1)
  autoConfirmRate: number // How often proceeds without modification (0-1)
  
  // Temporal
  createdAt: string
  lastUpdatedAt: string
  interactionCount: number
}

/**
 * Default personality profile
 */
export function createDefaultProfile(projectId: string): PersonalityProfile {
  return {
    projectId,
    verbosityLevel: 'normal',
    explanationDepth: 'standard',
    confirmationStrictness: 'balanced',
    averagePromptLength: 0,
    prefersExamples: false,
    prefersStepByStep: false,
    prefersTechnicalTerms: false,
    rollbackFrequency: 0,
    editFrequency: 0,
    autoConfirmRate: 1.0,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    interactionCount: 0,
  }
}

/**
 * Personality profile manager
 */
class PersonalityProfileManager {
  private profiles: Map<string, PersonalityProfile> = new Map()
  private readonly STORAGE_KEY = 'backenly_personality_profiles'

  constructor() {
    this.loadFromStorage()
  }

  /**
   * Get profile for a project (creates if doesn't exist)
   */
  getProfile(projectId: string): PersonalityProfile {
    let profile = this.profiles.get(projectId)
    
    if (!profile) {
      profile = createDefaultProfile(projectId)
      this.profiles.set(projectId, profile)
      this.saveToStorage()
    }
    
    return profile
  }

  /**
   * Update profile based on interaction
   */
  updateFromInteraction(
    projectId: string,
    interaction: {
      promptLength?: number
      wasEdited?: boolean
      wasRolledBack?: boolean
      autoConfirmed?: boolean
      usedTechnicalTerms?: boolean
      askedForExamples?: boolean
      askedForSteps?: boolean
    }
  ): PersonalityProfile {
    const profile = this.getProfile(projectId)
    
    // Update interaction count
    profile.interactionCount++
    
    // Update average prompt length
    if (interaction.promptLength !== undefined) {
      profile.averagePromptLength = 
        (profile.averagePromptLength * (profile.interactionCount - 1) + interaction.promptLength) 
        / profile.interactionCount
    }
    
    // Update edit frequency
    if (interaction.wasEdited !== undefined) {
      profile.editFrequency = 
        (profile.editFrequency * (profile.interactionCount - 1) + (interaction.wasEdited ? 1 : 0))
        / profile.interactionCount
    }
    
    // Update rollback frequency
    if (interaction.wasRolledBack !== undefined) {
      profile.rollbackFrequency = 
        (profile.rollbackFrequency * (profile.interactionCount - 1) + (interaction.wasRolledBack ? 1 : 0))
        / profile.interactionCount
    }
    
    // Update auto-confirm rate
    if (interaction.autoConfirmed !== undefined) {
      profile.autoConfirmRate = 
        (profile.autoConfirmRate * (profile.interactionCount - 1) + (interaction.autoConfirmed ? 1 : 0))
        / profile.interactionCount
    }
    
    // Update preferences
    if (interaction.usedTechnicalTerms) {
      profile.prefersTechnicalTerms = true
    }
    
    if (interaction.askedForExamples) {
      profile.prefersExamples = true
    }
    
    if (interaction.askedForSteps) {
      profile.prefersStepByStep = true
    }
    
    // Infer verbosity level from prompt length
    if (profile.averagePromptLength > 50) {
      profile.verbosityLevel = 'detailed'
    } else if (profile.averagePromptLength < 15) {
      profile.verbosityLevel = 'terse'
    }
    
    // Infer confirmation strictness from behavior
    if (profile.editFrequency > 0.5 || profile.rollbackFrequency > 0.3) {
      profile.confirmationStrictness = 'strict'
    } else if (profile.autoConfirmRate > 0.8) {
      profile.confirmationStrictness = 'relaxed'
    }
    
    profile.lastUpdatedAt = new Date().toISOString()
    
    this.profiles.set(projectId, profile)
    this.saveToStorage()
    
    return profile
  }

  /**
   * Get response style based on profile
   */
  getResponseStyle(projectId: string): {
    verbosity: 'terse' | 'normal' | 'detailed'
    showExamples: boolean
    showStepByStep: boolean
    useTechnicalTerms: boolean
    requireConfirmation: boolean
  } {
    const profile = this.getProfile(projectId)
    
    return {
      verbosity: profile.verbosityLevel,
      showExamples: profile.prefersExamples,
      showStepByStep: profile.prefersStepByStep,
      useTechnicalTerms: profile.prefersTechnicalTerms,
      requireConfirmation: profile.confirmationStrictness !== 'relaxed',
    }
  }

  /**
   * Adapt message based on profile
   */
  adaptMessage(projectId: string, baseMessage: string): string {
    const profile = this.getProfile(projectId)
    
    // Terse: Keep it short
    if (profile.verbosityLevel === 'terse') {
      // Remove filler words
      return baseMessage
        .replace(/\b(just|simply|basically|essentially)\b/gi, '')
        .replace(/\.\s+/g, '. ')
        .trim()
    }
    
    // Detailed: Add context
    if (profile.verbosityLevel === 'detailed') {
      // Keep full message as-is
      return baseMessage
    }
    
    // Normal: Standard
    return baseMessage
  }

  /**
   * Should skip confirmation for this user?
   */
  shouldSkipConfirmation(projectId: string, confidence: number): boolean {
    const profile = this.getProfile(projectId)
    
    // Relaxed users with high confidence can skip
    if (profile.confirmationStrictness === 'relaxed' && confidence > 0.9) {
      return true
    }
    
    // High auto-confirm rate + high confidence
    if (profile.autoConfirmRate > 0.9 && confidence > 0.85) {
      return true
    }
    
    return false
  }

  // Storage methods
  
  private loadFromStorage() {
    if (typeof window === 'undefined') return
    
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY)
      if (stored) {
        const data = JSON.parse(stored)
        this.profiles = new Map(Object.entries(data))
      }
    } catch (error) {
      console.warn('[PersonalityProfile] Failed to load from storage:', error)
    }
  }

  private saveToStorage() {
    if (typeof window === 'undefined') return
    
    try {
      const data = Object.fromEntries(this.profiles)
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data))
    } catch (error) {
      console.warn('[PersonalityProfile] Failed to save to storage:', error)
    }
  }

  /**
   * Clear profile (for testing)
   */
  clearProfile(projectId: string) {
    this.profiles.delete(projectId)
    this.saveToStorage()
  }
}

// Singleton instance
export const personalityManager = new PersonalityProfileManager()

/**
 * Helper: Detect technical terms in prompt
 */
export function detectTechnicalTerms(prompt: string): boolean {
  const technicalTerms = [
    'api', 'endpoint', 'schema', 'table', 'database', 'auth',
    'oauth', 'jwt', 'rbac', 'crud', 'rest', 'graphql',
    'realtime', 'websocket', 'webhook', 'middleware',
    'migration', 'rollback', 'transaction', 'index',
  ]
  
  const lower = prompt.toLowerCase()
  return technicalTerms.some(term => lower.includes(term))
}

/**
 * Helper: Detect request for examples
 */
export function detectExampleRequest(prompt: string): boolean {
  const patterns = [
    /\bexample\b/i,
    /\bshow me\b/i,
    /\bhow do i\b/i,
    /\bcan you show\b/i,
  ]
  
  return patterns.some(pattern => pattern.test(prompt))
}

/**
 * Helper: Detect request for step-by-step
 */
export function detectStepByStepRequest(prompt: string): boolean {
  const patterns = [
    /\bstep by step\b/i,
    /\bwalk me through\b/i,
    /\bhow to\b/i,
    /\bexplain\b/i,
  ]
  
  return patterns.some(pattern => pattern.test(prompt))
}
