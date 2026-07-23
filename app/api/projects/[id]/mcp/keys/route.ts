export const dynamic = 'force-dynamic'

/**
 * MCP Key Management
 *
 *   GET  /api/projects/[id]/mcp/keys   — list this project's MCP keys (masked).
 *   POST /api/projects/[id]/mcp/keys   — issue a new MCP key. Returns the raw
 *                                        plaintext key ONCE; never again.
 *
 * Auth: platform JWT via withProjectValidation. The dashboard owner is the
 * only one who can mint MCP keys for a project.
 *
 * MCP keys differ from runtime SDK keys in three ways:
 *   - scope = 'mcp'                — required for /api/mcp/* surfaces.
 *   - keyType = 'mcp'              — distinct from 'public'/'dashboard' so the
 *                                    IAM key list can show them separately.
 *   - serviceRole = true           — runtime data CRUD bypasses end-user RLS,
 *                                    matching how the dashboard's data browser
 *                                    operates on behalf of the project owner.
 *   - keyPrefix starts 'mcp_live_' — visually distinguishable from sk_live_
 *                                    so a user pasting the wrong key into
 *                                    Claude Code or their app gets an obvious
 *                                    visual cue something is off.
 */

import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'

function generateMcpKey(): string {
  // 32 random bytes → 64 hex chars. The mcp_live_ prefix is a strong visual
  // tell: a leaked sk_live_... key cannot accidentally be pasted here without
  // the dashboard rejecting it (and vice-versa).
  return `mcp_live_${crypto.randomBytes(32).toString('hex')}`
}

function maskKey(prefix: string, prefixDb: string | null | undefined): string {
  // Show the prefix + 4 chars + ... + 4 hidden. We only have the prefix in
  // the DB (plaintext was never stored). This is enough for the user to
  // recognise which key is which on their dashboard.
  return `${prefixDb ?? prefix}…`
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withProjectValidation<any>(req, async ({ projectId }) => {
    // Belt-and-suspenders: withProjectValidation already JSON-wraps thrown
    // errors, but a Prisma error (e.g. an MCP-schema column missing before
    // `db:push` lands) can surface at the response-serialization boundary and
    // escape as a framework "Internal Server Error" text body — which turns
    // into a cryptic `Unexpected token 'I'` on the client. Catch it here so the
    // dashboard always receives clean JSON with an actionable message.
    try {
      const keys = await prisma.apiKey.findMany({
        where: { projectId, scope: 'mcp' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          mcpClientLabel: true,
          createdAt: true,
          lastUsed: true,
          expiresAt: true,
        },
      })

      return NextResponse.json({
        keys: keys.map((k) => ({
          id: k.id,
          name: k.name,
          label: k.mcpClientLabel,
          masked: maskKey('mcp_live_', k.keyPrefix),
          createdAt: k.createdAt,
          lastUsed: k.lastUsed,
          expiresAt: k.expiresAt,
        })),
      })
    } catch (err) {
      console.error('[mcp/keys] GET failed:', err)
      return NextResponse.json(
        { error: 'Could not load MCP keys', keys: [] },
        { status: 500 },
      )
    }
  })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withProjectValidation<any>(req, async ({ projectId, userId }) => {
    let body: { label?: string; name?: string } = {}
    try { body = await req.json() ?? {} } catch { /* allow empty */ }

    const label = (body.label || '').trim() || null
    const name = (body.name || '').trim() || 'MCP Key'

    const rawKey = generateMcpKey()
    const keyHash = hashApiKey(rawKey)
    const keyPrefix = rawKey.substring(0, 16) // "mcp_live_xxxxxxx"

    const record = await prisma.apiKey.create({
      data: {
        name,
        keyHash,
        keyPrefix,
        projectId,
        userId,
        // MCP keys are project-owner-level — give them admin permission set
        // for the brain dispatch surface. The catalog filter on /api/mcp/tool
        // is what actually limits the blast radius (no destructive tools).
        permissions: ['read', 'write', 'admin'],
        rateLimit: 600, // 10 req/sec — host LLMs rarely exceed this
        keyType: 'mcp',
        scope: 'mcp',
        serviceRole: true,
        mcpClientLabel: label,
      },
    })

    // Audit-log so the owner can see who minted MCP keys + when.
    await prisma.auditLog.create({
      data: {
        projectId,
        userId,
        action: 'MCP_KEY_CREATED',
        type: 'security',
        details: JSON.stringify({
          keyId: record.id,
          label,
          name,
          at: new Date().toISOString(),
        }),
        timestamp: new Date(),
      },
    }).catch(() => {})

    return NextResponse.json({
      // Plaintext returned ONCE. Show in the UI, copy to clipboard, then it's
      // never retrievable. The user can mint another at any time.
      rawKey,
      key: {
        id: record.id,
        name: record.name,
        label,
        masked: maskKey(keyPrefix, keyPrefix),
        createdAt: record.createdAt,
      },
    })
  })
}
