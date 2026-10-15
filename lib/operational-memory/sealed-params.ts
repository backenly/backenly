/**
 * Sealed executor params for pending-approval findings.
 *
 * A parked action's exact arguments must survive until a human approves it —
 * approval replays them verbatim, that is the whole contract — but the finding
 * row that carries them is SERVED: the health endpoint, the trust report, the
 * Review Queue card and `get_autonomy_status` (read-only MCP keys included)
 * all render `details`. A SET_ENV_VAR parked with a provider key therefore
 * published that key to every surface that could list findings.
 *
 * So the row stores two copies: a display copy with secret-named fields
 * redacted (lib/mcp/withhold-secrets.ts), and this sealed copy that only the
 * approval replay opens. AES-256-GCM under a key derived from JWT_SECRET,
 * which every running deployment has — a platform without it cannot sign a
 * session, so there is no working install this breaks.
 *
 * `unsealParams` answers null for anything it cannot open — absent, corrupt,
 * or written under another deployment's secret — and the replay then falls
 * back to the stored display copy, which is exactly what legacy rows (sealed
 * copy absent, params unredacted) need to keep approving.
 */

import crypto from 'crypto'
import { requireJwtSecret } from '@/lib/auth/jwt-secret'

const VERSION = 'v1'

function sealingKey(): Buffer {
  return crypto
    .createHash('sha256')
    .update(`backenly:pending-executor-params:${requireJwtSecret('seal pending executor params')}`)
    .digest()
}

/** The params as a sealed, storable string. */
export function sealParams(params: Record<string, unknown>): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', sealingKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(params ?? {}), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.')
}

/** The original params, or null when `sealed` is absent or cannot be opened. */
export function unsealParams(sealed: unknown): Record<string, unknown> | null {
  if (typeof sealed !== 'string' || !sealed.startsWith(`${VERSION}.`)) return null
  try {
    const [, ivB64, tagB64, ctB64] = sealed.split('.')
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealingKey(), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
    const parsed = JSON.parse(plain)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
