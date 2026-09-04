import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifySession } from '@/lib/auth/session'
import { z } from 'zod'
import { canAccessProject, canWriteProject } from '@/lib/edition/guard'

/**
 * GET/PUT /api/projects/[id]/auth-email-settings
 *
 * Per-project end-user auth email settings (ProjectAuthConfig): the app name
 * and URL used in verification / magic-link / password-reset emails, plus the
 * requireEmailVerification and magicLinksEnabled policy toggles.
 */

/**
 * Authentication only: who is calling, or null.
 *
 * This used to be `authorize`, and it did three jobs at once — read the
 * session, check ownership, and hand back the project row — behind a single
 * null return. That made every failure indistinguishable, so an authenticated
 * member who simply lacked access was told "Unauthorized" with a 401, which
 * says re-authenticate when re-authenticating cannot help. Teaching that helper
 * about roles would have deepened the conflation rather than fixing it.
 *
 * Authentication, authorization and data retrieval are now three steps, in that
 * order, at each call site.
 */
async function authenticate(request: NextRequest): Promise<string | null> {
  const token = request.cookies.get('auth-token')?.value
  if (!token) return null
  const session = await verifySession(token)
  if (!session.valid || !session.userId) return null
  return session.userId
}

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const userId = await authenticate(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!(await canAccessProject(userId, params.id))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Fetched for the effective-value fallbacks below, and deliberately by id
    // alone: the authorization question was already answered above.
    const project = await prisma.project.findUnique({
      where: { id: params.id },
      select: { id: true, name: true, publicUrl: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
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
    const userId = await authenticate(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    // No project row is needed here: PUT upserts ProjectAuthConfig by projectId
    // and never read the row it used to fetch.
    if (!(await canWriteProject(userId, params.id))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
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
