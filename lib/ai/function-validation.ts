/**
 * AiFunction creation guard
 * =========================
 * Validates and sanitizes AiFunction data before any prisma.aiFunction.create call.
 * Applied at every creation point so phantom/placeholder functions can never reach the DB.
 */

// Matches template descriptions regardless of whether "ai" is included:
//   "Describe what this ai function should do"
//   "Describe what this function should do"
//   "Describe what the function should do"
export const PLACEHOLDER_DESC_RE = /^describe what (the|this) (ai )?function should do/i

// Matches names that were never replaced from the creation template
export const PLACEHOLDER_NAME_RE =
  /^(describe_function_purpose|my_function|function_name|placeholder|unnamed|todo_function|untitled_function|new_function)$/i

/**
 * Sanitize a raw function name to a valid snake_case identifier.
 * Returns empty string if the input cannot produce a valid name.
 */
export function sanitizeAiFunctionName(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
}

/**
 * Returns true if the description is an unfilled template placeholder.
 */
export function isPlaceholderDescription(description: string | null | undefined): boolean {
  if (!description) return false
  return PLACEHOLDER_DESC_RE.test(description.trim())
}

/**
 * Returns true if the function name is a known placeholder template name.
 */
export function isPlaceholderName(name: string | null | undefined): boolean {
  if (!name) return false
  return PLACEHOLDER_NAME_RE.test(name.trim())
}

export interface AiFunctionValidationResult {
  valid: boolean
  name: string
  reason?: string
}

/**
 * Validate name + description before creating an AiFunction.
 * Returns { valid: false } with a reason if creation should be skipped.
 */
export function validateAiFunctionData(
  name: string | null | undefined,
  description: string | null | undefined,
): AiFunctionValidationResult {
  const sanitizedName = sanitizeAiFunctionName(name)

  if (!sanitizedName) {
    return {
      valid: false,
      name: '',
      reason: `AiFunction skipped — name "${name}" is empty or invalid after sanitization`,
    }
  }

  if (isPlaceholderDescription(description)) {
    return {
      valid: false,
      name: sanitizedName,
      reason: `AiFunction "${sanitizedName}" skipped — description is an unfilled placeholder template`,
    }
  }

  return { valid: true, name: sanitizedName }
}
