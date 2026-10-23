/**
 * What a search engine sees of backenly.com: the crawl rules, the sitemap, each
 * page's metadata, and how the middleware answers hosts and paths.
 *
 * Every assertion here is a defect that shipped:
 *
 * - robots.txt disallowed /_next/, so Google rendered every page without its
 *   scripts, styles, fonts and images, and disallowed /auth/, so it could never
 *   read the sign-in pages' noindex.
 * - The sitemap stamped the build time on every URL as its last change.
 * - The root layout's canonical (the home page) was inherited by any page that
 *   set none, and a page that set its own Open Graph block lost the share
 *   image, so only the home page previewed with a card.
 * - Titles named the brand twice ("Auth & Users: Backenly docs | Backenly").
 * - www.backenly.com served a second copy of the site, and a mistyped URL was
 *   answered with a sign-in redirect instead of a 404.
 *
 * Lengths are deliberately not asserted here. About 60 characters of title and
 * 150-160 of description is what a result usually shows, which makes it a
 * guideline for whoever writes the copy, not a rule a build should enforce:
 * scripts/verify-content-integrity.ts warns about it instead.
 */

import '@/tests/helpers/real-web-standard'
import { readFileSync } from 'fs'
import { join } from 'path'

// `jose` ships ESM-only and jest cannot parse it. No request below carries a
// token, so the JWT branch never runs.
jest.mock('jose', () => ({ jwtVerify: jest.fn(async () => ({ payload: {} })) }))

import type { Metadata } from 'next'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'
import robots from '@/app/robots'
import sitemap from '@/app/sitemap'
import { COMPARISON_SLUGS } from '@/app/comparisons/data'
import { DOC_SLUGS, DOCS_UPDATED } from '@/app/docs/content'
import { FEATURE_SLUGS } from '@/app/features/data'
import { OG_IMAGE, SITE_URL } from '@/lib/seo/metadata'
import { LOGO_URL, graph, organizationNode, softwareNode, websiteNode } from '@/lib/seo/schema'

// ── Metadata, page by page ────────────────────────────────────────────────────

type Meta = Metadata & Record<string, any>

const params = (slug: string) => ({ params: Promise.resolve({ slug }) })

/** The metadata each route in this repository renders. */
async function metadataFor(path: string): Promise<Meta> {
  const [, section, slug] = path.split('/')
  if (path === '/') return require('@/app/page').metadata
  if (slug && section === 'features') return require('@/app/features/[slug]/page').generateMetadata(params(slug))
  if (slug && section === 'comparisons') return require('@/app/comparisons/[slug]/page').generateMetadata(params(slug))
  if (slug && section === 'docs') return require('@/app/docs/[slug]/page').generateMetadata(params(slug))
  const fromLayout = ['pricing', 'privacy', 'terms', 'refund-policy']
  return require(`@/app/${section}/${fromLayout.includes(section) ? 'layout' : 'page'}`).metadata
}

/** The <title> as rendered: the layout template appends " | Backenly" unless the title is absolute. */
function renderedTitle(meta: Meta): string {
  return typeof meta.title === 'string' ? `${meta.title} | Backenly` : meta.title.absolute
}

const sitemapUrls = sitemap().map((entry) => entry.url)

/** Every sitemap page this repository serves. /startups is the Cloud overlay's, and is checked there. */
const pages = sitemapUrls
  .map((url) => [url.replace(SITE_URL, '') || '/', url] as const)
  .filter(([path]) => path !== '/startups')

describe.each(pages)('%s', (path, url) => {
  let meta: Meta

  beforeAll(async () => {
    meta = await metadataFor(path)
  })

  it('is its own canonical, and its share URL agrees', () => {
    expect(meta.alternates?.canonical).toBe(url)
    expect(meta.openGraph?.url).toBe(url)
  })

  it('carries a share image for link previews', () => {
    expect(meta.openGraph?.images).toEqual([OG_IMAGE])
    expect(meta.twitter?.images).toEqual([OG_IMAGE.url])
    expect(meta.twitter?.card).toBe('summary_large_image')
  })

  it('has a title that names the brand once', () => {
    expect(renderedTitle(meta).match(/Backenly/g)).toHaveLength(1)
  })

  it('has a description of its own', () => {
    expect((meta.description as string).trim().length).toBeGreaterThan(0)
  })
})

describe('titles and descriptions across the site', () => {
  it('are each used by one page only', async () => {
    const metas = await Promise.all(pages.map(([path]) => metadataFor(path)))
    const titles = metas.map(renderedTitle)
    const descriptions = metas.map((m) => m.description)
    expect(new Set(titles).size).toBe(titles.length)
    expect(new Set(descriptions).size).toBe(descriptions.length)
  })
})

// ── Pages that must stay out of results ───────────────────────────────────────

describe('pages that are not for search results', () => {
  it.each([
    ['a shared change report', 'app/report/[token]/page.tsx'],
    ['the agent consent screen', 'app/mcp/authorize/page.tsx'],
    ['the sign-in screens', 'app/auth/layout.tsx'],
  ])('%s is noindex', (_label, file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    expect(source).toMatch(/robots:\s*\{\s*index:\s*false/)
  })
})

// ── robots.txt ────────────────────────────────────────────────────────────────

describe('robots.txt', () => {
  const rules = robots().rules as { userAgent: string; allow: string; disallow: string[] }[]
  const disallowed = rules.flatMap((r) => r.disallow)

  it('lets crawlers fetch what a page needs to render', () => {
    expect(disallowed).not.toContain('/_next/')
  })

  it('does not hide pages whose noindex a crawler must read', () => {
    expect(disallowed).not.toContain('/auth/')
    expect(disallowed).not.toContain('/report/')
  })

  it('keeps the console and the API out', () => {
    expect(disallowed).toEqual(expect.arrayContaining(['/app/', '/api/', '/admin/']))
  })

  it('points at the sitemap', () => {
    expect(robots().sitemap).toBe(`${SITE_URL}/sitemap.xml`)
  })
})

// ── sitemap.xml ───────────────────────────────────────────────────────────────

describe('sitemap.xml', () => {
  const entries = sitemap()

  it('lists every feature, comparison and docs page', () => {
    for (const slug of FEATURE_SLUGS) expect(sitemapUrls).toContain(`${SITE_URL}/features/${slug}`)
    for (const slug of COMPARISON_SLUGS) expect(sitemapUrls).toContain(`${SITE_URL}/comparisons/${slug}`)
    for (const slug of DOC_SLUGS) expect(sitemapUrls).toContain(`${SITE_URL}/docs/${slug}`)
  })

  it('dates a page only from a date its content records, never the build', () => {
    const before = entries.map((e) => String(e.lastModified))
    // A clock-derived lastmod would differ between two builds a moment apart.
    jest.useFakeTimers().setSystemTime(new Date('2031-01-01T00:00:00Z'))
    try {
      expect(sitemap().map((e) => String(e.lastModified))).toEqual(before)
    } finally {
      jest.useRealTimers()
    }
    for (const e of entries.filter((x) => x.url.startsWith(`${SITE_URL}/docs/`))) {
      expect(e.lastModified).toBe(DOCS_UPDATED.iso)
    }
  })

  it('carries no fields search engines ignore', () => {
    for (const e of entries) {
      expect(e).not.toHaveProperty('priority')
      expect(e).not.toHaveProperty('changeFrequency')
    }
  })
})

// ── Structured data ───────────────────────────────────────────────────────────

describe('structured data', () => {
  it('names the organization with a raster logo and its own profiles', () => {
    expect(organizationNode.logo.url).toBe(LOGO_URL)
    expect(LOGO_URL).toMatch(/\.png$/)
    expect(organizationNode.sameAs).toContain('https://github.com/backenly')
    expect(organizationNode.sameAs.every((u) => u.startsWith('https://'))).toBe(true)
  })

  it('declares no site search, which backenly.com does not have', () => {
    expect(websiteNode).not.toHaveProperty('potentialAction')
  })

  it('ties the site and the product to the one organization', () => {
    expect(websiteNode.publisher).toEqual({ '@id': organizationNode['@id'] })
    expect(softwareNode.publisher).toEqual({ '@id': organizationNode['@id'] })
  })

  it('serializes as one graph', () => {
    const json = JSON.parse(JSON.stringify(graph(organizationNode, websiteNode)))
    expect(json['@context']).toBe('https://schema.org')
    expect(json['@graph'].map((n: { '@type': string }) => n['@type'])).toEqual(['Organization', 'WebSite'])
  })
})

// ── The middleware: hosts and unknown paths ───────────────────────────────────

describe('the middleware', () => {
  const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL

  beforeAll(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://backenly.com'
  })
  afterAll(() => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
  })

  function request(url: string, init: { method?: string } = {}) {
    const { host } = new URL(url)
    return middleware(new NextRequest(url, { method: init.method ?? 'GET', headers: { host } }))
  }

  it('sends www to the canonical host permanently, path and query intact', async () => {
    const res = await request('https://www.backenly.com/pricing?ref=x')
    expect(res?.status).toBe(301)
    expect(res?.headers.get('location')).toBe('https://backenly.com/pricing?ref=x')
  })

  it('leaves API calls on www where they were sent', async () => {
    const res = await request('https://www.backenly.com/api/health')
    expect(res?.status).not.toBe(301)
  })

  it('does not turn a write into a redirect', async () => {
    const res = await request('https://www.backenly.com/contact', { method: 'POST' })
    expect(res?.status).not.toBe(301)
  })

  it('does not redirect the canonical host', async () => {
    // A sign-in page: public on every edition, so nothing else redirects it.
    const res = await request('https://backenly.com/auth/login')
    expect(res?.headers.get('location')).toBeNull()
  })

  it('answers an unknown path with the 404 page, not a sign-in redirect', async () => {
    const res = await request('https://backenly.com/blog/some-retired-post')
    expect(res?.headers.get('location')).toBeNull()
    expect(res?.headers.get('x-middleware-rewrite')).toContain('/_not-a-page')
  })

  it('still sends an anonymous visitor to sign in for the console', async () => {
    for (const path of ['/app', '/app/projects/123', '/admin']) {
      const res = await request(`https://backenly.com${path}`)
      const location = new URL(res!.headers.get('location')!)
      expect(location.pathname).toBe('/auth/login')
      expect(location.searchParams.get('redirect')).toBe(path)
    }
  })
})
