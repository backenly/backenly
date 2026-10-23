import type { Metadata } from 'next'

/**
 * Page metadata for the marketing site, built in one place.
 *
 * Next merges metadata shallowly: a page that sets `openGraph` replaces the
 * layout's whole `openGraph`, image included. Every subpage set its own, so
 * every link shared from one previewed without a card, and only the home page
 * had an image. A page also inherited the layout's canonical when it set none,
 * which pointed sign-in screens and shared reports at the home page. Building
 * each page's metadata here gives every page the same complete set: its own
 * canonical, the share card, and Open Graph and X tags that agree with the
 * <title>.
 */

/** The marketing site's one public origin: canonical URLs, the sitemap and structured data. */
export const SITE_URL = 'https://backenly.com'

export const SITE_NAME = 'Backenly'

export const X_HANDLE = '@Backenly'

/** The share card (public/og.png, 1200×630). Bump `v` when the image changes, so previews refetch it. */
export const OG_IMAGE = {
  url: '/og.png?v=agent-era',
  width: 1200,
  height: 630,
  alt: 'Backenly: your coding agent builds it; Backenly keeps it running.',
} as const

/** `/pricing` → `https://backenly.com/pricing`. The home page is the bare origin, as in the sitemap. */
export function absoluteUrl(path: string): string {
  return path === '/' ? SITE_URL : `${SITE_URL}${path}`
}

export type PageSeo = {
  /**
   * The page's title. The root layout's template appends " | Backenly", so
   * leave the brand out, unless `brandInTitle` says the title already leads
   * with it ("Backenly vs Supabase: …"), in which case it is used as is.
   */
  title: string
  /** 120-160 characters: Google cuts a longer snippet off mid-sentence. */
  description: string
  /** The page's path, e.g. `/pricing`. Becomes the canonical and og:url. */
  path: string
  brandInTitle?: boolean
  /** Shorter copy for link previews, where the description is shown under the card. */
  social?: { title?: string; description?: string }
  type?: 'website' | 'article'
  /** ISO date of the last real edit, for `article` pages. */
  modifiedTime?: string
}

export function pageMetadata(page: PageSeo): Metadata {
  const url = absoluteUrl(page.path)
  const fullTitle = page.brandInTitle ? page.title : `${page.title} | ${SITE_NAME}`
  const socialTitle = page.social?.title ?? fullTitle
  const socialDescription = page.social?.description ?? page.description

  const shared = {
    url,
    siteName: SITE_NAME,
    locale: 'en_US',
    title: socialTitle,
    description: socialDescription,
    images: [OG_IMAGE],
  }

  return {
    title: page.brandInTitle ? { absolute: page.title } : page.title,
    description: page.description,
    alternates: { canonical: url },
    openGraph:
      page.type === 'article'
        ? { ...shared, type: 'article', ...(page.modifiedTime ? { modifiedTime: page.modifiedTime } : {}) }
        : { ...shared, type: 'website' },
    twitter: {
      card: 'summary_large_image',
      site: X_HANDLE,
      creator: X_HANDLE,
      title: socialTitle,
      description: socialDescription,
      images: [OG_IMAGE.url],
    },
  }
}
