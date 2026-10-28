/**
 * What counts as a marketing page.
 *
 * Two things act on this answer: middleware sends these paths to /app on a
 * self-hosted install, and Backenly Cloud records link and button clicks on
 * them and nowhere else. The second is why the "never" list below is long: a
 * path that wrongly passes here has its clicks recorded, and in the dashboard
 * a button's words can be a customer's table or project name.
 */
import { isMarketingPath } from '@/lib/marketing-surfaces'

describe('isMarketingPath', () => {
  it.each([
    '/',
    '/pricing',
    '/contact',
    '/privacy',
    '/terms',
    '/refund-policy',
    '/docs',
    '/docs/connect',
    '/features/self-healing',
    '/comparisons/supabase',
    '/alternatives',
    '/guides/safe-ai-database-changes',
    '/agents/claude-code',
    '/startups',
  ])('treats %s as marketing', (path) => {
    expect(isMarketingPath(path)).toBe(true)
  })

  it.each([
    // The dashboard, and the back office
    '/app',
    '/app/projects/abc/database',
    '/app/settings',
    '/admin',
    // How you reach the product
    '/login',
    '/signup',
    '/auth/login',
    '/auth/verify-email',
    // Product pages under a marketing prefix
    '/mcp/authorize',
    '/docs/llms.txt',
    // A shared change report: the token in the URL is the access
    '/report/abc123',
    // A prefix only counts at a path boundary
    '/pricing-old',
    '/docsx',
    '/startupsx',
  ])('does not treat %s as marketing', (path) => {
    expect(isMarketingPath(path)).toBe(false)
  })
})
