/**
 * Legacy connect handshake endpoint.
 *
 * The previous implementation returned placeholder OAuth/token-exchange URLs
 * and synthetic connection tokens. Production connection flows must use real
 * provider OAuth/callback routes, so this endpoint is intentionally retired.
 */

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json(
    {
      error: 'Legacy connect handshake is retired. Use the production provider OAuth callback flow.',
    },
    { status: 410 }
  )
}
