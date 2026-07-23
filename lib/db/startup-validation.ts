/**
 * Startup Validation Module
 * 
 * PHASE 3: Schema Discipline & Startup Validation
 * 
 * Validates critical prerequisites before server starts:
 * 1. Environment variables present and valid
 * 2. Database connectivity
 * 3. Prisma schema matches database (no drift)
 * 4. Required migrations applied
 * 
 * Fails fast with clear error messages to prevent runtime crashes.
 */

import { prisma } from './prisma'
import { execSync } from 'child_process'

interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

interface EnvRequirement {
  name: string
  required: boolean
  validate?: (value: string) => boolean
  errorMessage?: string
}

// Critical environment variables
const ENV_REQUIREMENTS: EnvRequirement[] = [
  {
    name: 'DATABASE_URL',
    required: true,
    validate: (url) => url.startsWith('postgresql://') || url.startsWith('postgres://'),
    errorMessage: 'DATABASE_URL must be a valid PostgreSQL connection string',
  },
  {
    name: 'NODE_ENV',
    required: true,
    validate: (env) => ['development', 'production', 'test'].includes(env),
    errorMessage: 'NODE_ENV must be development, production, or test',
  },
  {
    name: 'JWT_SECRET',
    required: true,
    validate: (secret) => secret.length >= 32,
    errorMessage: 'JWT_SECRET must be at least 32 characters for security',
  },
  {
    name: 'NEXTAUTH_SECRET',
    required: true,
    validate: (secret) => secret.length >= 32,
    errorMessage: 'NEXTAUTH_SECRET must be at least 32 characters for security',
  },
]

/**
 * Validate all required environment variables
 */
function validateEnvironment(): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  console.log('[Startup] Validating environment variables...')

  for (const req of ENV_REQUIREMENTS) {
    const value = process.env[req.name]

    if (!value) {
      if (req.required) {
        errors.push(`Missing required environment variable: ${req.name}`)
      } else {
        warnings.push(`Optional environment variable not set: ${req.name}`)
      }
      continue
    }

    if (req.validate && !req.validate(value)) {
      errors.push(`Invalid ${req.name}: ${req.errorMessage}`)
    }
  }

  // Additional checks
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.VERCEL && !process.env.RAILWAY_ENVIRONMENT) {
      warnings.push('Production environment detected but no platform env vars found (VERCEL, RAILWAY)')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Validate database connectivity
 */
async function validateDatabaseConnection(): Promise<ValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []

  console.log('[Startup] Validating database connection...')

  try {
    // Simple connectivity check
    await prisma.$queryRaw`SELECT 1`
    console.log('[Startup] ✅ Database connection successful')
  } catch (error) {
    errors.push(`Database connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    return { valid: false, errors, warnings }
  }

  return { valid: true, errors, warnings }
}

/**
 * Validate Prisma schema matches database
 * Checks for pending migrations and schema drift
 */
async function validateSchemaAlignment(): Promise<ValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []

  console.log('[Startup] Validating schema alignment...')

  try {
    // Check for pending migrations using Prisma's migrate status
    // This requires prisma CLI to be available
    const migrateStatus = execSync('npx prisma migrate status', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    })

    // Parse migration status output
    if (migrateStatus.includes('have not been applied yet')) {
      errors.push('Pending database migrations detected. Run "npx prisma migrate deploy" before starting.')
    }

    if (migrateStatus.includes('diverged')) {
      errors.push('Database schema has diverged from Prisma schema. Migration history is inconsistent.')
    }

    console.log('[Startup] ✅ Schema alignment verified')
  } catch (error) {
    // If migrate status fails, try alternative validation
    console.log('[Startup] ⚠️  Prisma migrate status unavailable, using fallback validation...')
    
    const fallbackResult = await validateSchemaFallback()
    errors.push(...fallbackResult.errors)
    warnings.push(...fallbackResult.warnings)
  }

  return { valid: errors.length === 0, errors, warnings }
}

/**
 * Fallback schema validation when Prisma CLI is unavailable
 * Checks critical tables and columns exist
 */
async function validateSchemaFallback(): Promise<ValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []

  console.log('[Startup] Running fallback schema validation...')

  try {
    // Check critical tables exist
    const requiredTables = ['Project', 'User', 'BackendGraph', 'IntentLog']
    
    for (const table of requiredTables) {
      try {
        // Try to count rows - will fail if table doesn't exist
        await (prisma as any)[table.toLowerCase()]?.count?.()
      } catch (error) {
        errors.push(`Critical table missing or inaccessible: ${table}`)
      }
    }

    // Check for specific columns that have caused issues
    try {
      await prisma.$queryRaw`SELECT "projectStatus" FROM "Project" LIMIT 0`
    } catch (error) {
      errors.push('Schema mismatch: projects.projectStatus column missing. Migration required.')
    }

  } catch (error) {
    errors.push(`Schema fallback validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }

  return { valid: errors.length === 0, errors, warnings }
}

/**
 * Main startup validation
 * Call this before starting the server
 */
export async function runStartupValidation(): Promise<void> {
  console.log('\n' + '='.repeat(60))
  console.log('BACKENLY STARTUP VALIDATION')
  console.log('='.repeat(60) + '\n')

  const startTime = Date.now()
  let hasErrors = false

  // 1. Environment validation
  const envResult = validateEnvironment()
  if (!envResult.valid) {
    console.error('[Startup] ❌ Environment validation failed:')
    envResult.errors.forEach(e => console.error(`  - ${e}`))
    hasErrors = true
  } else {
    console.log('[Startup] ✅ Environment validation passed')
  }

  envResult.warnings.forEach(w => console.warn(`[Startup] ⚠️  ${w}`))

  // 2. Database connectivity
  const dbResult = await validateDatabaseConnection()
  if (!dbResult.valid) {
    console.error('[Startup] ❌ Database validation failed:')
    dbResult.errors.forEach(e => console.error(`  - ${e}`))
    hasErrors = true
  }

  // 3. Schema alignment (only if DB connection succeeded)
  if (dbResult.valid) {
    const schemaResult = await validateSchemaAlignment()
    if (!schemaResult.valid) {
      console.error('[Startup] ❌ Schema validation failed:')
      schemaResult.errors.forEach(e => console.error(`  - ${e}`))
      hasErrors = true
    } else {
      console.log('[Startup] ✅ Schema validation passed')
    }

    schemaResult.warnings.forEach(w => console.warn(`[Startup] ⚠️  ${w}`))
  }

  const duration = Date.now() - startTime
  console.log(`\n[Startup] Validation completed in ${duration}ms`)

  if (hasErrors) {
    console.error('\n' + '='.repeat(60))
    console.error('STARTUP FAILED - Fix errors above before restarting')
    console.error('='.repeat(60) + '\n')
    process.exit(1)
  }

  console.log('\n' + '='.repeat(60))
  console.log('✅ ALL VALIDATIONS PASSED - Starting server...')
  console.log('='.repeat(60) + '\n')
}

/**
 * Health check function for runtime health endpoint
 */
export async function runHealthCheck(): Promise<{
  healthy: boolean
  checks: Record<string, boolean>
  timestamp: string
}> {
  const checks: Record<string, boolean> = {
    database: false,
    schema: false,
  }

  try {
    // Database connectivity
    await prisma.$queryRaw`SELECT 1`
    checks.database = true

    // Basic schema check
    await prisma.project.count()
    checks.schema = true
  } catch (error) {
    // Check failed
  }

  return {
    healthy: Object.values(checks).every(v => v),
    checks,
    timestamp: new Date().toISOString(),
  }
}
