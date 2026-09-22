export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { platformEmailConfigured } from '@/lib/email/platform-delivery'

/**
 * GET /api/auth/platform-providers
 * Returns which platform-level OAuth providers are configured via env vars,
 * and whether this deployment can send account email at all.
 * Used by login/signup/reset pages to hide buttons for unconfigured providers
 * and to say up front when an emailed code cannot be sent.
 * NEVER returns secrets — only boolean flags.
 */
export async function GET() {
  return NextResponse.json({
    google: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
    github: !!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET,
    emailDelivery: platformEmailConfigured(),
  })
}
