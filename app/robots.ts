import { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/seo/metadata'

/**
 * Crawl rules for backenly.com.
 *
 * Everything public is crawlable; only the signed-in surfaces and the API are
 * not. Two things that used to be here were costing the site:
 *
 * - `/_next/` was disallowed. That is where every script, stylesheet, font and
 *   optimized image is served from, so Google rendered the pages without them.
 * - `/auth/` was disallowed. The sign-in pages are noindex, but a crawler that
 *   may not fetch a page never sees its noindex, and every page links to them.
 *
 * A path that should stay out of results gets `robots: noindex` on the page
 * itself (the auth layout, shared change reports), not a line here.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/app/', '/api/', '/admin/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
