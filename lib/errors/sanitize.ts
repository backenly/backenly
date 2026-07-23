/**
 * Production Error Handler
 * 
 * Converts all technical errors into human-readable messages.
 * Never exposes: stack traces, SQL errors, provider failures, internal details.
 */

export type ErrorSeverity = 'warning' | 'error' | 'critical'

export interface HumanError {
  message: string
  severity: ErrorSeverity
  canRetry: boolean
  actionText?: string
  actionUrl?: string
}

/**
 * Convert any error into a safe, human-readable message
 */
export function sanitizeError(error: unknown): HumanError {
  // Default safe message
  const defaultError: HumanError = {
    message: "Something didn't work. Nothing was changed.",
    severity: 'error',
    canRetry: true,
  }

  // Handle null/undefined
  if (!error) return defaultError

  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorLower = errorMessage.toLowerCase()

  // Database errors
  if (errorLower.includes('sql') || 
      errorLower.includes('prisma') || 
      errorLower.includes('database') ||
      errorLower.includes('unique constraint') ||
      errorLower.includes('foreign key')) {
    return {
      message: "We couldn't save this change. Your data is safe.",
      severity: 'error',
      canRetry: true,
    }
  }

  // Network/API errors
  if (errorLower.includes('fetch') || 
      errorLower.includes('network') || 
      errorLower.includes('timeout') ||
      errorLower.includes('econnrefused')) {
    return {
      message: "Connection issue. Nothing was changed. Try again in a moment.",
      severity: 'warning',
      canRetry: true,
    }
  }

  // Authentication errors
  if (errorLower.includes('auth') || 
      errorLower.includes('unauthorized') || 
      errorLower.includes('forbidden') ||
      errorLower.includes('token')) {
    return {
      message: "Your session expired. Please sign in again.",
      severity: 'warning',
      canRetry: false,
      actionText: 'Sign in',
      actionUrl: '/auth/login',
    }
  }

  // Rate limiting
  if (errorLower.includes('rate limit') || 
      errorLower.includes('too many requests')) {
    return {
      message: "You're going too fast. Take a breath and try again in a minute.",
      severity: 'warning',
      canRetry: true,
    }
  }

  // Validation errors
  if (errorLower.includes('validation') || 
      errorLower.includes('invalid') ||
      errorLower.includes('required')) {
    return {
      message: "Something in your request doesn't look right. Check and try again.",
      severity: 'warning',
      canRetry: true,
    }
  }

  // Provider errors (external BaaS / hosting providers)
  if (errorLower.includes('supabase') || 
      errorLower.includes('firebase') ||
      errorLower.includes('vercel') ||
      errorLower.includes('provider')) {
    return {
      message: "A service is temporarily unavailable. Nothing was changed.",
      severity: 'error',
      canRetry: true,
    }
  }

  // AI/LLM errors
  if (errorLower.includes('openai') || 
      errorLower.includes('anthropic') ||
      errorLower.includes('llm') ||
      errorLower.includes('model')) {
    return {
      message: "AI processing failed. Nothing was changed. Try rephrasing your request.",
      severity: 'error',
      canRetry: true,
    }
  }

  // Schema migration errors
  if (errorLower.includes('migration') || 
      errorLower.includes('schema')) {
    return {
      message: "This change could affect existing data. Nothing was changed.",
      severity: 'critical',
      canRetry: false,
      actionText: 'Learn more',
      actionUrl: '/app/advanced',
    }
  }

  // Deployment errors
  if (errorLower.includes('deploy') || 
      errorLower.includes('build')) {
    return {
      message: "Deployment failed. Your app is still running the previous version.",
      severity: 'error',
      canRetry: true,
    }
  }

  // Generic fallback
  return defaultError
}

/**
 * Log errors safely (for internal monitoring only, never shown to user)
 */
export function logErrorInternal(error: unknown, context?: Record<string, any>) {
  if (process.env.NODE_ENV === 'development') {
    console.error('[Error]', error, context)
  }
  
  // TODO: Send to monitoring service (Sentry, LogRocket, etc.)
  // But NEVER include in user-facing responses
}

/**
 * Validate that an error response is safe for users
 */
export function isSafeErrorMessage(message: string): boolean {
  const unsafePatterns = [
    /stack trace/i,
    /at line \d+/i,
    /error: \w+Error/i,
    /prisma/i,
    /sql/i,
    /\.(js|ts|tsx):\d+/i,
    /node_modules/i,
    /internal server error/i,
  ]

  return !unsafePatterns.some(pattern => pattern.test(message))
}
