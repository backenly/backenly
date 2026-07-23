/**
 * Intent Safety Classifier
 * 
 * Classifies user intents as safe, risky, or destructive.
 * Prevents dangerous changes without explicit human confirmation.
 */

export type IntentRiskLevel = 'safe' | 'risky' | 'destructive'

export interface IntentClassification {
  riskLevel: IntentRiskLevel
  consequence: string // Human-readable consequence
  affectedUsers?: number
  affectedData?: string
  requiresConfirmation: boolean
}

/**
 * Destructive patterns that require confirmation
 */
const DESTRUCTIVE_PATTERNS = [
  // User deletion
  { pattern: /delete (all )?users?/i, consequence: 'This will remove access for all users.' },
  { pattern: /remove (all )?users?/i, consequence: 'This will remove access for all users.' },
  { pattern: /clear (all )?users?/i, consequence: 'This will permanently delete all user accounts.' },
  
  // Auth removal
  { pattern: /remove auth(entication)?/i, consequence: 'This will make your app publicly accessible to anyone.' },
  { pattern: /disable auth(entication)?/i, consequence: 'This will remove sign-in protection. Anyone can access your app.' },
  { pattern: /turn off (login|sign-?in)/i, consequence: 'This removes all access control. Your app becomes public.' },
  
  // Data deletion
  { pattern: /delete (all )?data/i, consequence: 'This will permanently delete all stored information.' },
  { pattern: /drop (all )?(tables?|database)/i, consequence: 'This will erase all your data. This cannot be undone.' },
  { pattern: /clear (all )?data/i, consequence: 'This will permanently remove all stored information.' },
  
  // Breaking changes
  { pattern: /make .* optional/i, consequence: 'This might break existing functionality that relies on this field.' },
  { pattern: /change .* to optional/i, consequence: 'Existing code might break if it expects this value.' },
  
  // Public access
  { pattern: /make (app|api) public/i, consequence: 'Anyone on the internet can access your app without signing in.' },
  { pattern: /allow (everyone|anyone)/i, consequence: 'This removes access restrictions. Anyone can use your app.' },
  
  // Deployment removal
  { pattern: /delete deployment/i, consequence: 'Your app will go offline. Users won\'t be able to access it.' },
  { pattern: /take (app )?offline/i, consequence: 'Your app will stop working for all users immediately.' },
  { pattern: /shut down/i, consequence: 'Your app will become unavailable to all users.' },
]

/**
 * Risky patterns that should be reviewed
 */
const RISKY_PATTERNS = [
  // Schema changes
  { pattern: /change .* type/i, consequence: 'Existing data might not work with the new format.' },
  { pattern: /rename .* (field|column)/i, consequence: 'This might break existing API calls.' },
  
  // Permission changes
  { pattern: /change permissions?/i, consequence: 'This will affect who can access your app.' },
  { pattern: /modify access/i, consequence: 'Some users might lose access they currently have.' },
  
  // Sensitive data exposure
  { pattern: /expose .* (data|info)/i, consequence: 'This might share private information.' },
  { pattern: /make .* visible/i, consequence: 'More people will be able to see this data.' },
]

/**
 * Classify an intent based on its risk level
 */
export function classifyIntent(intent: string): IntentClassification {
  const intentLower = intent.toLowerCase().trim()

  // Check destructive patterns first
  for (const { pattern, consequence } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(intentLower)) {
      return {
        riskLevel: 'destructive',
        consequence,
        requiresConfirmation: true,
      }
    }
  }

  // Check risky patterns
  for (const { pattern, consequence } of RISKY_PATTERNS) {
    if (pattern.test(intentLower)) {
      return {
        riskLevel: 'risky',
        consequence,
        requiresConfirmation: true,
      }
    }
  }

  // Default: safe
  return {
    riskLevel: 'safe',
    consequence: '',
    requiresConfirmation: false,
  }
}

/**
 * Generate a human-readable warning for destructive intents
 */
export function generateWarning(classification: IntentClassification): string {
  if (classification.riskLevel === 'destructive') {
    return `⚠️ This is a destructive action.

${classification.consequence}

This cannot be undone automatically.`
  }

  if (classification.riskLevel === 'risky') {
    return `⚠️ This might cause issues.

${classification.consequence}

You can undo this if something breaks.`
  }

  return ''
}

/**
 * Check if an intent requires explicit confirmation
 */
export function requiresConfirmation(intent: string): boolean {
  const classification = classifyIntent(intent)
  return classification.requiresConfirmation
}
