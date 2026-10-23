import { MetadataRoute } from 'next'
import { COMPARISON_SLUGS } from './comparisons/data'
import { DOC_SLUGS, DOCS_UPDATED } from './docs/content'
import { EFFECTIVE_DATE as PRIVACY_EFFECTIVE_DATE } from './privacy/data'
import { absoluteUrl } from '@/lib/seo/metadata'
import { FEATURE_SLUGS } from './features/data'
import { GUIDE_PATH, GUIDE_UPDATED } from './guides/safe-ai-database-changes/content'

/**
 * Every indexable page, and when its content last changed where that is known.
 *
 * `lastModified` is set only from a date the content itself records. It used
 * to be the build time on every URL, which says every page changed on every
 * deploy; search engines learn to ignore a lastmod that is always "now", and
 * then ignore it for the pages that really did change. `changeFrequency` and
 * `priority` are gone: Google and Bing both ignore them.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const page = (path: string, lastModified?: string | Date) => ({
    url: absoluteUrl(path),
    ...(lastModified ? { lastModified } : {}),
  })

  // ── Core marketing pages ───────────────────────────────────────────────────
  const core: MetadataRoute.Sitemap = [
    page('/'),
    page('/pricing'),
    page('/mcp'),
    // Served by the Backenly Cloud overlay, like the site this sitemap describes.
    page('/startups'),
    page('/alternatives'),
    page('/contact'),
    page('/terms'),
    page('/privacy', new Date(`${PRIVACY_EFFECTIVE_DATE} UTC`)),
    page('/refund-policy'),
  ]

  // ── Features ───────────────────────────────────────────────────────────────
  const features: MetadataRoute.Sitemap = [page('/features'), ...FEATURE_SLUGS.map((slug) => page(`/features/${slug}`))]

  // ── Comparisons ───────────────────────────────────────────────────────────
  //
  // Derived from the comparison data rather than hand-listed. The two used to be
  // separate lists of the same four slugs with nothing tying them together,
  // which is how a live page goes missing from the sitemap, or a retired one
  // stays in it. verify-content-integrity.ts asserts the parity that this
  // derivation makes true by construction.
  const comparisons: MetadataRoute.Sitemap = [
    page('/comparisons'),
    ...COMPARISON_SLUGS.map((slug) => page(`/comparisons/${slug}`)),
  ]

  // ── Docs ──────────────────────────────────────────────────────────────────
  //
  // Derived from the docs content, like comparisons above, so a section page
  // can never be live and missing from here, or retired and still listed.
  // /docs itself is not listed: it has no page since 2026-10-15 and redirects
  // to the first section (next.config.js).
  const docs: MetadataRoute.Sitemap = DOC_SLUGS.map((slug) => page(`/docs/${slug}`, DOCS_UPDATED.iso))

  // ── Guides ────────────────────────────────────────────────────────────────
  const guides: MetadataRoute.Sitemap = [page(GUIDE_PATH, GUIDE_UPDATED)]

  return [...core, ...features, ...comparisons, ...docs, ...guides]
}
