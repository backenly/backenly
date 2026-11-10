/**
 * What is wrong with a request's body, in plain sentences that name the field.
 *
 * Production QA (2026-11-09): a short end-user password came back from the web
 * tier as "password: String must contain at least 8 character(s)", Zod's own
 * words, while the Express runtime answered "Request validation failed" for the
 * same body. Apps show these to their users. A message a schema writes itself
 * ('Password must be at least 8 characters.') wins; every other issue gets a
 * sentence from plainErrorMap instead of Zod's default.
 */
import { z } from 'zod'

const count = (n: number | bigint, one: string, many: string) => `${n} ${Number(n) === 1 ? one : many}`

/** Zod's issues as sentences naming the field, for any schema parsed with it. */
export const plainErrorMap: z.ZodErrorMap = (issue, ctx) => {
  const field = issue.path.length ? issue.path.join('.') : 'The request body'
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') return { message: `${field} is required.` }
      return { message: `${field} must be a ${issue.expected}, not a ${issue.received}.` }
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') {
        return { message: Number(issue.minimum) === 1 ? `${field} cannot be empty.` : `${field} must be at least ${count(issue.minimum, 'character', 'characters')}.` }
      }
      if (issue.type === 'array') return { message: `${field} must have at least ${count(issue.minimum, 'item', 'items')}.` }
      if (issue.type === 'number' || issue.type === 'bigint') return { message: `${field} must be at least ${issue.minimum}.` }
      break
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: `${field} must be at most ${count(issue.maximum, 'character', 'characters')}.` }
      if (issue.type === 'array') return { message: `${field} must have at most ${count(issue.maximum, 'item', 'items')}.` }
      if (issue.type === 'number' || issue.type === 'bigint') return { message: `${field} must be at most ${issue.maximum}.` }
      break
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: `${field} must be a valid email address.` }
      if (issue.validation === 'url') return { message: `${field} must be a valid URL.` }
      if (issue.validation === 'uuid') return { message: `${field} must be a valid id.` }
      break
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `${field} must be one of: ${issue.options.join(', ')}.` }
    case z.ZodIssueCode.unrecognized_keys:
      return { message: `${issue.keys.join(', ')} ${issue.keys.length === 1 ? 'is' : 'are'} not accepted here.` }
  }
  return { message: ctx.defaultError }
}

/** The body's problems: every one as the message, and each by field. */
export function describeIssues(error: z.ZodError): { message: string; fields: Record<string, string[]> } {
  const fields: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_body'
    ;(fields[key] ??= []).push(issue.message)
  }
  return { message: error.issues.map((i) => i.message).join(' '), fields }
}
