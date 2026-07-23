import { prisma } from '@/lib/db';
import * as crypto from 'crypto';

/**
 * JWT Secret Manager
 *
 * Handles persistent JWT secrets per project to prevent user logout on redeploy.
 * Secrets are stored encrypted in the database and reused across deployments.
 *
 * SECURITY CONTRACT:
 *   - MASTER_ENCRYPTION_KEY is REQUIRED in production. Startup fails otherwise.
 *   - The previous "all zeros" dev fallback is still accepted for *decryption*
 *     only, so existing rows can be migrated. New encryption always uses the
 *     configured key. Run `scripts/migrate-master-key.ts` once, then set
 *     ALLOW_LEGACY_MASTER_KEY=0 to disable the fallback entirely.
 *   - AES-256-GCM with a 12-byte IV (GCM standard). Legacy rows used 16 bytes
 *     and are still readable via length sniff.
 */

const ALG = 'aes-256-gcm'

class MasterKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MasterKeyError'
  }
}

function legacyZeroKey(): Buffer {
  // 32 bytes of zero — the historical "default" used when MASTER_ENCRYPTION_KEY
  // was unset. We keep it for one-shot decryption during migration; production
  // must NEVER use this for encryption.
  return Buffer.alloc(32, 0)
}

/**
 * Resolve the active master key for encryption.
 * In production this MUST be a 32-byte (64-hex-char) value from env.
 */
function getActiveMasterKey(): Buffer {
  const raw = process.env.MASTER_ENCRYPTION_KEY
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new MasterKeyError(
        'MASTER_ENCRYPTION_KEY is required in production. Generate with: ' +
        '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` ' +
        'and set it in the deployment environment.'
      )
    }
    // Development convenience only — never reached when NODE_ENV=production.
    console.warn('[jwtSecretManager] MASTER_ENCRYPTION_KEY unset (dev only) — using zero key. Set the env var.')
    return legacyZeroKey()
  }
  let buf: Buffer
  try { buf = Buffer.from(raw, 'hex') } catch {
    throw new MasterKeyError('MASTER_ENCRYPTION_KEY must be hex-encoded.')
  }
  if (buf.length !== 32) {
    throw new MasterKeyError(`MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}). Use 64 hex chars.`)
  }
  return buf
}

/**
 * For decrypt: try the active key first, then the legacy zero key (one-shot
 * migration). Set ALLOW_LEGACY_MASTER_KEY=0 in env once migration is done to
 * disable the fallback entirely.
 */
function getDecryptionKeys(): Buffer[] {
  const active = getActiveMasterKey()
  const allowLegacy = process.env.ALLOW_LEGACY_MASTER_KEY !== '0'
  if (allowLegacy && !active.equals(legacyZeroKey())) {
    return [active, legacyZeroKey()]
  }
  return [active]
}

export class JWTSecretManager {
  /**
   * Get or create a persistent JWT secret for a project.
   */
  static async getOrCreateSecret(projectId: string): Promise<string> {
    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { jwtSecret: true },
      });

      if (project?.jwtSecret) {
        return this.decrypt(project.jwtSecret);
      }

      const secret = this.generateSecret();
      const encryptedSecret = this.encrypt(secret);

      await prisma.project.update({
        where: { id: projectId },
        data: { jwtSecret: encryptedSecret },
      });

      return secret;
    } catch (error: any) {
      if (error instanceof MasterKeyError) throw error
      console.error('Failed to get/create JWT secret:', error?.message ?? 'unknown');
      throw new Error('JWT secret management failed');
    }
  }

  private static generateSecret(): string {
    return crypto.randomBytes(64).toString('hex');
  }

  /**
   * Encrypt a secret with the active master key.
   * Format: <ivHex>:<authTagHex>:<ciphertextHex>
   * IV is 12 bytes (GCM standard).
   */
  private static encrypt(secret: string): string {
    const key = getActiveMasterKey()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv(ALG, key, iv)
    let encrypted = cipher.update(secret, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag()
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
  }

  /**
   * Decrypt — tries active key first, legacy zero key second (during migration).
   * Throws if neither works.
   */
  private static decrypt(encryptedSecret: string): string {
    const [ivHex, authTagHex, encrypted] = encryptedSecret.split(':')
    if (!ivHex || !authTagHex || !encrypted) {
      throw new Error('Invalid encrypted secret format')
    }
    const iv = Buffer.from(ivHex, 'hex')        // 12 or 16 bytes (legacy)
    const authTag = Buffer.from(authTagHex, 'hex')

    let lastErr: unknown
    for (const key of getDecryptionKeys()) {
      try {
        const decipher = crypto.createDecipheriv(ALG, key, iv)
        decipher.setAuthTag(authTag)
        let decrypted = decipher.update(encrypted, 'hex', 'utf8')
        decrypted += decipher.final('utf8')
        return decrypted
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Decryption failed')
  }

  /**
   * Resolve a stored jwtSecret value to its plaintext signing key.
   *
   * Handles three cases:
   *   1. New encrypted format — `<ivHex>:<authTagHex>:<ciphertextHex>` with
   *      hex-only parts. Decrypts with the active key (legacy zero key as
   *      fallback when ALLOW_LEGACY_MASTER_KEY != '0').
   *   2. Legacy plaintext — raw 64-hex-char string with no colons. Returned
   *      as-is. These rows predate any encryption-at-rest and are gradually
   *      migrated to format (1) by `migrateOnRead()` / the bulk migration.
   *   3. Anything else — throw.
   *
   * Sync. Cheap on the hot path because the format check is one split + regex.
   */
  static resolve(stored: string): string {
    if (!stored || typeof stored !== 'string') throw new Error('jwtSecret is empty')
    const parts = stored.split(':')
    const looksEncrypted =
      parts.length === 3 &&
      parts.every(p => /^[0-9a-f]+$/i.test(p)) &&
      parts[0].length >= 24 && // 12-byte IV (24 hex) or legacy 16-byte (32 hex)
      parts[1].length === 32   // GCM auth tag (16 bytes / 32 hex)
    if (looksEncrypted) return this.decrypt(stored)
    // Legacy plaintext — pass through. This is what the platform has been
    // using all along (the `JWTSecretManager.encrypt` path was never actually
    // invoked at write time for these rows).
    return stored
  }

  /**
   * Migrate one project's jwtSecret to the encrypted format.
   * Idempotent — encrypted rows get re-encrypted with the active key.
   */
  static async reencryptForProject(projectId: string): Promise<{ migrated: boolean; reason?: string }> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { jwtSecret: true },
    })
    if (!project?.jwtSecret) return { migrated: false, reason: 'no_secret' }
    // `resolve()` returns plaintext regardless of stored format (encrypted or
    // legacy plaintext). `encrypt()` then writes the canonical encrypted form.
    const plaintext = this.resolve(project.jwtSecret)
    const reencrypted = this.encrypt(plaintext)
    await prisma.project.update({
      where: { id: projectId },
      data: { jwtSecret: reencrypted },
    })
    return { migrated: true }
  }

  /**
   * Generate auth manifest for a project.
   */
  static async generateAuthManifest(projectId: string): Promise<any> {
    const manifest = {
      version: 'v1',
      generatedAt: new Date().toISOString(),
      projectId,
      auth: {
        providers: {
          email: {
            enabled: true,
            passwordPolicy: { minLength: 12, requireLetter: true, requireNumber: true, requireSpecial: true },
          },
          github: { enabled: false, scopes: ['user:email', 'read:user'], emailFallback: true },
          google: { enabled: false, scopes: ['openid', 'email', 'profile'] },
        },
        security: {
          tokenExpiry: '30d',
          tokenVersioning: true,
          crossProjectIsolation: true,
          rateLimiting: { login: '5 requests/min', register: '3 requests/min', oauth: '10 requests/min' },
          softDelete: true,
          accountLinking: 'manual',
        },
      },
    };

    await prisma.project.update({
      where: { id: projectId },
      data: { authManifest: manifest },
    });

    return manifest;
  }

  static async buildAuthEnvVars(projectId: string): Promise<Record<string, string>> {
    const jwtSecret = await this.getOrCreateSecret(projectId);
    return { JWT_SECRET: jwtSecret, PROJECT_ID: projectId };
  }
}

/**
 * Convenience wrapper — consumers call this to get the plaintext signing key
 * from a stored Project.jwtSecret value. Handles both legacy plaintext and
 * the new encrypted format transparently.
 *
 * Use this everywhere jwt.sign / jwt.verify reads project.jwtSecret, so we
 * can migrate rows to encrypted-at-rest without breaking any verifier.
 */
export function resolveJwtSecret(stored: string): string {
  return JWTSecretManager.resolve(stored)
}
