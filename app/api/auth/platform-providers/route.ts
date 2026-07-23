export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'

/**
 * GET /api/auth/platform-providers
 * Returns which platform-level OAuth providers are configured via env vars.
 * Used by login/signup pages to hide buttons for unconfigured providers.
 * NEVER returns secrets — only boolean flags.
 */
export async function GET() {
  return NextResponse.json({
    google: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
    github: !!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET,
  })
}
