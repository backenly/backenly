import { MetadataRoute } from 'next'
import { COMPARISON_SLUGS } from './comparisons/data'
import { DOC_SLUGS } from './docs/content'

const APP_URL = 'https://backenly.com'

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()

  // ── Core marketing pages ───────────────────────────────────────────────────
  const core: MetadataRoute.Sitemap = [
    { url: APP_URL,                          lastModified: now, changeFrequency: 'weekly',  priority: 1.0 },
    { url: `${APP_URL}/pricing`,             lastModified: now, changeFrequency: 'monthly', priority: 0.9 },
    // Served by the Backenly Cloud overlay, like the site this sitemap describes.
    { url: `${APP_URL}/startups`,            lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${APP_URL}/alternatives`,        lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${APP_URL}/contact`,             lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${APP_URL}/terms`,               lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
    { url: `${APP_URL}/privacy`,             lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
    { url: `${APP_URL}/refund-policy`,       lastModified: now, changeFrequency: 'yearly',  priority: 0.2 },
  ]

  // ── Features ───────────────────────────────────────────────────────────────
  const featureSlugs = [
    'ai-backend-generation',
    'database-setup',
    'authentication',
    'api-generation',
    'deployment-ready-backends',
  ]

  const features: MetadataRoute.Sitemap = [
    { url: `${APP_URL}/features`,            lastModified: now, changeFrequency: 'monthly', priority: 0.88 },
    ...featureSlugs.map((slug) => ({
      url: `${APP_URL}/features/${slug}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.78,
    })),
  ]

  // ── Use Cases ──────────────────────────────────────────────────────────────

  // ── Comparisons ───────────────────────────────────────────────────────────
  //
  // Derived from the comparison data rather than hand-listed. The two used to be
  // separate lists of the same four slugs with nothing tying them together,
  // which is how a live page goes missing from the sitemap, or a retired one
  // stays in it. verify-content-integrity.ts asserts the parity that this
  // derivation makes true by construction.
  const comparisonSlugs = COMPARISON_SLUGS

  const comparisons: MetadataRoute.Sitemap = [
    { url: `${APP_URL}/comparisons`,         lastModified: now, changeFrequency: 'monthly', priority: 0.85 },
    ...comparisonSlugs.map((slug) => ({
      url: `${APP_URL}/comparisons/${slug}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    })),
  ]

  // ── Docs ──────────────────────────────────────────────────────────────────
  //
  // Derived from the docs content, like comparisons above, so a section page
  // can never be live and missing from here, or retired and still listed.
  // /docs itself is not listed: it has no page since 2026-10-15 and redirects
  // to the first section (next.config.js).
  const docs: MetadataRoute.Sitemap = [
    ...DOC_SLUGS.map((slug) => ({
      url: `${APP_URL}/docs/${slug}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.72,
    })),
  ]

  return [...core, ...features, ...comparisons, ...docs]
}
