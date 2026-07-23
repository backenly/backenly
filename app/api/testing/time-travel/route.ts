/**
 * API Endpoint: Time-Travel Viewer
 * 
 * POST /api/testing/time-travel
 * 
 * Interactive time-travel queries to trace artifacts to intent
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { createOrchestrationContext } from '@/lib/context/execution-context'
import {
  explainArtifact,
  generateIntentTimeline,
  generateTimeTravelDiff,
  getStateAtIntent,
  timeTravelQuery,
} from '@/lib/testing/time-travel-diff-viewer'

export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const body = await request.json()
    const { projectId, action, params } = body
    
    if (!projectId) {
      return NextResponse.json(
        { error: 'projectId is required' },
        { status: 400 }
      )
    }
    
    if (!action) {
      return NextResponse.json(
        { error: 'action is required (explain, timeline, diff, state, query)' },
        { status: 400 }
      )
    }
    
    const context = await createOrchestrationContext(projectId, user.userId)
    
    switch (action) {
      case 'explain': {
        // Explain artifact origin
        const { artifactType, artifactName } = params
        if (!artifactType || !artifactName) {
          return NextResponse.json(
            { error: 'artifactType and artifactName required' },
            { status: 400 }
          )
        }
        
        const explanation = await explainArtifact(context, artifactType, artifactName)
        
        return NextResponse.json({
          success: true,
          explanation,
        })
      }
      
      case 'timeline': {
        // Generate full intent timeline
        const timeline = await generateIntentTimeline(context)
        
        return NextResponse.json({
          success: true,
          timeline,
        })
      }
      
      case 'diff': {
        // Generate diff between two intent states
        const { fromIntent, toIntent } = params
        if (fromIntent === undefined || toIntent === undefined) {
          return NextResponse.json(
            { error: 'fromIntent and toIntent required' },
            { status: 400 }
          )
        }
        
        const diff = await generateTimeTravelDiff(context, fromIntent, toIntent)
        
        return NextResponse.json({
          success: true,
          diff,
        })
      }
      
      case 'state': {
        // Get state at specific intent
        const { intentNumber } = params
        if (intentNumber === undefined) {
          return NextResponse.json(
            { error: 'intentNumber required' },
            { status: 400 }
          )
        }
        
        const state = await getStateAtIntent(context, intentNumber)
        
        if (!state) {
          return NextResponse.json(
            { error: 'Invalid intent number' },
            { status: 404 }
          )
        }
        
        return NextResponse.json({
          success: true,
          state,
        })
      }
      
      case 'query': {
        // Execute time-travel query
        const result = await timeTravelQuery(context, params)
        
        return NextResponse.json({
          success: true,
          result,
        })
      }
      
      default:
        return NextResponse.json(
          { error: 'Invalid action. Must be: explain, timeline, diff, state, or query' },
          { status: 400 }
        )
    }
    
  } catch (error: any) {
    console.error('[Time Travel] Error:', error)
    
    return NextResponse.json(
      {
        success: false,
        error: 'Time-travel operation failed',
        message: error.message,
      },
      { status: 500 }
    )
  }
})
