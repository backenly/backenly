export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { platformEmailConfigured } from '@/lib/email/platform-delivery'

/**
 * GET /api/auth/platform-providers
 * Returns which platform-level OAuth providers are configured via env vars,
 * and whether this deployment can send account email at all.
 * Used by login/signup/reset pages to hide buttons for unconfigured providers
 * and to say up front when an emailed code cannot be sent.
 * NEVER returns secrets. `googleClientId` is the public half of the Google
 * OAuth client (it already appears in every sign-in redirect's address); the
 * pages hand it to Google One Tap. The client secret never leaves the server.
 */
export async function GET() {
  const google = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET
  return NextResponse.json({
    google,
    googleClientId: google ? process.env.GOOGLE_CLIENT_ID : null,
    github: !!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET,
    emailDelivery: platformEmailConfigured(),
  })
}
