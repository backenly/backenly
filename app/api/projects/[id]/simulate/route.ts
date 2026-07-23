// app/api/projects/[id]/simulate/route.ts
/**
 * GET  /api/projects/[id]/simulate  — returns preset scenarios
 * POST /api/projects/[id]/simulate  — run a simulation
 *
 * Body (POST): { scenario?: string }
 * Response (POST): SimulationResult
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { simulateScenario, getPresetScenarios } from '@/lib/ai/arch-simulator'

// ── GET — return preset scenarios ─────────────────────────────────────────────

export async function GET(request: NextRequest) {
  return withProjectValidation<any>(request, async (_validated) => {
    try {
      const presets = getPresetScenarios()
      return NextResponse.json({ success: true, data: presets })
    } catch (err: any) {
      console.error('[simulate:GET] Unexpected error:', err?.message)
      return NextResponse.json(
        { success: false, error: 'Failed to load preset scenarios' },
        { status: 500 },
      )
    }
  })
}

// ── POST — run simulation ─────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  return withProjectValidation<any>(request, async ({ projectId }) => {
    try {
      let scenarioInput = '10x traffic spike'

      try {
        const body = await request.json()
        if (body?.scenario && typeof body.scenario === 'string') {
          scenarioInput = body.scenario.trim() || scenarioInput
        }
      } catch {
        // Body is optional — fall back to default scenario
      }

      const result = await simulateScenario(projectId, scenarioInput)

      return NextResponse.json({ success: true, data: result })
    } catch (err: any) {
      console.error('[simulate:POST] Unexpected error:', err?.message)
      return NextResponse.json(
        { success: false, error: 'Simulation failed. Please try again.' },
        { status: 500 },
      )
    }
  })
}
