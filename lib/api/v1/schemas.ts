import { z } from 'zod'

/**
 * V1 Public API validation schemas
 */

// End-user auth, in the words an app shows its users. Both runtimes parse with
// these (app/api/v1/[projectId]/auth/*, server/routes/auth.ts), so the same body
// is refused the same way by either.
const email = z.string({ required_error: 'Email is required.' }).email('Email must be a valid email address.')

export const signUpSchema = z.object({
  email,
  password: z
    .string({ required_error: 'Password is required.' })
    .min(8, 'Password must be at least 8 characters.')
    .max(100, 'Password must be at most 100 characters.'),
  name: z.string().min(1, 'Name cannot be empty.').max(100, 'Name must be at most 100 characters.').optional(),
})

export const signInSchema = z.object({
  email,
  password: z.string({ required_error: 'Password is required.' }).min(1, 'Password is required.'),
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

