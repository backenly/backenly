import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { CodeBlock } from '@/components/site/CodeBlock'
import { articles } from '../data'
import {
  ALL_ARTICLES,
  ARTICLES_BY_SLUG,
  ARTICLE_AUTHOR,
  LANES,
  READ_MINUTES,
  type ArticleBlock,
  type ArticleLane,
} from '../content'
import { DataTable, GlyphList, JsonLd, NextLinks, Page, Steps, Trail, withCode } from '@/components/site/kit'
import { ScrollSpy } from '@/components/site/ScrollSpy'
import { StartButton } from '@/components/site/StartButton'
import { CONTAINER, DISPLAY, HEADING, PANEL, TITLE } from '@/components/site/tokens'

const APP_URL = 'https://backenly.com'

/** Shelf label for the meta line, resolved from the same LANES the index renders. */
const LANE_TITLES: Record<ArticleLane, string> = Object.fromEntries(
  LANES.map((l) => [l.id, l.title])
) as Record<ArticleLane, string>

export function generateStaticParams() {
  return ALL_ARTICLES.map((a) => ({ slug: a.slug }))
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const params = await props.params
  const a = ARTICLES_BY_SLUG[params.slug]
  if (!a) return { title: 'Not Found' }
  return {
    title: `${a.title}: Backenly docs`,
    description: a.metaDescription,
    openGraph: {
      title: a.title,
      description: a.metaDescription,
      url: `${APP_URL}/resources/${a.slug}`,
      type: 'article',
      publishedTime: a.datePublished,
      modifiedTime: a.dateModified,
      authors: [ARTICLE_AUTHOR.name],
    },
    twitter: { card: 'summary_large_image', title: a.title, description: a.metaDescription },
    alternates: { canonical: `${APP_URL}/resources/${a.slug}` },
  }
}

/**
 * Slugify a heading for its anchor. Kept in this file rather than a util so the
 * in-page nav and the heading ids can never disagree: they call the same
 * function on the same string.
 */
function anchorFor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Long-form reading copy: a step up from marketing body, and a step brighter. */
const READ = 'text-[16px] leading-[1.8] tracking-[-0.006em] text-zinc-300 [text-wrap:pretty]'

function BlockRenderer({ block }: { block: ArticleBlock }) {
  switch (block.kind) {
    case 'p':
      return <p className={READ}>{withCode(block.text)}</p>

    case 'code':
      return <CodeBlock code={block.code} label={block.label} language={block.language} />

    case 'list':
      return (
        <ul className="flex list-disc flex-col gap-2.5 pl-5 marker:text-zinc-600">
          {block.items.map((item) => (
            <li key={item} className={`pl-1.5 ${READ}`}>
              {withCode(item)}
            </li>
          ))}
        </ul>
      )

    case 'note':
      return (
        <aside className="rounded-r-lg border-l-2 border-violet-300/60 bg-white/[0.025] px-5 py-4">
          <p className="text-[15px] leading-[1.75] text-zinc-300 [text-wrap:pretty]">{withCode(block.text)}</p>
        </aside>
      )

    /**
     * A mechanism, not decoration: input, what the platform does, result. An
     * ordered list, so it is a sequence to a screen reader too.
     */
    case 'steps':
      return <Steps steps={block.steps} />

    /**
     * Wide content scrolls inside its own container. The page body must never
     * scroll horizontally, which is the failure mode a bare <table> produces on
     * a 375px screen.
     */
    case 'table':
      return (
        <figure className="flex flex-col gap-3">
          <DataTable
            caption={block.caption ?? block.columns.join(', ')}
            columns={block.columns}
            rows={block.rows.map((row) => row.map((cell) => withCode(cell)))}
          />
          {block.caption && (
            <figcaption className="text-[13px] leading-[1.6] text-zinc-500">{withCode(block.caption)}</figcaption>
          )}
        </figure>
      )

    case 'responsibility':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={`p-5 ${PANEL}`}>
            <p className={`text-[15px] text-white ${HEADING}`}>Backenly does</p>
            <GlyphList className="mt-4" glyph="check" items={block.platform.map((item) => withCode(item))} />
          </div>
          <div className={`p-5 ${PANEL}`}>
            <p className={`text-[15px] text-white ${HEADING}`}>You own</p>
            <GlyphList className="mt-4" glyph="dash" items={block.you.map((item) => withCode(item))} />
          </div>
        </div>
      )
  }
}

/* ─────────────────────────────────────────────────────────────
   A guide, read like documentation rather than a landing page.

   Three columns at xl: every guide on the left (so the next one is always a
   click away), the article at a reading measure in the middle, and an
   "On this page" index on the right that follows the scroll. At lg the right
   column folds away; below lg the article stands alone and the guide list
   moves to the foot of the page as previous and next.
───────────────────────────────────────────────────────────── */

export default async function ResourceSlugPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params
  const a = ARTICLES_BY_SLUG[params.slug]
  if (!a) notFound()

  const readMinutes = READ_MINUTES[a.slug]
  const updated = a.dateDisplay.replace('Updated ', '')

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: a.title,
    description: a.metaDescription,
    datePublished: a.datePublished,
    dateModified: a.dateModified,
    author: {
      '@type': 'Person',
      name: ARTICLE_AUTHOR.name,
      jobTitle: ARTICLE_AUTHOR.role,
      url: ARTICLE_AUTHOR.url,
    },
    publisher: {
      '@type': 'Organization',
      name: 'Backenly',
      url: APP_URL,
      logo: { '@type': 'ImageObject', url: `${APP_URL}/backenly-icon-hd.svg` },
    },
    url: `${APP_URL}/resources/${a.slug}`,
    mainEntityOfPage: { '@type': 'WebPage', '@id': `${APP_URL}/resources/${a.slug}` },
  }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: APP_URL },
      { '@type': 'ListItem', position: 2, name: 'Resources', item: `${APP_URL}/resources` },
      { '@type': 'ListItem', position: 3, name: a.title, item: `${APP_URL}/resources/${a.slug}` },
    ],
  }

  const related = a.relatedSlugs
    .map((s) => articles.find((x) => x.slug === s))
    .filter(Boolean) as typeof articles

  const order = ALL_ARTICLES.findIndex((x) => x.slug === a.slug)
  const previous = order > 0 ? ALL_ARTICLES[order - 1] : undefined
  const next = order < ALL_ARTICLES.length - 1 ? ALL_ARTICLES[order + 1] : undefined

  const toc = a.sections.map((section) => ({ id: anchorFor(section.heading), label: section.heading }))

  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(articleSchema)} />
      <JsonLd json={safeJsonLd(breadcrumbSchema)} />
      <Page>
        {/* Key light, as on every page, behind the title. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-[260px] left-[-12%] h-[820px] w-[1100px] max-w-none bg-[radial-gradient(closest-side,rgba(255,255,255,0.06),transparent)]"
        />

        <div className={`${CONTAINER} relative pb-[120px] pt-[40px] md:pt-[64px]`}>
          <div className="grid gap-12 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-14 xl:grid-cols-[200px_minmax(0,1fr)_200px] xl:gap-16">
            {/* Every guide, grouped by shelf. */}
            <aside className="hidden lg:block">
              <nav aria-label="Guides" className="sticky top-[100px]">
                {LANES.map((lane) => (
                  <div key={lane.id} className="mb-8">
                    <p className="mb-3 text-[13px] font-medium text-zinc-500">{lane.title}</p>
                    <ul className="flex flex-col border-l border-white/[0.08]">
                      {ALL_ARTICLES.filter((x) => x.lane === lane.id).map((x) => {
                        const current = x.slug === a.slug
                        return (
                          <li key={x.slug}>
                            <Link
                              href={`/resources/${x.slug}`}
                              aria-current={current ? 'page' : undefined}
                              className={`-ml-px block border-l py-[7px] pl-4 text-[14px] leading-[1.45] tracking-[-0.006em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 ${
                                current
                                  ? 'border-violet-300 text-white'
                                  : 'border-transparent text-zinc-500 hover:border-white/25 hover:text-zinc-200'
                              }`}
                            >
                              {x.title}
                            </Link>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </nav>
            </aside>

            <article className="min-w-0 max-w-[740px]">
              <header className="hero-enter">
                <Trail
                  items={[
                    { label: 'Home', href: '/' },
                    { label: 'Documentation', href: '/resources' },
                    { label: a.title },
                  ]}
                />
                <h1
                  className={`mt-7 bg-gradient-to-b from-white from-40% to-zinc-400 bg-clip-text pb-2 text-[36px] text-transparent [text-wrap:balance] sm:text-[44px] md:text-[50px] ${DISPLAY}`}
                >
                  {a.title}
                </h1>
                <p className="mt-5 text-[18px] leading-[1.65] tracking-[-0.012em] text-zinc-400 [text-wrap:pretty]">
                  {withCode(a.intro)}
                </p>
                <p className="mt-7 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-zinc-500">
                  <span>{LANE_TITLES[a.lane]}</span>
                  <span aria-hidden className="h-3 w-px bg-white/[0.12]" />
                  <span>{readMinutes} min read</span>
                  <span aria-hidden className="h-3 w-px bg-white/[0.12]" />
                  <span>Updated {updated}</span>
                </p>
              </header>

              <div
                aria-hidden
                className="mt-10 h-px bg-[linear-gradient(to_right,rgba(196,181,253,0.45),rgba(255,255,255,0.10)_45%,transparent)]"
              />

              <div className="mt-12 flex flex-col gap-16">
                {a.sections.map((section) => {
                  const id = anchorFor(section.heading)
                  return (
                    <section key={section.heading} id={id} className="scroll-mt-[100px]">
                      <h2 className={`group text-[24px] text-white md:text-[28px] ${TITLE}`}>
                        <a
                          href={`#${id}`}
                          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
                        >
                          {withCode(section.heading)}
                          <span
                            aria-hidden
                            className="ml-2 text-zinc-600 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                          >
                            #
                          </span>
                        </a>
                      </h2>
                      <div className="mt-6 flex flex-col gap-6">
                        {section.blocks.map((block, i) => (
                          <BlockRenderer key={i} block={block} />
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>

              <div className={`mt-16 p-6 md:p-8 ${PANEL}`}>
                <h2 className={`text-[19px] text-white ${HEADING}`}>In short</h2>
                <p className={`mt-3 ${READ}`}>{withCode(a.conclusion)}</p>
                <p className="mt-6 border-t border-white/[0.08] pt-5 text-[13px] text-zinc-500">
                  Written by <span className="text-zinc-300">{ARTICLE_AUTHOR.name}</span>, {ARTICLE_AUTHOR.role}. Updated{' '}
                  {updated}.
                </p>
              </div>

              <div className="relative mt-6 overflow-hidden rounded-2xl border border-violet-300/[0.18] bg-[#0a0b0d] p-6 md:p-8">
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(167,139,250,0.6),transparent)]"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_80%_at_20%_0%,rgba(139,92,246,0.10),transparent)]"
                />
                <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className={`text-[19px] text-white ${HEADING}`}>Try it on a live project</h2>
                    <p className="mt-2 max-w-[46ch] text-[15px] leading-[1.65] text-zinc-400">
                      One free project, no credit card. Connect your agent over MCP and read the
                      verification evidence yourself.
                    </p>
                  </div>
                  <div className="shrink-0">
                    <StartButton />
                  </div>
                </div>
              </div>

              {(previous || next) && (
                <nav aria-label="Previous and next guide" className="mt-16 grid gap-3 sm:grid-cols-2">
                  {previous ? (
                    <Link
                      href={`/resources/${previous.slug}`}
                      className={`group flex flex-col gap-2 p-5 transition-colors duration-200 hover:border-white/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${PANEL}`}
                    >
                      <span className="inline-flex items-center gap-1.5 text-[13px] text-zinc-500">
                        <ArrowLeft aria-hidden className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" />
                        Previous
                      </span>
                      <span className={`text-[16px] text-white ${HEADING}`}>{previous.title}</span>
                    </Link>
                  ) : (
                    <span className="hidden sm:block" />
                  )}
                  {next && (
                    <Link
                      href={`/resources/${next.slug}`}
                      className={`group flex flex-col items-end gap-2 p-5 text-right transition-colors duration-200 hover:border-white/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${PANEL}`}
                    >
                      <span className="inline-flex items-center gap-1.5 text-[13px] text-zinc-500">
                        Next
                        <ArrowRight aria-hidden className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                      </span>
                      <span className={`text-[16px] text-white ${HEADING}`}>{next.title}</span>
                    </Link>
                  )}
                </nav>
              )}

              {related.length > 0 && (
                <div className="mt-16">
                  <h2 className={`text-[19px] text-white ${HEADING}`}>Related guides</h2>
                  <NextLinks
                    className="mt-5"
                    items={related.map((r) => ({
                      href: `/resources/${r.slug}`,
                      meta: `${r.category}, ${r.readMinutes} min`,
                      title: r.title,
                    }))}
                  />
                </div>
              )}
            </article>

            {/* On this page, following the scroll. */}
            <aside className="hidden xl:block">
              <div className="sticky top-[100px]">
                <p className="mb-3 text-[13px] font-medium text-zinc-500">On this page</p>
                <ScrollSpy label="On this page" items={toc} />
              </div>
            </aside>
          </div>
        </div>
      </Page>
    </SiteShell>
  )
}
