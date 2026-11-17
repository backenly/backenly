/**
 * The addresses this project's direct Postgres logins may connect from.
 *
 *   GET    /api/projects/[id]/database-access/allowed-addresses
 *          { enforced, addresses: [{ cidr, createdAt, admitted }], limit, planCode, planName, you }
 *   POST   /api/projects/[id]/database-access/allowed-addresses
 *          { address: "203.0.113.7" | "203.0.113.0/24" } or { mine: true }
 *   DELETE /api/projects/[id]/database-access/allowed-addresses?address=203.0.113.7/32
 *
 * `you` is the caller's own address as the load balancer saw it, and whether
 * it can be allowed: what "Allow my address" allows, read from the request
 * (lib/security/client-ip.ts), never from the body. `mine: true` allows it.
 *
 * Each add or remove is a governed change in the project's History, and the
 * region's network allowlist follows it (lib/services/direct-access-addresses.ts).
 * A refusal names why in `code`, with the sentence in `error`.
 *
 * ADMIN on every verb, as for the logins themselves (../route.ts): who may
 * connect is part of granting the credential, and the list holds the team's
 * own addresses.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { clientIpFromHeaders } from '@/lib/security/client-ip'
import {
  AllowedAddressError,
  allowAddress,
  allowlistState,
  describeCallerAddress,
  removeAddress,
} from '@/lib/services/direct-access-addresses'

function refused(err: AllowedAddressError) {
  return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
}

export async function GET(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const state = await allowlistState(validated.projectId)
    return NextResponse.json({ ...state, you: describeCallerAddress(clientIpFromHeaders(request)) })
  }, { floor: 'administer' })
}

export async function POST(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const body = await request.json().catch(() => ({}))
    let address: unknown = body?.address
    if (body?.mine === true) {
      const you = describeCallerAddress(clientIpFromHeaders(request))
      if (!you) {
        return NextResponse.json(
          { error: "Backenly can't tell which address this request came from. Type the address you connect from instead.", code: 'ADDRESS_UNKNOWN' },
          { status: 400 },
        )
      }
      if (!you.allowable) return NextResponse.json({ error: you.reason, code: 'ADDRESS_NOT_ALLOWABLE' }, { status: 400 })
      address = you.address
    }
    try {
      const result = await allowAddress(validated.projectId, address, { userId: validated.userId })
      return NextResponse.json(
        { address: result.address, added: result.added, applied: result.sync.status !== 'failed' },
        { status: result.added ? 201 : 200 },
      )
    } catch (err) {
      if (err instanceof AllowedAddressError) return refused(err)
      console.error('[allowed-addresses] allow failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Could not allow the address. Try again.' }, { status: 500 })
    }
  }, { floor: 'administer' })
}

export async function DELETE(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const address = new URL(request.url).searchParams.get('address')
    if (!address) return NextResponse.json({ error: 'Say which address to remove: ?address=203.0.113.7/32', code: 'INVALID_ADDRESS' }, { status: 400 })
    try {
      const result = await removeAddress(validated.projectId, address, { userId: validated.userId })
      return NextResponse.json({ removed: result.cidr, applied: result.sync.status !== 'failed' })
    } catch (err) {
      if (err instanceof AllowedAddressError) return refused(err)
      console.error('[allowed-addresses] remove failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Could not remove the address. Try again.' }, { status: 500 })
    }
  }, { floor: 'administer' })
}
