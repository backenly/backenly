/**
 * Workspace OAuth Configuration Service
 * 
 * Manages OAuth credentials for workspace-generated auth routes.
 * These are project-scoped and independent of platform OAuth.
 */

import { prisma } from '@/lib/db'
import * as crypto from 'crypto'
import { requireOAuthEncryptionKey } from '@/lib/auth/jwt-secret'

// Resolved per call — see lib/auth/jwt-secret.ts. A published default here
// meant every stored OAuth client secret was decryptable by anyone.
const ALGORITHM = 'aes-256-cbc'

/**
 * Encrypt sensitive data (client secrets)
 */
function encrypt(text: string): string {
  const key = crypto.scryptSync(requireOAuthEncryptionKey(), 'salt', 32)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  
  return `${iv.toString('hex')}:${encrypted}`
}

/**
 * Decrypt sensitive data
 */
function decrypt(encryptedText: string): string {
  const [ivHex, encrypted] = encryptedText.split(':')
  const key = crypto.scryptSync(requireOAuthEncryptionKey(), 'salt', 32)
  const iv = Buffer.from(ivHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  
  return decrypted
}

export interface WorkspaceOAuthConfigData {
  provider: string
  clientId: string
  clientSecret: string
  redirectUri?: string
  scopes?: string[]
  enabled?: boolean
  generatedAt?: Date
}

export interface WorkspaceOAuthConfigResponse {
  id: string
  projectId: string
  provider: string
  clientId: string
  clientSecret: string // Decrypted
  redirectUri: string | null
  scopes: string[]
  enabled: boolean
  generatedAt: Date | null
  configuredAt: Date
  createdAt: Date
  updatedAt: Date
}

export class WorkspaceOAuthService {
  /**
   * Create or update workspace OAuth configuration
   */
  static async upsertConfig(
    projectId: string,
    data: WorkspaceOAuthConfigData
  ): Promise<WorkspaceOAuthConfigResponse> {
    // Encrypt client secret
    const encryptedSecret = encrypt(data.clientSecret)

    const config = await prisma.workspaceOAuthConfig.upsert({
      where: {
        projectId_provider: {
          projectId,
          provider: data.provider,
        },
      },
      create: {
        projectId,
        provider: data.provider,
        clientId: data.clientId,
        clientSecret: encryptedSecret,
        redirectUri: data.redirectUri || null,
        scopes: data.scopes || [],
        enabled: data.enabled ?? true,
        generatedAt: data.generatedAt || null,
      },
      update: {
        clientId: data.clientId,
        clientSecret: encryptedSecret,
        redirectUri: data.redirectUri || null,
        scopes: data.scopes || [],
        enabled: data.enabled ?? true,
      },
    })

    // Decrypt for response
    return {
      ...config,
      clientSecret: decrypt(config.clientSecret),
    }
  }

  /**
   * Get workspace OAuth configuration
   */
  static async getConfig(
    projectId: string,
    provider: string
  ): Promise<WorkspaceOAuthConfigResponse | null> {
    const config = await prisma.workspaceOAuthConfig.findUnique({
      where: {
        projectId_provider: {
          projectId,
          provider,
        },
      },
    })

    if (!config) return null

    return {
      ...config,
      clientSecret: decrypt(config.clientSecret),
    }
  }

  /**
   * List all OAuth configurations for a workspace
   */
  static async listConfigs(projectId: string): Promise<WorkspaceOAuthConfigResponse[]> {
    const configs = await prisma.workspaceOAuthConfig.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    })

    return configs.map(config => ({
      ...config,
      clientSecret: decrypt(config.clientSecret),
    }))
  }

  /**
   * Delete workspace OAuth configuration
   */
  static async deleteConfig(projectId: string, provider: string): Promise<void> {
    await prisma.workspaceOAuthConfig.delete({
      where: {
        projectId_provider: {
          projectId,
          provider,
        },
      },
    })
  }

  /**
   * Check if workspace has OAuth routes generated for a provider
   * (Checks for auth route files in workspace directory)
   */
  static async hasAuthRoutesGenerated(
    projectId: string,
    provider: string
  ): Promise<boolean> {
    const fs = require('fs').promises
    const path = require('path')
    
    const workspacePath = path.join(process.cwd(), 'workspace', projectId, 'routes', 'auth')
    const providerRoutePath = path.join(workspacePath, `${provider}.ts`)
    
    try {
      await fs.access(providerRoutePath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Mark OAuth routes as generated (called by AI after generation)
   */
  static async markRoutesGenerated(
    projectId: string,
    provider: string
  ): Promise<void> {
    await prisma.workspaceOAuthConfig.upsert({
      where: {
        projectId_provider: {
          projectId,
          provider,
        },
      },
      create: {
        projectId,
        provider,
        clientId: '',
        clientSecret: encrypt('pending'),
        generatedAt: new Date(),
        enabled: false, // Not enabled until credentials are configured
      },
      update: {
        generatedAt: new Date(),
      },
    })
  }

  /**
   * Get OAuth configuration for deployment
   * (Used when injecting env vars into deployed workspace)
   */
  static async getConfigForDeployment(
    projectId: string,
    provider: string
  ): Promise<{ clientId: string; clientSecret: string } | null> {
    const config = await this.getConfig(projectId, provider)
    if (!config || !config.enabled) return null

    return {
      clientId: config.clientId,
      clientSecret: config.clientSecret, // Already decrypted
    }
  }
}
