/**
 * Provider Credentials Service
 * 
 * Manages encrypted provider credentials
 */

import { prisma } from '@/lib/db'
import { encryptJSON, decryptJSON } from './encryption'

export type ProviderType = 'export' | 'serverless' | 'vercel' | 'local' | 'docker' | 'github' // Provider credential types (serverless = default)

export interface FlyCredentials {
  apiToken: string
  orgSlug?: string
}



export interface VercelCredentials {
  token: string
  teamId?: string
}

export interface DockerCredentials {
  username: string
  password: string
  registry?: string
}

export interface GitHubCredentials {
  token: string
  owner?: string
  repo?: string
}

export type ProviderCredentials = 
  | FlyCredentials
  | VercelCredentials 
  | DockerCredentials 
  | GitHubCredentials

export class ProviderCredentialsService {
  /**
   * Save or update provider credentials
   */
  static async saveCredentials(
    projectId: string,
    provider: ProviderType,
    credentials: ProviderCredentials,
    name?: string
  ) {
    // Encrypt credentials
    const encrypted = encryptJSON(credentials)

    // Upsert credentials
    return prisma.providerCredential.upsert({
      where: {
        projectId_provider: {
          projectId,
          provider,
        },
      },
      create: {
        projectId,
        provider,
        name,
        credentials: encrypted,
        lastUsedAt: new Date(),
      },
      update: {
        name,
        credentials: encrypted,
        lastUsedAt: new Date(),
      },
    })
  }

  /**
   * Get decrypted credentials for a provider
   */
  static async getCredentials(
    projectId: string,
    provider: ProviderType
  ): Promise<ProviderCredentials | null> {
    const credential = await prisma.providerCredential.findUnique({
      where: {
        projectId_provider: {
          projectId,
          provider,
        },
      },
    })

    if (!credential) {
      return null
    }

    // Decrypt and return
    return decryptJSON(credential.credentials) as ProviderCredentials
  }

  /**
   * List all credentials for a project
   */
  static async listCredentials(projectId: string) {
    return prisma.providerCredential.findMany({
      where: { projectId },
      select: {
        id: true,
        provider: true,
        name: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
        // Don't return encrypted credentials
      },
    })
  }

  /**
   * Delete credentials
   */
  static async deleteCredentials(projectId: string, provider: ProviderType) {
    return prisma.providerCredential.delete({
      where: {
        projectId_provider: {
          projectId,
          provider,
        },
      },
    })
  }

  /**
   * Check if credentials exist
   */
  static async hasCredentials(projectId: string, provider: ProviderType): Promise<boolean> {
    const credential = await prisma.providerCredential.findUnique({
      where: {
        projectId_provider: {
          projectId,
          provider,
        },
      },
    })
    return !!credential
  }
}

