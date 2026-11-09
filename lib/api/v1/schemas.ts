import { z } from 'zod'

/**
 * V1 Public API validation schemas
 */

// Auth schemas
export const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  name: z.string().min(1).max(100).optional(),
})

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
})

// Pagination constants — enforced on all list endpoints
export const PAGINATION_DEFAULT_LIMIT = 20
export const PAGINATION_MAX_LIMIT     = 100

// Database schemas
export const querySchema = z.object({
  table: z.string().min(1).max(100),
  select: z.array(z.string()).optional(),
  where: z.record(z.any()).optional(),
  orderBy: z.record(z.enum(['asc', 'desc'])).optional(),
  // limit: default 20, max 100 (enforced for all generated endpoints)
  limit: z.number().int().min(1).max(PAGINATION_MAX_LIMIT).optional().default(PAGINATION_DEFAULT_LIMIT),
  // offset and page are mutually exclusive — page is 0-indexed and takes precedence
  offset: z.number().int().min(0).optional(),
  page: z.number().int().min(0).optional(),
  // cursor-based pagination for large tables — use the value of the last row's `id` or sort column
  cursor: z.string().optional(),
  cursorColumn: z.string().optional(),
})

/**
 * Every field a database query request may carry, on either server (this
 * route and the runtime's server/routes/database.ts). The two implement
 * different subsets, so a field one of them ignores is still part of the API.
 */
export const QUERY_FIELDS = ['table', 'select', 'where', 'orderBy', 'limit', 'offset', 'page', 'cursor', 'cursorColumn', 'include'] as const

/**
 * The fields of a query request that are not part of the query API at all.
 *
 * Unknown fields used to be dropped without a word, and a dropped filter is a
 * query with no filter: `{ "wehre": { … } }` returned every row the caller can
 * see (production, 2026-11-09). A typo in app code became a data leak instead
 * of an error, so an unknown field is refused, by name.
 */
export function unknownQueryFields(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return []
  const known = new Set<string>(QUERY_FIELDS)
  return Object.keys(body).filter((k) => !known.has(k))
}

/** The refusal for unknown query fields, the same words on both servers. */
export function unknownQueryFieldsMessage(fields: string[]): string {
  const named = fields.slice(0, 5).map((f) => `"${f.slice(0, 40)}"`).join(', ')
  return `Unknown field${fields.length === 1 ? '' : 's'} ${named} in the query, so nothing was read. ` +
    `A query takes ${QUERY_FIELDS.slice(0, -1).join(', ')} and ${QUERY_FIELDS[QUERY_FIELDS.length - 1]}.`
}

export const insertSchema = z.object({
  table: z.string().min(1).max(100),
  data: z.record(z.any()),
})

export const updateSchema = z.object({
  table: z.string().min(1).max(100),
  where: z.record(z.any()),
  data: z.record(z.any()),
})

export const deleteSchema = z.object({
  table: z.string().min(1).max(100),
  where: z.record(z.any()),
})

// Storage schemas
export const uploadFileSchema = z.object({
  bucket: z.string().min(1).max(100),
  path: z.string().min(1).max(500),
  contentType: z.string().optional(),
  isPublic: z.boolean().optional(),
})

export const listFilesSchema = z.object({
  bucket: z.string().min(1).max(100),
  prefix: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
})

// Logs schemas
export const getLogsSchema = z.object({
  type: z.enum(['api', 'auth', 'database', 'function', 'system']).optional(),
  severity: z.enum(['error', 'warning', 'info', 'debug']).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
})

// AI schemas
export const aiGenerateSchema = z.object({
  prompt: z.string().min(1).max(5000),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(4000).optional(),
})

// Functions placeholder schema
export const invokeFunctionSchema = z.object({
  functionId: z.string().uuid(),
  payload: z.record(z.any()).optional(),
})

// Pagination
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGINATION_MAX_LIMIT).optional().default(PAGINATION_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

