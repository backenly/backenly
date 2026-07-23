import { z } from 'zod'

/**
 * Common validation schemas
 */

// UUID validation
export const uuidSchema = z.string().uuid()

// Email validation
export const emailSchema = z.string().email()

// Project schemas
export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  environment: z.enum(['development', 'staging', 'production']).optional(),
  apiUrlDev: z.string().url().optional(),
  apiUrlStaging: z.string().url().optional(),
  apiUrlProd: z.string().url().optional(),
})

export const updateProjectSchema = createProjectSchema.partial()

// User schemas
export const createUserSchema = z.object({
  email: emailSchema,
  name: z.string().min(1).max(100).optional(),
  password: z.string().min(8).max(100),
  roleId: uuidSchema.optional(),
})

export const updateUserSchema = z.object({
  email: emailSchema.optional(),
  name: z.string().min(1).max(100).optional(),
  password: z.string().min(8).max(100).optional(),
  roleId: uuidSchema.optional(),
})

// API Key schemas
export const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  keyType: z.enum(['dashboard', 'public']).default('public'),
  role: z.enum(['admin', 'read-only', 'write', 'ai-only', 'client', 'service']).default('client'),
  permissions: z.array(z.string()).optional(),
  capabilities: z.array(z.enum(['database', 'auth', 'storage', 'functions', 'ai'])).default([]),
  serviceRole: z.boolean().default(false),
  expiresAt: z.string().datetime().optional(),
  rateLimit: z.number().int().min(1).max(100000).optional(),
  rateLimitWindow: z.number().int().min(1).optional(),
})

export const updateApiKeySchema = createApiKeySchema.partial()

// Storage schemas
export const createBucketSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  isPublic: z.boolean().optional(),
})

export const uploadFileSchema = z.object({
  bucketId: uuidSchema,
  name: z.string().min(1).max(255),
  isPublic: z.boolean().optional(),
})

// AI Workspace schemas
export const generatePlanSchema = z.object({
  prompt: z.string().min(1).max(5000),
  projectId: uuidSchema.optional(),
})

export const applyChangesSchema = z.object({
  planId: z.string().optional(),
  changes: z.array(z.object({
    type: z.enum(['endpoint', 'migration', 'schema', 'file', 'config']),
    target: z.string(),
    code: z.string(),
  })),
})

// AI Config schemas
export const updateAiConfigSchema = z.object({
  model: z.string().min(1),
  temperature: z.number().min(0).max(1),
  maxTokens: z.number().int().min(1).max(32000),
  systemPrompt: z.string().max(10000).optional(),
  config: z.record(z.any()).optional(),
})

// Database Brain schemas
export const runAnalysisSchema = z.object({
  projectId: uuidSchema.optional(),
  database: z.enum(['postgresql', 'mongodb', 'hybrid']).optional(),
})

export const generateFixSchema = z.object({
  issueId: uuidSchema,
  projectId: uuidSchema.optional(),
})

// Security schemas
export const createSecurityScanSchema = z.object({
  scanType: z.enum(['configuration', 'vulnerability', 'compliance']),
  projectId: uuidSchema.optional(),
})

export const updateSecurityIssueSchema = z.object({
  fixed: z.boolean().optional(),
  fixedBy: uuidSchema.optional(),
})

// Monitoring schemas
export const getMetricsSchema = z.object({
  projectId: uuidSchema.optional(),
  timeRange: z.enum(['1h', '24h', '7d', '30d']).optional(),
  type: z.enum(['responseTime', 'requestVolume', 'errorRate', 'uptime']).optional(),
})

// Logs schemas
export const getLogsSchema = z.object({
  projectId: uuidSchema.optional(),
  type: z.enum(['api', 'auth', 'database', 'function', 'system']).optional(),
  severity: z.enum(['error', 'warning', 'info', 'debug']).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
})

// Query parameter schemas
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

export const projectIdSchema = z.object({
  projectId: uuidSchema.optional(),
})

/**
 * Validation helper
 */
export function validateRequest<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(data)
  
  if (result.success) {
    return { success: true, data: result.data }
  }
  
  return { success: false, error: result.error }
}

/**
 * Validate request body
 */
export async function validateRequestBody<T>(
  schema: z.ZodSchema<T>,
  request: Request
): Promise<{ success: true; data: T } | { success: false; error: string; status: number }> {
  try {
    const body = await request.json()
    const result = validateRequest(schema, body)
    
    if (result.success) {
      return { success: true, data: result.data }
    }
      
    return {
      success: false,
      error: 'error' in result ? result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ') : 'Unknown error',
      status: 400,
    }
  } catch (error) {
    return {
      success: false,
      error: 'Invalid JSON in request body',
      status: 400,
    }
  }
}

/**
 * Validate query parameters
 */
export function validateQueryParams<T>(
  schema: z.ZodSchema<T>,
  searchParams: URLSearchParams
): { success: true; data: T } | { success: false; error: string; status: number } {
  const params: Record<string, string> = {}
  searchParams.forEach((value, key) => {
    params[key] = value
  })
  
  const result = validateRequest(schema, params)
  
  if (result.success) {
    return { success: true, data: result.data }
  }
  
  return {
    success: false,
    error: 'error' in result ? result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ') : 'Unknown error',
    status: 400,
  }
}

