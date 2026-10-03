import { MetadataRoute } from 'next'
import { COMPARISON_SLUGS } from './comparisons/data'

const APP_URL = 'https://backenly.com'

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()

  // ── Core marketing pages ───────────────────────────────────────────────────
  const core: MetadataRoute.Sitemap = [
    { url: APP_URL,                          lastModified: now, changeFrequency: 'weekly',  priority: 1.0 },
    { url: `${APP_URL}/pricing`,             lastModified: now, changeFrequency: 'monthly', priority: 0.9 },
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
  const useCaseSlugs = [
    'ai-assisted-developers',
    'founders',
    'migrate-from-supabase',
    'ai-product-backends',
    'multi-tenant-saas',
  ]

  const useCases: MetadataRoute.Sitemap = [
    { url: `${APP_URL}/use-cases`,           lastModified: now, changeFrequency: 'monthly', priority: 0.85 },
    ...useCaseSlugs.map((slug) => ({
      url: `${APP_URL}/use-cases/${slug}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.75,
    })),
  ]

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

  // ── Resources ─────────────────────────────────────────────────────────────
  const resourceSlugs = [
    'connect-your-coding-agent',
    'your-first-backend',
    'the-data-api',
    'how-backenly-works',
    'access-control-and-rls',
    'after-you-launch',
    'self-hosting',
  ]

  const resources: MetadataRoute.Sitemap = [
    { url: `${APP_URL}/resources`,           lastModified: now, changeFrequency: 'weekly',  priority: 0.82 },
    ...resourceSlugs.map((slug) => ({
      url: `${APP_URL}/resources/${slug}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.72,
    })),
  ]

  return [...core, ...features, ...useCases, ...comparisons, ...resources]
}
