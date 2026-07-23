export const dynamic = 'force-dynamic'

/**
 * GET /api/projects/[id]/anon-key
 *
 * Returns the project's public anon key — auto-generating one if it doesn't exist yet.
 * This key is safe to embed in frontend code.
 * Stored in plaintext on the project so it can always be retrieved.
 */

import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'
import { generateApiKey } from '@/lib/auth/apiKeyAuth'

export async function GET(req: NextRequest) {
  return withProjectValidation(req, async ({ projectId, userId }) => {
    // Return existing anon key if already generated
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { anonKey: true },
    })

    if (project?.anonKey) {
      return NextResponse.json({ anonKey: project.anonKey })
    }

    // Auto-generate a public anon key for this project
    const anonKey = generateApiKey('live')
    const keyHash = createHash('sha256').update(anonKey).digest('hex')
    const keyPrefix = anonKey.substring(0, 16)

    await prisma.$transaction([
      // Register in ApiKey table so existing hash-based auth validation works
      prisma.apiKey.create({
        data: {
          name: 'Public Anon Key',
          keyHash,
          keyPrefix,
          projectId,
          userId,
          permissions: ['read', 'write'],
          rateLimit: 1000,
          keyType: 'public',
          serviceRole: false,
        },
      }),
      // Store plaintext on project — anon keys are public by design
      prisma.project.update({
        where: { id: projectId },
        data: { anonKey },
      }),
    ])

    return NextResponse.json({ anonKey })
  })
}
