/**
 * The default API key a newly created project is handed once.
 *
 * Lives beside the provisioner rather than inside a route so that every
 * creation path issues the same credential with the same shape. It is separate
 * FROM the provisioner because bootstrap does not want it: a self-host
 * deployment mints its keys from the dashboard, and manufacturing one during
 * reconciliation would create a credential nobody asked for and nobody sees.
 */
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { plaintextForStorage } from '@/lib/auth/api-key-plaintext'

/**
 * Mint the project's first key and return the plaintext exactly once.
 *
 * Null on failure, never a throw. A project with no default key is repairable
 * from the dashboard in one click; failing the creation request instead would
 * leave a fully provisioned project that the caller was never told about, and
 * they would create a second one.
 */
export async function createDefaultApiKey(
  projectId: string,
  projectName: string,
  userId: string,
): Promise<string | null> {
  try {
    const apiKeyPrefix = 'sk_live_'
    const plaintext = `${apiKeyPrefix}${crypto.randomBytes(32).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(plaintext).digest('hex')

    await prisma.apiKey.create({
      data: {
        name: `${projectName} Default Key`,
        // Never persisted. The credential a frontend should embed is
        // Project.anonKey; this one is issued with an sk_live_ prefix and role
        // 'admin'. See lib/auth/api-key-plaintext.ts.
        key: plaintextForStorage(),
        keyHash, // SHA-256, for O(1) auth lookup
        keyPrefix: apiKeyPrefix,
        keyType: 'public',
        role: 'admin',
        permissions: [],
        capabilities: ['database', 'auth', 'storage', 'functions', 'ai'],
        serviceRole: false,
        projectId,
        userId,
        rateLimit: 1000,
        rateLimitWindow: 3600, // 1 hour
      },
    })

    return plaintext
  } catch (err) {
    console.error(`[provision] default API key not created for ${projectId}:`, err)
    return null
  }
}
