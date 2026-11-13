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
import { mintKey } from '@/lib/auth/key-prefix'

/**
 * Mint the project's first key and return the plaintext exactly once.
 *
 * A publishable key: the `client` role, reads and writes bound by row-level
 * security, no AI generation, safe in a browser bundle, as its `proj_live_`
 * prefix says. Not the admin role, which skips every permission check and
 * makes storage treat the key as an operator (every file listed, downloaded
 * and deletable). A server that needs more creates a service key
 * (Settings → API keys → New key → Admin).
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
    const { key: plaintext, prefix: apiKeyPrefix } = mintKey({ keyType: 'public', serviceRole: false })
    const keyHash = crypto.createHash('sha256').update(plaintext).digest('hex')

    // history: issued with the project, before its history begins
    await prisma.apiKey.create({
      data: {
        name: `${projectName} Default Key`,
        // Never persisted: shown once, at creation. See lib/auth/api-key-plaintext.ts.
        key: plaintextForStorage(),
        keyHash, // SHA-256, for O(1) auth lookup
        keyPrefix: apiKeyPrefix,
        keyType: 'public',
        role: 'client',
        permissions: ['read', 'write'],
        // No 'ai': generation from a browser would spend the project's credits
        // for anyone who opened the page.
        capabilities: ['database', 'auth', 'storage', 'functions'],
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
