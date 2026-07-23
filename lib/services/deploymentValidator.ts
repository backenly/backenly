/**
 * Production-Grade Deployment Validator
 * 
 * Validates projects before deployment to prevent runtime failures
 * Implements strict pre-deploy checks and build detection
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { prisma } from '@/lib/db'

export type ProjectType = 'express' | 'nextjs' | 'worker'

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  projectType?: ProjectType
  buildConfig?: BuildConfig
  envVars?: {
    required: { [key: string]: string | null }
    optional: { [key: string]: string | null }
  }
}

export interface ValidationError {
  code: string
  message: string
  fix?: string
}

export interface ValidationWarning {
  code: string
  message: string
  recommendation?: string
}

export interface BuildConfig {
  type: ProjectType
  buildCommand: string
  startCommand: string
  port: number
  nodeVersion: string
}

export interface OAuthCheck {
  githubConfigured: boolean
  googleConfigured: boolean
  githubRedirectUrl?: string
  googleRedirectUrl?: string
}

/**
 * Deployment Validator Service
 */
export class DeploymentValidator {
  /**
   * 1️⃣ PRE-DEPLOY VALIDATION (BLOCKS DEPLOY IF FAILS)
   */
  static async validateProject(projectId: string): Promise<ValidationResult> {
    const errors: ValidationError[] = []
    const warnings: ValidationWarning[] = []
    
    const workspacePath = path.join(process.cwd(), 'workspace', projectId)

    // ✅ Check 1: Project exists in database (BaaS platform - database-driven, not file-driven)
    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true }
      })
      
      if (!project) {
        errors.push({
          code: 'PROJECT_NOT_FOUND',
          message: 'Project not found in database',
          fix: 'Ensure project exists before deploying'
        })
        return { valid: false, errors, warnings }
      }
    } catch (error) {
      errors.push({
        code: 'DATABASE_ERROR',
        message: 'Failed to verify project exists',
        fix: 'Check database connection'
      })
      return { valid: false, errors, warnings }
    }

    // ✅ Check 2: At least one API route exists (check API Definitions, not workspace files)
    const hasApiRoutes = await this.checkApiDefinitions(projectId)
    if (!hasApiRoutes) {
      errors.push({
        code: 'NO_API_ROUTES',
        message: 'No API routes found in project',
        fix: 'Create at least one API using the AI Workspace (e.g., "Create a todos API")'
      })
    }

    // ✅ Check 3: DATABASE_URL resolvable
    const dbCheck = await this.checkDatabase(projectId, workspacePath)
    if (!dbCheck.valid) {
      if (dbCheck.critical) {
        errors.push({
          code: 'DATABASE_NOT_CONFIGURED',
          message: dbCheck.message,
          fix: 'Click "Database" button to provision workspace database'
        })
      } else {
        warnings.push({
          code: 'DATABASE_WARNING',
          message: dbCheck.message,
          recommendation: 'Configure database before deploying for production use'
        })
      }
    }

    // ✅ Check 4: Prisma schema valid
    const prismaCheck = await this.validatePrismaSchema(workspacePath)
    if (!prismaCheck.valid) {
      errors.push({
        code: 'INVALID_PRISMA_SCHEMA',
        message: prismaCheck.error || 'Prisma schema validation failed',
        fix: 'Fix schema syntax errors in prisma/schema.prisma'
      })
    }

    // ✅ Check 5: Auth present → User model exists
    const authCheck = await this.checkAuthRequirements(projectId, workspacePath)
    if (authCheck.hasAuth && !authCheck.hasUserModel) {
      errors.push({
        code: 'AUTH_WITHOUT_USER_MODEL',
        message: 'Authentication routes found but User model missing in schema',
        fix: 'Add User model to prisma/schema.prisma or regenerate auth code'
      })
    }

    // ✅ Check 6: OAuth routes → Credentials exist
    const oauthCheck = await this.checkOAuthCredentials(projectId, workspacePath)
    if (oauthCheck.hasOAuthRoutes && !oauthCheck.credentialsConfigured) {
      warnings.push({
        code: 'OAUTH_NOT_CONFIGURED',
        message: oauthCheck.message,
        recommendation: 'Configure OAuth credentials in Auth page before deployment'
      })
    }

    // 2️⃣ DETERMINISTIC BUILD DETECTION
    const projectType = await this.detectProjectType(workspacePath)
    const buildConfig = this.getBuildConfig(projectType)

    // Store project type in metadata (only if valid)
    if (errors.length === 0) {
      await this.saveProjectMetadata(projectId, projectType, buildConfig)
    }

    // 3️⃣ ENVIRONMENT VARIABLE CONTRACT
    const envVars = await this.validateEnvironmentVariables(projectId, workspacePath)
    
    // Add errors for missing required env vars
    for (const [key, value] of Object.entries(envVars.required)) {
      if (value === null) {
        errors.push({
          code: 'MISSING_REQUIRED_ENV',
          message: `Required environment variable missing: ${key}`,
          fix: `Set ${key} in deployment configuration`
        })
      }
    }

    // Add warnings for missing optional env vars
    for (const [key, value] of Object.entries(envVars.optional)) {
      if (value === null && key.startsWith('OAUTH_')) {
        warnings.push({
          code: 'MISSING_OPTIONAL_ENV',
          message: `Optional OAuth variable not set: ${key}`,
          recommendation: 'Configure OAuth credentials if using authentication'
        })
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      projectType,
      buildConfig,
      envVars
    }
  }

  /**
   * Check if project has API Definitions (the actual APIs created by users)
   */
  private static async checkApiDefinitions(projectId: string): Promise<boolean> {
    try {
      const apiDefinitions = await prisma.apiDefinition.findMany({
        where: { projectId },
        select: { id: true }
      })
      
      return apiDefinitions.length > 0
    } catch (error) {
      console.error('[DeploymentValidator] Failed to check API Definitions:', error)
      return false
    }
  }

  /**
   * Check if project has workspace route files (legacy check - kept for backward compatibility)
   */
  private static async checkApiRoutes(workspacePath: string): Promise<boolean> {
    const routesPaths = [
      path.join(workspacePath, 'routes'),
      path.join(workspacePath, 'api'),
      path.join(workspacePath, 'src', 'routes'),
      path.join(workspacePath, 'src', 'api'),
    ]

    for (const routePath of routesPaths) {
      try {
        const stats = await fs.stat(routePath)
        if (stats.isDirectory()) {
          const files = await fs.readdir(routePath)
          if (files.length > 0) {
            return true
          }
        }
      } catch {
        continue
      }
    }

    return false
  }

  /**
   * Check database configuration
   */
  private static async checkDatabase(
    projectId: string,
    workspacePath: string
  ): Promise<{ valid: boolean; critical: boolean; message: string }> {
    try {
      // Check if workspace has .env with DATABASE_URL
      const envPath = path.join(workspacePath, '.env')
      try {
        const envContent = await fs.readFile(envPath, 'utf-8')
        if (envContent.includes('DATABASE_URL=')) {
          // Extract DATABASE_URL
          const match = envContent.match(/DATABASE_URL=(.+)/)
          if (match && match[1] && match[1].trim() && !match[1].includes('your-database-url-here')) {
            return { valid: true, critical: false, message: 'Database configured' }
          }
        }
      } catch {
        // No .env file
      }

      // Check if database has been provisioned in platform
      const workspace = await prisma.workspace.findFirst({
        where: { projectId },
        select: { databaseProvisioned: true }
      })

      if (workspace?.databaseProvisioned) {
        return { valid: true, critical: false, message: 'Database provisioned' }
      }

      // Check if Prisma schema exists (indicates DB is needed)
      const schemaPath = path.join(workspacePath, 'prisma', 'schema.prisma')
      try {
        await fs.access(schemaPath)
        return {
          valid: false,
          critical: true,
          message: 'Prisma schema found but DATABASE_URL not configured'
        }
      } catch {
        // No schema, DB might not be needed
        return {
          valid: true,
          critical: false,
          message: 'No database schema detected (database optional)'
        }
      }
    } catch (error) {
      return {
        valid: false,
        critical: false,
        message: 'Failed to check database configuration'
      }
    }
  }

  /**
   * Validate Prisma schema
   */
  private static async validatePrismaSchema(
    workspacePath: string
  ): Promise<{ valid: boolean; error?: string }> {
    const schemaPath = path.join(workspacePath, 'prisma', 'schema.prisma')
    
    try {
      await fs.access(schemaPath)
      const schemaContent = await fs.readFile(schemaPath, 'utf-8')

      // Basic syntax checks
      if (!schemaContent.includes('datasource db')) {
        return { valid: false, error: 'Missing datasource configuration' }
      }

      if (!schemaContent.includes('generator client')) {
        return { valid: false, error: 'Missing generator configuration' }
      }

      // Check for common syntax errors
      if (schemaContent.includes('model  ')) {
        return { valid: false, error: 'Syntax error: double space after "model"' }
      }

      return { valid: true }
    } catch {
      // No schema file - that's okay, project might not use database
      return { valid: true }
    }
  }

  /**
   * Check auth requirements
   */
  private static async checkAuthRequirements(
    projectId: string,
    workspacePath: string
  ): Promise<{ hasAuth: boolean; hasUserModel: boolean }> {
    // Check for auth routes
    const routesPaths = [
      path.join(workspacePath, 'routes', 'auth'),
      path.join(workspacePath, 'api', 'auth'),
      path.join(workspacePath, 'src', 'routes', 'auth'),
    ]

    let hasAuth = false
    for (const authPath of routesPaths) {
      try {
        await fs.access(authPath)
        hasAuth = true
        break
      } catch {
        continue
      }
    }

    if (!hasAuth) {
      return { hasAuth: false, hasUserModel: true } // No auth needed
    }

    // Check for User model in Prisma schema
    const schemaPath = path.join(workspacePath, 'prisma', 'schema.prisma')
    try {
      const schemaContent = await fs.readFile(schemaPath, 'utf-8')
      const hasUserModel = /model\s+User\s*{/.test(schemaContent)
      return { hasAuth, hasUserModel }
    } catch {
      return { hasAuth, hasUserModel: false }
    }
  }

  /**
   * Check OAuth credentials
   */
  private static async checkOAuthCredentials(
    projectId: string,
    workspacePath: string
  ): Promise<{ hasOAuthRoutes: boolean; credentialsConfigured: boolean; message: string }> {
    // Check for OAuth routes (github, google, etc.)
    const authFiles = [
      'routes/auth/github.ts',
      'routes/auth/google.ts',
      'api/auth/callback/github.ts',
      'api/auth/callback/google.ts',
    ]

    let hasGitHub = false
    let hasGoogle = false

    for (const file of authFiles) {
      try {
        await fs.access(path.join(workspacePath, file))
        if (file.includes('github')) hasGitHub = true
        if (file.includes('google')) hasGoogle = true
      } catch {
        continue
      }
    }

    if (!hasGitHub && !hasGoogle) {
      return { hasOAuthRoutes: false, credentialsConfigured: true, message: 'No OAuth routes' }
    }

    // Check if credentials configured in database
    const configs = await prisma.workspaceOAuthConfig.findMany({
      where: { projectId },
      select: { provider: true, enabled: true }
    })

    const githubConfigured = hasGitHub ? configs.some(c => c.provider === 'github' && c.enabled) : true
    const googleConfigured = hasGoogle ? configs.some(c => c.provider === 'google' && c.enabled) : true

    const credentialsConfigured = githubConfigured && googleConfigured

    let message = ''
    if (!githubConfigured) message += 'GitHub OAuth not configured. '
    if (!googleConfigured) message += 'Google OAuth not configured. '

    return {
      hasOAuthRoutes: hasGitHub || hasGoogle,
      credentialsConfigured,
      message: message || 'OAuth configured'
    }
  }

  /**
   * 2️⃣ DETERMINISTIC BUILD DETECTION (NO GUESSING)
   */
  private static async detectProjectType(workspacePath: string): Promise<ProjectType> {
    try {
      const packageJsonPath = path.join(workspacePath, 'package.json')
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))

      // Check dependencies
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies }

      // Next.js detection
      if (deps['next']) {
        return 'nextjs'
      }

      // Express.js detection
      if (deps['express']) {
        return 'express'
      }

      // Worker detection (no framework, pure Node.js)
      if (packageJson.name?.includes('worker') || packageJson.main?.includes('worker')) {
        return 'worker'
      }

      // Default to express (Backenly generates Express projects)
      return 'express'
    } catch {
      return 'express' // Safe default
    }
  }

  /**
   * Get build configuration for project type
   */
  private static getBuildConfig(projectType: ProjectType): BuildConfig {
    const configs: Record<ProjectType, BuildConfig> = {
      express: {
        type: 'express',
        buildCommand: 'npm run build || echo "No build step required"',
        startCommand: 'node dist/server.js || node server.js',
        port: 3000,
        nodeVersion: '20'
      },
      nextjs: {
        type: 'nextjs',
        buildCommand: 'npm run build',
        startCommand: 'npm start',
        port: 3000,
        nodeVersion: '20'
      },
      worker: {
        type: 'worker',
        buildCommand: 'npm run build',
        startCommand: 'node dist/index.js',
        port: 5173,
        nodeVersion: '20'
      }
    }

    return configs[projectType]
  }

  /**
   * Save project metadata to database
   */
  private static async saveProjectMetadata(
    projectId: string,
    projectType: ProjectType,
    buildConfig: BuildConfig
  ): Promise<void> {
    try {
      // Store in workspace metadata (you may need to add a JSON column)
      await prisma.workspace.updateMany({
        where: { projectId },
        data: {
          // You might want to add a metadata JSON column to Workspace model
          // For now, we can use the project's environment
          environment: 'production'
        }
      })

      // Or create a separate ProjectMetadata table
      // For now, we'll just log it
      console.log(`[DeploymentValidator] Detected ${projectType} project for ${projectId}`)
    } catch (error) {
      console.error('[DeploymentValidator] Failed to save metadata:', error)
    }
  }

  /**
   * 3️⃣ ENVIRONMENT VARIABLE CONTRACT
   */
  private static async validateEnvironmentVariables(
    projectId: string,
    workspacePath: string
  ): Promise<{
    required: { [key: string]: string | null }
    optional: { [key: string]: string | null }
  }> {
    const required = {
      DATABASE_URL: null as string | null,
      PORT: '3000',
      NODE_ENV: 'production',
      PROJECT_ID: projectId
    }

    const optional = {
      RENDER_URL: null as string | null, // Render injects this at runtime
      OAUTH_GITHUB_CLIENT_ID: null as string | null,
      OAUTH_GITHUB_CLIENT_SECRET: null as string | null,
      OAUTH_GOOGLE_CLIENT_ID: null as string | null,
      OAUTH_GOOGLE_CLIENT_SECRET: null as string | null,
      JWT_SECRET: null as string | null
    }

    // Check workspace .env
    try {
      const envPath = path.join(workspacePath, '.env')
      const envContent = await fs.readFile(envPath, 'utf-8')
      
      const parseEnv = (content: string, vars: { [key: string]: string | null }) => {
        for (const key of Object.keys(vars)) {
          const match = content.match(new RegExp(`${key}=(.+)`))
          if (match && match[1] && match[1].trim()) {
            vars[key] = match[1].trim()
          }
        }
      }

      parseEnv(envContent, required)
      parseEnv(envContent, optional)
    } catch {
      // No .env file
    }

    // Check database config
    const workspace = await prisma.workspace.findFirst({
      where: { projectId },
      select: { databaseProvisioned: true, postgresSchema: true }
    })

    if (workspace?.databaseProvisioned && workspace.postgresSchema) {
      // Database will be injected at deploy time
      required.DATABASE_URL = `<will-be-injected-by-render>`
    }

    // Check OAuth config
    const oauthConfigs = await prisma.workspaceOAuthConfig.findMany({
      where: { projectId, enabled: true },
      select: { provider: true, clientId: true, clientSecret: true }
    })

    for (const config of oauthConfigs) {
      if (config.provider === 'github') {
        optional.OAUTH_GITHUB_CLIENT_ID = config.clientId
        optional.OAUTH_GITHUB_CLIENT_SECRET = config.clientSecret
      } else if (config.provider === 'google') {
        optional.OAUTH_GOOGLE_CLIENT_ID = config.clientId
        optional.OAUTH_GOOGLE_CLIENT_SECRET = config.clientSecret
      }
    }

    return { required, optional }
  }

  /**
   * 4️⃣ OAUTH PRODUCTION READINESS CHECK
   */
  static async checkOAuthReadiness(projectId: string, renderUrl?: string): Promise<OAuthCheck> {
    const configs = await prisma.workspaceOAuthConfig.findMany({
      where: { projectId },
      select: { provider: true, enabled: true, clientId: true }
    })

    const githubConfig = configs.find(c => c.provider === 'github')
    const googleConfig = configs.find(c => c.provider === 'google')

    return {
      githubConfigured: !!githubConfig?.enabled,
      googleConfigured: !!googleConfig?.enabled,
      githubRedirectUrl: renderUrl ? `${renderUrl}/api/auth/callback/github` : undefined,
      googleRedirectUrl: renderUrl ? `${renderUrl}/api/auth/callback/google` : undefined
    }
  }
}
