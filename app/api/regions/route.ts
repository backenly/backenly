/**
 * The Backenly Cloud regions as this deployment serves them: each region's
 * place and whether customers may create projects there now.
 *
 * The console's region picker reads it, so a region opened on the running
 * deployment (BACKENLY_OPEN_REGIONS, lib/regions.ts) can be chosen without a
 * new build. Public: where Cloud runs is not a secret, and nothing here is per
 * account. A named user's preview regions and a staging deployment's
 * qualification regions are not listed as open; they are reached through the
 * API. Self-hosted deployments have no regions, so the route does not exist
 * there.
 */

import { NextResponse } from 'next/server'
import { isCloudEdition } from '@/lib/edition/cloud-only'
import { HOME_REGION, regionsAsServed } from '@/lib/regions'

export const dynamic = 'force-dynamic'

export function GET() {
  if (!isCloudEdition()) {
    return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
  }
  return NextResponse.json(
    {
      home: HOME_REGION,
      regions: regionsAsServed().map(({ id, city, country, countryCode, area, open }) => ({
        id,
        city,
        country,
        countryCode,
        area,
        open,
      })),
    },
    { headers: { 'Cache-Control': 'public, max-age=30' } },
  )
}
