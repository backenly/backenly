import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db'
import crypto from 'crypto'
import { canWriteProject } from '@/lib/edition/guard'

/**
 * PROMPT 7 — URL-Based App Connection
 * 
 * POST /api/connect/url
 * 
 * User pastes app URL → Backenly inspects → Reconstructs intent → Takes over backend
 * 
 * NO code import, NO technical details exposed
 */
export async function POST(request: NextRequest) {
  try {
    // Delegated to canonical Bearer-then-cookie auth so that a stale
    // localStorage token never blocks a caller whose session cookie is valid.
    const auth = await authenticateRequest(request)
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json(
        { error: 'Something didn\'t work. Please sign in and try again.' },
        { status: 401 }
      )
    }
    const decoded = { userId: auth.userId }

    const { url, projectId } = await request.json()

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { error: 'Please provide a valid app URL.' },
        { status: 400 }
      )
    }

    // Validate URL format
    let parsedUrl
    try {
      parsedUrl = new URL(url)
    } catch (err) {
      return NextResponse.json(
        { error: 'That doesn\'t look like a valid URL. Please check and try again.' },
        { status: 400 }
      )
    }

    // Verify project ownership if projectId provided
    if (projectId) {
      if (!(await canWriteProject(decoded.userId, projectId))) {
        return NextResponse.json(
          { error: 'Something didn\'t work. Please try again.' },
          { status: 404 }
        )
      }
    }

    // Step 1: Inspect app behavior
    const { AppInspector } = await import('@/lib/services/app-inspector')
    const inspection = await AppInspector.inspect(url)

    if (!inspection.success) {
      return NextResponse.json(
        { error: inspection.error || 'Couldn\'t connect to that app. Please check the URL and try again.' },
        { status: 400 }
      )
    }

    // Step 2: Reconstruct backend intent (AI-powered)
    const { IntentReconstructor } = await import('@/lib/services/intent-reconstructor')
    const reconstruction = await IntentReconstructor.reconstruct(inspection.data, decoded.userId)

    if (!reconstruction.success) {
      return NextResponse.json(
        { error: 'Couldn\'t understand what this app does. Please try a different app.' },
        { status: 400 }
      )
    }

    // Step 3: Generate delegation token
    const delegationToken = `del_${crypto.randomBytes(32).toString('hex')}`
    const tokenHash = crypto.createHash('sha256').update(delegationToken).digest('hex')

    // Step 4: Create connection record
    const provider = detectProvider(parsedUrl.hostname)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days

    const connection = await prisma.delegatedConnection.create({
      data: {
        projectId: projectId || reconstruction.projectId,
        provider,
        tokenHash,
        permissions: {
          readSchema: true,
          readEndpoints: true,
          callApis: true,
          authenticateSessions: true,
        },
        metadata: {
          appUrl: url,
          detectedProvider: provider,
          appName: inspection.data.appName,
          detectedTechnologies: inspection.data.technologies,
          reconstructedAt: new Date().toISOString(),
        },
        expiresAt,
        ipAddress: request.headers.get('x-forwarded-for') || 'unknown',
        userAgent: request.headers.get('user-agent') || 'unknown',
      },
    })

    // Return human summary (NO technical details)
    return NextResponse.json({
      success: true,
      connectionId: connection.id,
      summary: reconstruction.humanSummary,
      projectId: projectId || reconstruction.projectId,
      delegationToken, // Frontend will use this to configure the app
    })

  } catch (error) {
    console.error('[URL Connection] Failed:', error)
    return NextResponse.json(
      { error: 'Something didn\'t work. Nothing was changed.' },
      { status: 500 }
    )
  }
}

/**
 * Detect provider from hostname
 */
function detectProvider(hostname: string): string {
  if (hostname.includes('lovable.dev') || hostname.includes('lovable.app')) {
    return 'lovable'
  }
  if (hostname.includes('bolt.new') || hostname.includes('stackblitz.com')) {
    return 'bolt'
  }
  if (hostname.includes('replit.com') || hostname.includes('repl.co')) {
    return 'replit'
  }
  if (hostname.includes('vercel.app') || hostname.includes('vercel.com')) {
    return 'vercel'
  }
  if (hostname.includes('netlify.app') || hostname.includes('netlify.com')) {
    return 'netlify'
  }
  return 'web'
}
