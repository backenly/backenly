/**
 * PHASE 17 — LANGUAGE VALIDATOR
 * 
 * Runtime enforcement of language dictionary rules.
 * Validates UI text, AI responses, and error messages.
 */

import { detectForbiddenTerms, sanitizeLanguage, isUserSafe } from './dictionary'

export interface ValidationResult {
  isValid: boolean
  violations: Array<{
    term: string
    category: string
    suggestion: string
    location?: string
  }>
  sanitized?: string
}

/**
 * Validate AI response before sending to user
 */
export function validateAIResponse(response: string, conversationId?: string): ValidationResult {
  const { found, violations } = detectForbiddenTerms(response)

  if (found.length > 0) {
    // Auto-sanitize AI responses
    const sanitized = sanitizeLanguage(response)

    console.warn(`[Language Validator] AI response contained forbidden terms:`, {
      conversationId,
      violations,
      original: response.substring(0, 100),
      sanitized: sanitized.substring(0, 100),
    })

    return {
      isValid: false,
      violations: violations.map((v) => ({ ...v, location: 'ai-response' })),
      sanitized,
    }
  }

  return {
    isValid: true,
    violations: [],
  }
}

/**
 * Validate error message before displaying
 */
export function validateErrorMessage(error: string, source?: string): ValidationResult {
  const { found, violations } = detectForbiddenTerms(error)

  if (found.length > 0) {
    const sanitized = sanitizeLanguage(error)

    console.warn(`[Language Validator] Error message contained forbidden terms:`, {
      source,
      violations,
      original: error,
      sanitized,
    })

    return {
      isValid: false,
      violations: violations.map((v) => ({ ...v, location: source || 'error' })),
      sanitized,
    }
  }

  return {
    isValid: true,
    violations: [],
  }
}

/**
 * Validate UI text/labels
 */
export function validateUIText(text: string, componentName?: string): ValidationResult {
  const { found, violations } = detectForbiddenTerms(text)

  if (found.length > 0) {
    // UI text should NEVER contain forbidden terms
    console.error(`[Language Validator] UI text violation in ${componentName}:`, {
      text,
      violations,
    })

    return {
      isValid: false,
      violations: violations.map((v) => ({ ...v, location: componentName || 'ui' })),
      sanitized: sanitizeLanguage(text),
    }
  }

  return {
    isValid: true,
    violations: [],
  }
}

/**
 * Batch validate multiple strings
 */
export function validateBatch(
  items: Array<{ text: string; context: string }>
): Array<ValidationResult & { context: string }> {
  return items.map((item) => {
    const { found, violations } = detectForbiddenTerms(item.text)

    if (found.length > 0) {
      return {
        context: item.context,
        isValid: false,
        violations: violations.map((v) => ({ ...v, location: item.context })),
        sanitized: sanitizeLanguage(item.text),
      }
    }

    return {
      context: item.context,
      isValid: true,
      violations: [],
    }
  })
}

/**
 * Middleware wrapper for API responses
 * Validates all response bodies before sending
 */
export function validateAPIResponse(responseBody: unknown): {
  isValid: boolean
  violations: ValidationResult['violations']
  sanitized?: unknown
} {
  // Extract all string values from response
  const strings = extractStrings(responseBody)
  const allViolations: ValidationResult['violations'] = []

  for (const { path, value } of strings) {
    const { found, violations } = detectForbiddenTerms(value)
    if (found.length > 0) {
      allViolations.push(
        ...violations.map((v) => ({ ...v, location: `response.${path}` }))
      )
    }
  }

  if (allViolations.length > 0) {
    console.warn(`[Language Validator] API response contained forbidden terms:`, {
      violations: allViolations,
    })

    // Sanitize the entire response
    const sanitized = sanitizeObject(responseBody)

    return {
      isValid: false,
      violations: allViolations,
      sanitized,
    }
  }

  return {
    isValid: true,
    violations: [],
  }
}

/**
 * Extract all strings from an object recursively
 */
function extractStrings(
  obj: unknown,
  path: string = ''
): Array<{ path: string; value: string }> {
  const results: Array<{ path: string; value: string }> = []

  if (typeof obj === 'string') {
    results.push({ path, value: obj })
  } else if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      results.push(...extractStrings(item, `${path}[${index}]`))
    })
  } else if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const newPath = path ? `${path}.${key}` : key
      results.push(...extractStrings(value, newPath))
    }
  }

  return results
}

/**
 * Sanitize all strings in an object recursively
 */
function sanitizeObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return sanitizeLanguage(obj)
  } else if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item))
  } else if (obj && typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeObject(value)
    }
    return sanitized
  }

  return obj
}

/**
 * Generate validation report for audit purposes
 */
export function generateValidationReport(
  results: Array<ValidationResult & { context: string }>
): {
  totalChecked: number
  violations: number
  violationsByCategory: Record<string, number>
  details: Array<{ context: string; violations: string[] }>
} {
  const violationsByCategory: Record<string, number> = {}
  const details: Array<{ context: string; violations: string[] }> = []

  let totalViolations = 0

  for (const result of results) {
    if (!result.isValid) {
      totalViolations += result.violations.length

      for (const violation of result.violations) {
        violationsByCategory[violation.category] =
          (violationsByCategory[violation.category] || 0) + 1
      }

      details.push({
        context: result.context,
        violations: result.violations.map((v) => `${v.term} (→ ${v.suggestion})`),
      })
    }
  }

  return {
    totalChecked: results.length,
    violations: totalViolations,
    violationsByCategory,
    details,
  }
}
