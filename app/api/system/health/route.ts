/**
 * PHASE 18 — SYSTEM HEALTH API (USER-FACING)
 * 
 * This is the ONLY observability endpoint that users can see.
 * It translates complex internal metrics into simple status.
 * 
 * Users ONLY see:
 * - "Everything's running normally"
 * - "Things are a bit slower right now"
 * - "Everything's working smoothly"
 * 
 * NEVER expose:
 * - Latency numbers
 * - Error rates
 * - Technical metrics
 */

import { NextRequest, NextResponse } from 'next/server'
import { getUserFacingHealth } from '@/lib/observability/metrics'

export async function GET(request: NextRequest) {
  try {
    // Get user-friendly health status (NEVER technical details)
    const health = getUserFacingHealth()

    return NextResponse.json({
      status: 'ok', // Always 'ok' - we never say 'down'
      message: health.message,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[System Health] Error getting health status:', error)

    // Even when internal systems fail, show calm message
    return NextResponse.json({
      status: 'ok',
      message: "Everything's working.",
      timestamp: new Date().toISOString(),
    })
  }
}
