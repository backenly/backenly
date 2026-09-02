export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'
import crypto from 'crypto'
import { plaintextForStorage } from '@/lib/auth/api-key-plaintext'

function generateApiKey(prefix: string): string {
  const randomBytes = crypto.randomBytes(32).toString('hex')
  return `${prefix}${randomBytes}`
}

function getKeyPrefix(role: string): string {
  const prefixes: Record<string, string> = {
    'admin': 'sk_live_',
    'read-only': 'sk_read_',
    'write': 'sk_test_',
    'ai-only': 'sk_ai_',
  }
  return prefixes[role] || 'sk_'
}

/**
 * Rotate an API key - generates a new key while keeping the same settings
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = await requireAuth(request)

    const apiKey = await prisma.apiKey.findFirst({
      where: {
        id: params.id,
        userId: auth.userId,
      },
    })

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key not found' },
        { status: 404 }
      )
    }

    // ── The anon key cannot be rotated here ───────────────────────────────
    //
    // A project's anon key lives in TWO places: this ApiKey row, which holds
    // its hash, and Project.anonKey, which holds the plaintext the dashboard
    // and every generated frontend snippet read. Rotating only this row would
    // change what authenticates while leaving Project.anonKey serving the old
    // value, so every embedded client would start failing.
    //
    // This is a hazard created by fixing the bug below. While rotation never
    // wrote keyHash it was a no-op for authentication, so rotating the anon key
    // broke nothing. Now that it works, it would.
    //
    // Identified by hash rather than by name: the row is titled "Public Anon
    // Key" today, but matching on a display string would silently stop
    // protecting anything the moment somebody renamed it.
    if (apiKey.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: apiKey.projectId },
        select: { anonKey: true },
      })
      if (project?.anonKey) {
        const anonHash = crypto.createHash('sha256').update(project.anonKey).digest('hex')
        if (anonHash === apiKey.keyHash) {
          return NextResponse.json(
            {
              error:
                'This is the project anon key. Rotate it from the project anon key endpoint so the published value is updated at the same time.',
            },
            { status: 400 },
          )
        }
      }
    }

    // Generate new key
    const keyPrefix = getKeyPrefix(apiKey.role)
    const fullKey = generateApiKey(keyPrefix)

    // ── ROTATION DID NOT ROTATE ANYTHING ──────────────────────────────────
    //
    // This wrote `key: await hashPassword(fullKey)` — a BCRYPT hash, into the
    // plaintext column — and never touched `keyHash`. Every authentication path
    // looks the credential up by `keyHash` (lib/auth/apiKeyAuth.ts,
    // lib/auth/server.ts, lib/mcp/auth.ts, lib/middleware/apiKeyAuth.ts), so
    // the effect was:
    //
    //   • the NEW key handed back to the user did not authenticate, because its
    //     SHA-256 was never stored anywhere;
    //   • the OLD key kept working, because its SHA-256 was still in `keyHash`.
    //
    // Rotation is what somebody reaches for when a key has leaked. It reported
    // success, returned a key that did not work, and left the compromised
    // credential live. That is worse than the plaintext storage this commit is
    // otherwise about, so it is fixed here rather than filed.
    //
    // SHA-256 to match issuance and the auth lookups. Not bcrypt: `keyHash` is
    // a unique indexed column used for an O(1) equality lookup on every request,
    // and a per-row salted hash cannot be looked up by equality at all.
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex')

    // Update the key (keep all other settings)
    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: {
        // Replacing keyHash is what actually revokes the old credential.
        keyHash,
        // Never persisted, on any issuance path. See lib/auth/api-key-plaintext.ts.
        key: plaintextForStorage(),
        keyPrefix,
        requestCount: 0, // Reset usage counter
        resetAt: new Date(Date.now() + apiKey.rateLimitWindow * 1000),
      },
    })

    return NextResponse.json({
      apiKey: {
        id: apiKey.id,
        key: fullKey, // Only returned on rotation
        keyPrefix,
      },
      message: 'API key rotated successfully. Save the new key - it will not be shown again.',
    })
  } catch (error) {
    console.error('Rotate API key error:', error)
    return NextResponse.json(
      { error: 'Failed to rotate API key' },
      { status: 500 }
    )
  }
}
