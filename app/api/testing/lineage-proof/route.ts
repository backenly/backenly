/**
 * API Endpoint: Intent Lineage Proof
 * 
 * POST /api/testing/lineage-proof
 * 
 * Generates cryptographic proof that state is derived from intent
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { createOrchestrationContext } from '@/lib/context/execution-context'
import { generateLineageProof, verifyIntentChain } from '@/lib/testing/intent-lineage-hash'

export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const body = await request.json()
    const { projectId } = body
    
    if (!projectId) {
      return NextResponse.json(
        { error: 'projectId is required' },
        { status: 400 }
      )
    }
    
    const context = await createOrchestrationContext(projectId, user.userId)
    
    // Verify intent chain
    const chainVerification = await verifyIntentChain(context)
    
    // Generate cryptographic proof
    const proof = await generateLineageProof(context)
    
    return NextResponse.json({
      success: true,
      chainValid: chainVerification.valid,
      chainMessage: chainVerification.message,
      proof,
    })
    
  } catch (error: any) {
    console.error('[Lineage Proof] Error:', error)
    
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to generate lineage proof',
        message: error.message,
      },
      { status: 500 }
    )
  }
})
