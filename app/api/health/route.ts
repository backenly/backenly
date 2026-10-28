/**
 * Readiness: whether this process can serve its region's requests now.
 *
 * In the home region it is the platform database and schema check, as it has
 * always been, and the home load balancer acts on it. A task serving another
 * region answers for the region's own database and reports the home region as
 * a dependency (lib/health/readiness.ts); its load balancer checks liveness
 * (/api/health/live) instead, so losing Mumbai never makes it replace tasks.
 *
 * Returns 200 when ready, 503 when not.
 */

import { NextResponse } from 'next/server'
import { readiness } from '@/lib/health/readiness'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const health = await readiness()

    return NextResponse.json(health, {
      status: health.healthy ? 200 : 503,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        healthy: false,
        checks: {},
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      }
    )
  }
}
