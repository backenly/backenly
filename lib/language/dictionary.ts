/**
 * PHASE 17 — STRICT LANGUAGE SYSTEM
 * 
 * Enforces consistent non-technical vocabulary across the entire product.
 * Mixed vocabulary breaks trust. Backend terminology is PROHIBITED.
 * 
 * Rules:
 * - "users", not "auth"
 * - "remember", not "database"
 * - "connect", not "API"
 * - "works", not "deployed"
 * - "changes", not "migrations"
 */

export interface LanguageRule {
  forbidden: string[] // Backend terms that are NEVER allowed
  replacement: string // User-friendly replacement
  context?: string // When this rule applies
  examples: {
    bad: string
    good: string
  }[]
}

/**
 * STRICT LANGUAGE DICTIONARY
 * 
 * Every backend term is mapped to its user-friendly equivalent.
 * This is the single source of truth for all user-facing language.
 */
export const LANGUAGE_DICTIONARY: Record<string, LanguageRule> = {
  // Authentication/Authorization
  authentication: {
    forbidden: ['auth', 'authentication', 'authorization', 'OAuth', 'JWT', 'token', 'session'],
    replacement: 'users',
    examples: [
      { bad: 'Authentication failed', good: 'Sign-in didn\'t work' },
      { bad: 'OAuth token expired', good: 'Please sign in again' },
      { bad: 'Authorization required', good: 'You need to be signed in' },
    ],
  },

  // Database
  database: {
    forbidden: ['database', 'DB', 'schema', 'table', 'column', 'SQL', 'query', 'index', 'migration'],
    replacement: 'remember',
    examples: [
      { bad: 'Database connection failed', good: 'We couldn\'t save this' },
      { bad: 'Schema migration required', good: 'Updating how we remember things' },
      { bad: 'Table created successfully', good: 'Ready to remember this' },
    ],
  },

  // API/Endpoints
  api: {
    forbidden: ['API', 'endpoint', 'REST', 'GraphQL', 'route', 'HTTP', 'request', 'response'],
    replacement: 'connect',
    examples: [
      { bad: 'API endpoint created', good: 'Ready to connect' },
      { bad: 'HTTP 500 error', good: 'Something didn\'t work' },
      { bad: 'Request failed', good: 'Connection issue' },
    ],
  },

  // Deployment
  deployment: {
    forbidden: ['deploy', 'deployment', 'production', 'staging', 'CI/CD', 'build', 'container'],
    replacement: 'works',
    examples: [
      { bad: 'Deployment successful', good: 'It\'s live and working' },
      { bad: 'Build failed', good: 'Something didn\'t work' },
      { bad: 'Container starting', good: 'Getting ready' },
    ],
  },

  // Storage
  storage: {
    forbidden: ['storage', 'S3', 'bucket', 'blob', 'CDN', 'cache'],
    replacement: 'files',
    examples: [
      { bad: 'Storage bucket created', good: 'Ready for files' },
      { bad: 'CDN cache cleared', good: 'Files updated' },
      { bad: 'Blob uploaded', good: 'File saved' },
    ],
  },

  // Infrastructure
  infrastructure: {
    forbidden: ['server', 'instance', 'worker', 'queue', 'cron', 'job', 'process', 'service'],
    replacement: 'background',
    examples: [
      { bad: 'Server restarted', good: 'Everything\'s running' },
      { bad: 'Queue processing', good: 'Working in the background' },
      { bad: 'Cron job scheduled', good: 'Happens automatically' },
    ],
  },

  // Configuration
  configuration: {
    forbidden: ['config', 'configuration', 'environment', 'variable', 'secret', 'key'],
    replacement: 'settings',
    examples: [
      { bad: 'Configuration updated', good: 'Settings changed' },
      { bad: 'Environment variable missing', good: 'Something needs to be set up' },
      { bad: 'API key invalid', good: 'Connection not working' },
    ],
  },

  // Monitoring
  monitoring: {
    forbidden: ['metrics', 'logs', 'trace', 'span', 'telemetry', 'observability', 'APM'],
    replacement: 'status',
    examples: [
      { bad: 'Metrics collected', good: 'Everything\'s tracked' },
      { bad: 'Log level set to debug', good: 'Tracking more details' },
      { bad: 'Trace ID: xyz123', good: 'Everything\'s running' },
    ],
  },

  // Performance
  performance: {
    forbidden: ['latency', 'throughput', 'RPS', 'load', 'scale', 'optimize'],
    replacement: 'speed',
    examples: [
      { bad: 'High latency detected', good: 'Things are slower right now' },
      { bad: 'Auto-scaling triggered', good: 'Handling more usage automatically' },
      { bad: 'Query optimized', good: 'Made it faster' },
    ],
  },

  // Errors
  errors: {
    forbidden: ['exception', 'stack trace', 'error code', 'HTTP status', '500', '404', '403'],
    replacement: 'didn\'t work',
    examples: [
      { bad: 'Exception thrown', good: 'Something didn\'t work' },
      { bad: '404 Not Found', good: 'We couldn\'t find that' },
      { bad: '500 Internal Server Error', good: 'Something went wrong on our end' },
    ],
  },

  // Security
  security: {
    forbidden: ['encryption', 'hash', 'salt', 'certificate', 'SSL', 'TLS', 'firewall'],
    replacement: 'secure',
    examples: [
      { bad: 'SSL certificate renewed', good: 'Connection is secure' },
      { bad: 'Password hashed', good: 'Password saved securely' },
      { bad: 'Firewall rule added', good: 'Protection updated' },
    ],
  },

  // Data Operations
  operations: {
    forbidden: ['CRUD', 'INSERT', 'UPDATE', 'DELETE', 'SELECT', 'transaction', 'rollback'],
    replacement: 'change',
    examples: [
      { bad: 'Transaction rolled back', good: 'Change undone' },
      { bad: 'INSERT query executed', good: 'Saved' },
      { bad: 'DELETE operation', good: 'Removed' },
    ],
  },
}

/**
 * Validate text against the language dictionary
 * Returns forbidden terms found in the text
 */
export function detectForbiddenTerms(text: string): {
  found: string[]
  violations: Array<{ term: string; category: string; suggestion: string }>
} {
  const textLower = text.toLowerCase()
  const found: string[] = []
  const violations: Array<{ term: string; category: string; suggestion: string }> = []

  for (const [category, rule] of Object.entries(LANGUAGE_DICTIONARY)) {
    for (const forbiddenTerm of rule.forbidden) {
      // Use word boundaries to avoid false positives
      const regex = new RegExp(`\\b${forbiddenTerm.toLowerCase()}\\b`, 'i')
      if (regex.test(textLower)) {
        found.push(forbiddenTerm)
        violations.push({
          term: forbiddenTerm,
          category,
          suggestion: rule.replacement,
        })
      }
    }
  }

  return { found, violations }
}

/**
 * Replace forbidden terms with user-friendly equivalents
 */
export function sanitizeLanguage(text: string): string {
  let sanitized = text

  // Apply replacements from dictionary
  for (const rule of Object.values(LANGUAGE_DICTIONARY)) {
    for (const forbiddenTerm of rule.forbidden) {
      const regex = new RegExp(`\\b${forbiddenTerm}\\b`, 'gi')
      sanitized = sanitized.replace(regex, rule.replacement)
    }
  }

  return sanitized
}

/**
 * Validate that text follows language rules
 * Throws error if forbidden terms are found (for strict enforcement)
 */
export function enforceLanguageRules(text: string, context: string = 'unknown'): void {
  const { found, violations } = detectForbiddenTerms(text)

  if (found.length > 0) {
    const violationDetails = violations
      .map((v) => `"${v.term}" → use "${v.suggestion}" instead (${v.category})`)
      .join('; ')

    throw new Error(
      `Language rule violation in ${context}: ${violationDetails}`
    )
  }
}

/**
 * Get user-friendly replacement for a technical term
 */
export function getUserFriendlyTerm(technicalTerm: string): string {
  const termLower = technicalTerm.toLowerCase()

  for (const rule of Object.values(LANGUAGE_DICTIONARY)) {
    if (rule.forbidden.some((forbidden) => forbidden.toLowerCase() === termLower)) {
      return rule.replacement
    }
  }

  // If not in dictionary, return as-is
  return technicalTerm
}

/**
 * Check if text is safe for user-facing display
 */
export function isUserSafe(text: string): boolean {
  const { found } = detectForbiddenTerms(text)
  return found.length === 0
}

/**
 * Get examples for a specific language rule
 */
export function getExamples(category: string): LanguageRule['examples'] | undefined {
  return LANGUAGE_DICTIONARY[category]?.examples
}
