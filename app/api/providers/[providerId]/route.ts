export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAdmin } from '@/lib/auth/middleware'

/**
 * Identity provider configuration. PLATFORM ADMIN ONLY.
 *
 * ── What these routes allowed ───────────────────────────────────────────────
 *
 * Every verb here called `requireAuth` and discarded the result, so ANY
 * authenticated account could read, reconfigure or delete an identity
 * provider. The read was the worst of the three: it returned the whole
 * AuthProvider row, and that row carries `clientSecret`. An OAuth client
 * secret was therefore readable by any signed-in user.
 *
 * An identity provider decides who may sign in to this deployment. It is not
 * project-scoped and there is no per-user notion of owning one, so the correct
 * check is platform admin rather than a project guard.
 *
 * The secret is also no longer returned. Admin or not, a configuration screen
 * needs to know a secret is SET, not what it is - and a response that carries
 * it turns every log, proxy and browser cache into another place it lives.
 */

/** Never send the client secret to a browser. */
function redactProvider<T extends { clientSecret?: string | null }>(provider: T) {
  const { clientSecret, ...rest } = provider
  return { ...rest, clientSecretSet: Boolean(clientSecret) }
}
import { z } from 'zod'

const updateProviderSchema = z.object({
  enabled: z.boolean().optional(),
  configured: z.boolean().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  redirectUri: z.string().url().optional(),
  scopes: z.array(z.string()).optional(),
  warning: z.string().optional(),
  codeGenerated: z.boolean().optional(),
  modifiedBy: z.enum(['ui', 'code']).optional(),
})

export async function GET(request: NextRequest, props: { params: Promise<{ providerId: string }> }) {
  const params = await props.params;
  try {
    const adminError = await requireAdmin(request)
    if (adminError) return adminError

    const provider = await prisma.authProvider.findUnique({
      where: { id: params.providerId },
    })
    
    if (!provider) {
      return NextResponse.json(
        { error: 'Provider not found' },
        { status: 404 }
      )
    }
    
    return NextResponse.json({ provider: redactProvider(provider) })
  } catch (error) {
    console.error('Get provider error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch provider' },
      { status: 500 }
    )
  }
}

export async function PUT(request: NextRequest, props: { params: Promise<{ providerId: string }> }) {
  const params = await props.params;
  try {
    const adminError = await requireAdmin(request)
    if (adminError) return adminError
    const body = await request.json()
    const data = updateProviderSchema.parse(body)
    
    const provider = await prisma.authProvider.update({
      where: { id: params.providerId },
      data: {
        ...data,
        lastModified: new Date(),
      },
    })
    
    return NextResponse.json({ provider: redactProvider(provider) })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }
    
    console.error('Update provider error:', error)
    return NextResponse.json(
      { error: 'Failed to update provider' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ providerId: string }> }) {
  const params = await props.params;
  try {
    const adminError = await requireAdmin(request)
    if (adminError) return adminError
    
    await prisma.authProvider.delete({
      where: { id: params.providerId },
    })
    
    return NextResponse.json({ message: 'Provider deleted successfully' })
  } catch (error) {
    console.error('Delete provider error:', error)
    return NextResponse.json(
      { error: 'Failed to delete provider' },
      { status: 500 }
    )
  }
}

