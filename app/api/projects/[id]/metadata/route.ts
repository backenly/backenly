export const dynamic = 'force-dynamic'

/**
 * Project Metadata API
 * 
 * This stores the AI-extracted understanding (Step 2) from user's intent
 * 
 * PRODUCT ARCHITECTURE DECISION (Risk 2 Mitigation):
 * =====================================================
 * Metadata Model: BOOTSTRAP ONLY (Model A)
 * 
 * Once tables and APIs are created (tablesCreated=true, apisCreated=true),
 * the metadata becomes READ-ONLY HISTORY.
 * 
 * Future edits operate directly on:
 * - Tables (via executeInWorkspaceSchema)
 * - API Definitions (via prisma.apiDefinition.update)
 * 
 * Metadata is NOT updated after initial creation.
 * 
 * Why this model?
 * - Simpler to maintain
 * - Clear separation: Metadata = Intent Archive, Database = Source of Truth
 * - Aligns with how users think: "I created it, now I manage it"
 * 
 * Trade-off:
 * - Cannot "re-generate from metadata" after edits
 * - This is acceptable for v1.0 and can be revisited later
 * 
 * Alternative (Model B - NOT IMPLEMENTED):
 * - Metadata stays authoritative forever
 * - All edits update metadata first, then regenerate
 * - More complex, requires sync logic
 * =====================================================
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifySession } from '@/lib/auth/session'
import { prisma } from '@/lib/db/postgres'
import { extractMetadataFromIntent, validateMetadata, type ExtractedMetadata } from '@/lib/ai/intent-extractor'
import { canAccessProject, canWriteProject } from '@/lib/edition/guard'

/**
 * GET /api/projects/[projectId]/metadata
 * Retrieve stored metadata for a project
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // DEBUG: Log all cookies received
    const allCookies = request.cookies.getAll()
    console.log('🍪 [Metadata API GET] All cookies received:', allCookies.map(c => `${c.name}=${c.value.substring(0, 20)}...`))
    
    // Get token from cookies (correct cookie name is 'auth-token')
    const token = request.cookies.get('auth-token')?.value
    if (!token) {
      console.error('❌ [Metadata API GET] No auth-token cookie found')
      console.error('   Available cookies:', allCookies.map(c => c.name).join(', '))
      return NextResponse.json(
        { error: 'Unauthorized - No auth token cookie' },
        { status: 401 }
      )
    }

    console.log('🔑 [Metadata API GET] Token found:', token.substring(0, 20) + '...')
    const session = await verifySession(token)
    if (!session.valid || !session.userId) {
      console.error('❌ [Metadata API GET] Invalid session:', { valid: session.valid, userId: session.userId })
      return NextResponse.json(
        { error: 'Unauthorized - Invalid session' },
        { status: 401 }
      )
    }

    console.log('✅ [Metadata API GET] Session valid for user:', session.userId)
    const projectId = params.id

    // Verify project access
    if (!(await canAccessProject(session.userId, projectId))) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Fetch metadata separately
    const metadata = await prisma.projectMetadata.findUnique({
      where: { projectId },
    })

    return NextResponse.json({
      success: true,
      metadata,
    })
  } catch (error: any) {
    console.error('[Metadata API] Error fetching metadata:', error)
    return NextResponse.json(
      { error: 'Failed to fetch metadata', details: error.message },
      { status: 500 }
    )
  }
}

/**
 * POST /api/projects/[projectId]/metadata
 * Extract and store metadata from user's project prompt
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // DEBUG: Log all cookies received
    const allCookies = request.cookies.getAll()
    console.log('🍪 [Metadata API POST] All cookies received:', allCookies.map(c => `${c.name}=${c.value.substring(0, 20)}...`))
    
    // Get token from cookies (correct cookie name is 'auth-token')
    const token = request.cookies.get('auth-token')?.value
    if (!token) {
      console.error('❌ [Metadata API POST] No auth-token cookie found')
      console.error('   Available cookies:', allCookies.map(c => c.name).join(', '))
      return NextResponse.json(
        { error: 'Unauthorized - No auth token cookie' },
        { status: 401 }
      )
    }

    console.log('🔑 [Metadata API POST] Token found:', token.substring(0, 20) + '...')
    const session = await verifySession(token)
    if (!session.valid || !session.userId) {
      console.error('❌ [Metadata API POST] Invalid session:', { valid: session.valid, userId: session.userId })
      return NextResponse.json(
        { error: 'Unauthorized - Invalid session' },
        { status: 401 }
      )
    }

    console.log('✅ [Metadata API POST] Session valid for user:', session.userId)
    const projectId = params.id
    const body = await request.json()
    const { prompt } = body

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json(
        { error: 'Project prompt is required' },
        { status: 400 }
      )
    }

    // Verify project ownership
    if (!(await canWriteProject(session.userId, projectId))) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    console.log('🧠 [Metadata API] Extracting metadata from prompt...')

    // Extract metadata using AI
    const metadata = await extractMetadataFromIntent(prompt)

    // Validate metadata (throws on error)
    try {
      validateMetadata(metadata)
    } catch (validationError: any) {
      return NextResponse.json(
        { error: 'Invalid metadata extracted', details: validationError.message },
        { status: 400 }
      )
    }

    console.log('✅ [Metadata API] Metadata extracted successfully:', {
      entities: metadata.entities.length,
      relationships: metadata.relationships.length,
      behaviors: metadata.behaviors.length,
    })

    // Store metadata in database
    const storedMetadata = await prisma.projectMetadata.upsert({
      where: { projectId },
      create: {
        projectId,
        originalPrompt: prompt,
        entities: metadata.entities as any,
        relationships: metadata.relationships as any,
        behaviors: metadata.behaviors as any,
        security: metadata.security as any,
        tablePlans: metadata.tablePlans as any,
        apiPlans: metadata.apiPlans as any,
        tablesCreated: false,
        apisCreated: false,
      },
      update: {
        originalPrompt: prompt,
        entities: metadata.entities as any,
        relationships: metadata.relationships as any,
        behaviors: metadata.behaviors as any,
        security: metadata.security as any,
        tablePlans: metadata.tablePlans as any,
        apiPlans: metadata.apiPlans as any,
        // Keep existing status
      },
    })

    return NextResponse.json({
      success: true,
      metadata: storedMetadata,
      summary: {
        entities: metadata.entities.length,
        relationships: metadata.relationships.length,
        behaviors: metadata.behaviors.length,
        tablePlans: metadata.tablePlans.length,
        apiPlans: metadata.apiPlans.length,
      },
    })
  } catch (error: any) {
    console.error('[Metadata API] Error processing metadata:', error)
    return NextResponse.json(
      { error: 'Failed to process metadata', details: error.message },
      { status: 500 }
    )
  }
}
