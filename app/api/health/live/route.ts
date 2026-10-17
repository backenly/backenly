/**
 * Liveness: this process is up and answering. Nothing else is asked, so a load
 * balancer that replaces tasks on it replaces only a task that is itself
 * broken. A regional stack's target group checks this path; readiness, with
 * the region's database and its dependency on the home region, is
 * /api/health (lib/health/readiness.ts).
 */

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(
    { live: true, timestamp: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } },
  )
}
