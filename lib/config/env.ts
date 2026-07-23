import { z } from 'zod'

/**
 * Environment variable schema
 */
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  
  // MongoDB (Optional)
  MONGODB_URI: z.string().optional(),
  MONGODB_DB_NAME: z.string().default('backenly_platform'),
  
  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  
  // OpenAI
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_BASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  
  // Security
  CORS_ORIGIN: z.string().url().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  ENCRYPTION_KEY: z.string().min(32).optional(),
  
  // Domain
  BASE_DOMAIN: z.string().optional(),
  
  // Storage (Backblaze B2 S3-compatible)
  STORAGE_DRIVER: z.string().default('s3'),
  STORAGE_S3_ENDPOINT: z.string().optional(),
  STORAGE_S3_REGION: z.string().default('us-east-1'),
  STORAGE_S3_BUCKET: z.string().default('backenly-storage'),
  STORAGE_S3_ACCESS_KEY: z.string().optional(),
  STORAGE_S3_SECRET_KEY: z.string().optional(),
  STORAGE_S3_PUBLIC_URL: z.string().optional(),
  STORAGE_PATH: z.string().default('./storage'),
  
  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(900000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(100),
  
  // Paddle Billing
  PADDLE_API_KEY: z.string().optional(),
  PADDLE_WEBHOOK_SECRET: z.string().optional(),
  PADDLE_ENVIRONMENT: z.enum(['production', 'sandbox']).default('sandbox'),
  PADDLE_STARTER_PRICE_ID: z.string().optional(),
  PADDLE_GROWTH_PRICE_ID: z.string().optional(),
  PADDLE_PRO_PRICE_ID: z.string().optional(),
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: z.string().optional(),
  NEXT_PUBLIC_PADDLE_ENVIRONMENT: z.enum(['production', 'sandbox']).default('sandbox'),

  // Cron jobs
  CRON_SECRET: z.string().optional(),

  // Feature Flags
  ENABLE_AI_FEATURES: z.coerce.boolean().default(true),
  ENABLE_ANALYTICS: z.coerce.boolean().default(false),
  
  // Monitoring
  ENABLE_METRICS: z.coerce.boolean().default(true),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FILE_PATH: z.string().optional(),
})

/**
 * Validated environment variables
 */
let env: z.infer<typeof envSchema>

/**
 * Get validated environment variables
 */
export function getEnv() {
  if (!env) {
    const result = envSchema.safeParse(process.env)
    
    if (!result.success) {
      const errors = result.error.errors.map(e => 
        `${e.path.join('.')}: ${e.message}`
      ).join('\n')
      
      throw new Error(`Invalid environment variables:\n${errors}`)
    }
    
    env = result.data
  }
  
  return env
}

/**
 * Check if required environment variables are set
 */
export function validateEnv() {
  try {
    getEnv()
    return { valid: true }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Get environment variable safely
 */
export function getEnvVar(key: keyof z.infer<typeof envSchema>): string | undefined {
  try {
    const env = getEnv()
    return env[key] as string | undefined
  } catch {
    return undefined
  }
}

/**
 * Check if we're in production
 */
export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production'
}

/**
 * Check if we're in development
 */
export function isDevelopment(): boolean {
  return getEnv().NODE_ENV === 'development'
}

/**
 * Check if we're in test
 */
export function isTest(): boolean {
  return getEnv().NODE_ENV === 'test'
}

