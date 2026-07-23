/**
 * SIMPLE TWO-STAGE INTENT CLASSIFIER
 * 
 * Replaces over-engineered pipeline with decisive classification:
 * - QUESTION: User is asking for information
 * - BUILD_CHANGE: User wants to build/modify something
 * 
 * This is what makes Bolt/Cursor feel smart - they decide fast and act.
 */

export type IntentType = 'QUESTION' | 'BUILD_CHANGE'

export interface IntentClassification {
  type: IntentType
  confidence: number
  reason: string
}

// Question indicators - user is asking for information
const QUESTION_PATTERNS = [
  /^(what|which|how|why|is there|do we have|list|show|tell me|explain|describe)/i,
  /\?$/,
  /^(can you (tell|show|explain|list))/i,
  /^(how many|how much|how do)/i,
]

// Build change indicators - user wants to create/modify
const BUILD_CHANGE_PATTERNS = [
  /\b(create|add|enable|setup|implement|build|connect|install|configure|generate|make|do)\b/i,
  /\b(set up|turn on|turn off|remove|delete|update|change|modify)\b/i,
  /\b(google auth|oauth|jwt|login|signup|authentication|storage|api|table|database)\b.*\b(add|enable|setup|create)\b/i,
  /\b(add|enable|setup|create)\b.*\b(google auth|oauth|jwt|login|signup|authentication|storage|api|table|database)\b/i,
]

// Verbs that clearly indicate a question, not a command
const QUESTION_VERBS = [
  /^(what|which|how|why|when|where|who|is|are|does|do|can|could|would|will)/i,
]

// Verbs that clearly indicate building/creating
const BUILD_VERBS = [
  /\b(create|add|enable|setup|implement|build|generate|make|install|configure|connect)\b/i,
]

/**
 * Classify user intent into QUESTION or BUILD_CHANGE
 * 
 * Simple, fast, decisive - no overthinking.
 */
export function classifyIntent(prompt: string): IntentClassification {
  const lower = prompt.toLowerCase().trim()
  
  // Check for clear question patterns first
  const isQuestionPattern = QUESTION_PATTERNS.some(p => p.test(lower))
  const isQuestionVerb = QUESTION_VERBS.some(p => p.test(lower))
  
  // Check for build patterns
  const isBuildPattern = BUILD_CHANGE_PATTERNS.some(p => p.test(lower))
  const isBuildVerb = BUILD_VERBS.some(p => p.test(lower))
  
  // Decision logic - prioritize build verbs over question patterns
  // Example: "can you do google auth" -> BUILD_CHANGE (contains "do")
  // Example: "what tables exist" -> QUESTION (starts with "what")
  
  if (isBuildVerb && !isQuestionVerb) {
    return {
      type: 'BUILD_CHANGE',
      confidence: 0.95,
      reason: 'Contains build verb without question verb'
    }
  }
  
  if (isQuestionVerb && !isBuildVerb) {
    return {
      type: 'QUESTION',
      confidence: 0.95,
      reason: 'Starts with question verb'
    }
  }
  
  // Both present - use context to decide
  if (isBuildVerb && isQuestionVerb) {
    // "Can you add google auth?" -> BUILD_CHANGE (action intent)
    if (/\b(can you|could you|would you)\b.*\b(add|create|enable|setup|implement)\b/i.test(lower)) {
      return {
        type: 'BUILD_CHANGE',
        confidence: 0.9,
        reason: 'Request to perform action (can you + build verb)'
      }
    }
    
    // "How do I add google auth?" -> QUESTION (informational)
    if (/\b(how do|how can|how to)\b/i.test(lower)) {
      return {
        type: 'QUESTION',
        confidence: 0.9,
        reason: 'Asking how to do something'
      }
    }
  }
  
  // Fallback to pattern matching
  if (isBuildPattern) {
    return {
      type: 'BUILD_CHANGE',
      confidence: 0.8,
      reason: 'Matches build pattern'
    }
  }
  
  if (isQuestionPattern) {
    return {
      type: 'QUESTION',
      confidence: 0.8,
      reason: 'Matches question pattern'
    }
  }
  
  // Default to QUESTION for safety (better to answer than break)
  return {
    type: 'QUESTION',
    confidence: 0.5,
    reason: 'Unclear intent - defaulting to question'
  }
}

/**
 * Check if a prompt is clearly a build command (no doubt)
 * Used to bypass clarification for obvious requests.
 */
export function isObviousBuildCommand(prompt: string): boolean {
  const lower = prompt.toLowerCase().trim()
  
  const obviousPatterns = [
    /\b(add|enable|setup|create)\s+(google|github|oauth|jwt)\s+(auth|login|authentication)/i,
    /\b(add|create)\s+(payments|stripe|billing|subscription)/i,
    /\b(enable|setup)\s+(storage|uploads|files)/i,
    /\b(create|add)\s+(notifications|email|sms)/i,
    /\b(setup|configure)\s+(api|endpoint|route)/i,
    /\b(create|build)\s+(blog|ecommerce|saas|app)/i,
  ]
  
  return obviousPatterns.some(p => p.test(lower))
}

/**
 * Check if a prompt is clearly a question (no doubt)
 */
export function isObviousQuestion(prompt: string): boolean {
  const lower = prompt.toLowerCase().trim()
  
  // Direct questions
  if (/^(what|which|how many|list|show|tell me)\s/i.test(lower)) {
    return true
  }
  
  // Ends with question mark and no build verbs
  if (/\?$/.test(lower) && !BUILD_VERBS.some(p => p.test(lower))) {
    return true
  }
  
  return false
}
