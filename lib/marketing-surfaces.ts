/**
 * Backenly's marketing surfaces: the pages that are the hosted service's shop
 * window (the landing page, pricing, docs, guides, comparisons and the legal
 * pages), as distinct from the dashboard, sign-in, and pages a token opens.
 *
 * Two things read this one definition, so they cannot disagree about what a
 * marketing page is:
 *
 *   - middleware.ts sends these paths to /app on a self-hosted install, for
 *     the reasons below.
 *   - Backenly Cloud's analytics records link and button clicks on these pages
 *     and nowhere else. No dashboard page is on these lists, so a page added to
 *     the dashboard is outside click analytics by construction, not because
 *     someone remembered to exclude it.
 *
 * Pure and dependency-free: middleware runs on the Edge runtime and the
 * analytics component runs in the browser.
 */

// A self-hosted deployment is somebody's own infrastructure. Serving Backenly's
// landing page, pricing and competitor comparisons there is wrong twice over:
// the operator has already installed the product so there is nothing to sell
// them, and their internal host ends up publishing our marketing to whoever can
// reach it. Supabase self-hosted puts the dashboard at `/` and ships no
// marketing at all; this matches that.
//
// These redirect to /app rather than 404 so that an indexed or bookmarked link
// lands the operator in the product instead of on an error page. `/login`,
// `/signup` and `/auth/*` are NOT here — they are how you reach the product.
export const marketingRoutes = [
  '/',
  '/pricing',
  '/contact',
  '/privacy',
  '/terms',
  '/refund-policy',
]
export const marketingPrefixes = [
  '/alternatives',
  '/comparisons',
  '/features',
  '/use-cases',
  '/docs',
  '/resources',
  '/mcp',
  '/quickstart',
  '/startups',
  '/guides',
  '/agents',
]

// Served under a marketing prefix but not marketing. The published CLI and
// older MCP setup prompts fetch /docs/llms.txt (rewritten to /llms.txt in
// next.config.js), and an agent on a self-hosted install needs that answered
// rather than bounced to /app. Middleware runs before rewrites, so the
// exemption has to be by path here.
//
// /mcp/authorize is the OAuth CONSENT PAGE — the only place an authorization
// code is minted. A self-hosted install serves the 401 challenge and the
// OAuth metadata, the agent's host opens the browser at the consent URL, and
// this redirect used to bounce it to /app: the dashboard opened, no code was
// ever issued, and the host waited on a callback that never came.
export const marketingExemptions = ['/docs/llms.txt', '/mcp/authorize']

export function isMarketingPath(pathname: string): boolean {
  if (marketingExemptions.includes(pathname)) return false
  if (marketingRoutes.includes(pathname)) return true
  return marketingPrefixes.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'))
}
