import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifySession } from '@/lib/auth/session'
import { z } from 'zod'

/**
 * GET/PUT /api/projects/[id]/auth-email-settings
 *
 * Per-project end-user auth email settings (ProjectAuthConfig): the app name
 * and URL used in verification / magic-link / password-reset emails, plus the
 * requireEmailVerification and magicLinksEnabled policy toggles.
 */

async function authorize(request: NextRequest, projectId: string) {
  const token = request.cookies.get('auth-token')?.value
  if (!token) return null
  const session = await verifySession(token)
  if (!session.valid || !session.userId) return null
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: session.userId },
    select: { id: true, name: true, publicUrl: true },
  })
  return project
}

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const project = await authorize(request, params.id)
    if (!project) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const config = await prisma.projectAuthConfig.findUnique({
      where: { projectId: params.id },
    })

    return NextResponse.json({
      success: true,
      settings: {
        appName: config?.appName ?? null,
        appUrl: config?.appUrl ?? null,
        requireEmailVerification: config?.requireEmailVerification ?? false,
        magicLinksEnabled: config?.magicLinksEnabled ?? true,
        // Effective values after fallbacks — what emails will actually show.
        effectiveAppName: config?.appName || project.name,
        effectiveAppUrl: config?.appUrl || project.publicUrl || null,
      },
    })
  } catch (error: any) {
    console.error('[Auth Email Settings] GET failed:', error)
    return NextResponse.json({ error: 'Failed to load auth email settings' }, { status: 500 })
  }
}

const putSchema = z.object({
  appName: z.string().trim().max(80).nullable().optional(),
  appUrl: z.string().trim().url().max(500).nullable().optional().or(z.literal('').transform(() => null)),
  requireEmailVerification: z.boolean().optional(),
  magicLinksEnabled: z.boolean().optional(),
})

export async function PUT(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const project = await authorize(request, params.id)
    if (!project) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const parsed = putSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }
    const { appName, appUrl, requireEmailVerification, magicLinksEnabled } = parsed.data

    const data = {
      ...(appName !== undefined && { appName: appName || null }),
      ...(appUrl !== undefined && { appUrl: appUrl || null }),
      ...(requireEmailVerification !== undefined && { requireEmailVerification }),
      ...(magicLinksEnabled !== undefined && { magicLinksEnabled }),
    }

    const config = await prisma.projectAuthConfig.upsert({
      where: { projectId: params.id },
      create: { projectId: params.id, ...data },
      update: data,
    })

    return NextResponse.json({ success: true, settings: config })
  } catch (error: any) {
    console.error('[Auth Email Settings] PUT failed:', error)
    return NextResponse.json({ error: 'Failed to save auth email settings' }, { status: 500 })
  }
}
