import { NextRequest, NextResponse } from 'next/server'
import { getProjectAuthStatus } from '@/lib/services/auth-status'

/**
 * GET /api/projects/[projectId]/auth-state
 *
 * Auth provider status for the inspector. Delegates to the shared
 * getProjectAuthStatus resolver so this endpoint, the dashboard
 * (/api/projects/[id]/state), and the proof system always agree on
 * which providers are connected.
 */
export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const projectId = params.id
    const status = await getProjectAuthStatus(projectId)

    const ICON: Record<string, string> = {
      email: 'Mail',
      google: 'Chrome',
      github: 'Github',
    }

    const providers = status.providers.map(p => ({
      id: p.id,
      name: p.id,
      enabled: p.enabled,
      configured: p.enabled,
      type: p.type,
      icon: ICON[p.id] ?? 'Shield',
      clientId: null,
      clientSecret: null,
      redirectUri: null,
      scopes: [] as string[],
    }))

    return NextResponse.json({
      success: true,
      providers,
    })
  } catch (error: any) {
    console.error('[Auth State API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to load auth state', details: error?.message },
      { status: 500 }
    )
  }
}
