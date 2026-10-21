import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { CodeBlock } from '@/components/site/CodeBlock'
import { JsonLd, Page, Steps, Trail } from '@/components/site/kit'
import { ScrollSpy } from '@/components/site/ScrollSpy'
import { CONTAINER, DISPLAY, HEADING, PANEL, TITLE } from '@/components/site/tokens'
import { DOC_ICONS } from '@/components/docs/DocIcon'
import { DocsMobileNav, DocsSidebar, DocTag } from '@/components/docs/DocsNav'
import { DocVideo } from '@/components/docs/DocVideo'
import { ICON_CHIP, READ, ROW_RULE } from '@/components/docs/tokens'
import { rich } from '@/components/docs/rich'
import { consolePath, DOC_HEADINGS, DOC_SECTIONS, DOCS_BY_SLUG, DOCS_UPDATED, type DocSection } from '../content'
import { DOC_VIDEOS } from '../videos'

const APP_URL = 'https://backenly.com'

function findDoc(slug: string): DocSection | undefined {
  return (DOCS_BY_SLUG as Record<string, DocSection | undefined>)[slug]
}

export function generateStaticParams() {
  return DOC_SECTIONS.map((d) => ({ slug: d.slug }))
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await props.params
  const doc = findDoc(slug)
  if (!doc) return { title: 'Not Found' }

  const url = `${APP_URL}/docs/${doc.slug}`
  return {
    title: `${doc.title}: Backenly docs`,
    description: doc.metaDescription,
    openGraph: {
      title: `${doc.title}: Backenly docs`,
      description: doc.metaDescription,
      url,
      type: 'article',
      modifiedTime: DOCS_UPDATED.iso,
    },
    twitter: { card: 'summary_large_image', title: `${doc.title}: Backenly docs`, description: doc.metaDescription },
    alternates: { canonical: url },
  }
}

/** A small dot that marks a list item, aligned to the first line of 15-16px copy. */
function Dot() {
  return <span aria-hidden className="mt-[11px] h-[4px] w-[4px] shrink-0 rounded-full bg-zinc-600" />
}

/** One of the four fixed sections, with a linkable heading. */
function DocBlock({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-[100px]">
      <h2 id={`${id}-heading`} className={`group text-[23px] text-white md:text-[26px] ${TITLE}`}>
        <a
          href={`#${id}`}
          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
        >
          {label}
          <span aria-hidden className="ml-[8px] text-zinc-600 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            #
          </span>
        </a>
      </h2>
      <div className="mt-[20px] flex flex-col gap-[20px]">{children}</div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────
   One console section, documented.

   Every page has the same shape, so two sections can be compared at a glance:
   what it is (the paragraph under the title), then why you would need it, how
   it works, how to try it, and what to know. A walkthrough video sits under
   the header only when app/docs/videos.ts lists one.

   Three columns at xl: every section on the left, grouped like the console
   sidebar; the page at a reading measure in the middle; "On this page" on the
   right, following the scroll. At lg the right column folds away, and below lg
   the section list moves into a menu at the top of the page.

   The landing's system (components/landing-v7/shared.tsx): bento surfaces for
   the examples and the previous/next cards, the ink chip for the icon, hairline
   rows for the notes. Violet marks one thing, the section you are reading in
   the "On this page" rail.
───────────────────────────────────────────────────────────── */

export default async function DocPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params
  const doc = findDoc(slug)
  if (!doc) notFound()

  const Icon = DOC_ICONS[doc.slug]
  const video = DOC_VIDEOS[doc.slug]
  const url = `${APP_URL}/docs/${doc.slug}`

  const order = DOC_SECTIONS.findIndex((d) => d.slug === doc.slug)
  const previous = order > 0 ? DOC_SECTIONS[order - 1] : undefined
  const next = order < DOC_SECTIONS.length - 1 ? DOC_SECTIONS[order + 1] : undefined

  const hasTry = doc.prompts.length > 0 || Boolean(doc.code)
  const toc = DOC_HEADINGS.filter((h) => h.id !== 'try' || hasTry).map((h) => ({ id: h.id, label: h.label }))

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: doc.title,
    description: doc.metaDescription,
    dateModified: DOCS_UPDATED.iso,
    author: { '@type': 'Organization', name: 'Backenly', url: APP_URL },
    publisher: {
      '@type': 'Organization',
      name: 'Backenly',
      url: APP_URL,
      logo: { '@type': 'ImageObject', url: `${APP_URL}/backenly-icon-hd.svg` },
    },
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
  }

  // Two levels: the docs have no index page to name as a parent (2026-10-15).
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: APP_URL },
      { '@type': 'ListItem', position: 2, name: doc.title, item: url },
    ],
  }

  const pager = `group flex min-w-0 flex-col gap-[8px] p-[20px] transition-colors duration-200 hover:border-white/[0.13] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${PANEL}`

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

        <div className={`${CONTAINER} relative pb-[120px] pt-[28px] md:pt-[48px]`}>
          <div className="grid gap-[40px] lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-[48px] xl:grid-cols-[232px_minmax(0,1fr)_200px] xl:gap-[64px]">
            <aside className="hidden border-r border-white/[0.06] pr-[20px] lg:block">
              <DocsSidebar current={doc.slug} />
            </aside>

            <article className="min-w-0 max-w-[760px] lg:pt-[4px]">
              <DocsMobileNav current={doc.slug} />

              <header className={`hero-enter mt-[28px] border-b pb-[36px] lg:mt-0 ${ROW_RULE}`}>
                <Trail
                  items={[
                    { label: 'Home', href: '/' },
                    // Not a link: there is no docs index page; the sidebar is the map.
                    { label: 'Documentation' },
                    { label: doc.title },
                  ]}
                />
                <div className="mt-[28px] flex items-center gap-[14px]">
                  <span className={`h-[44px] w-[44px] rounded-[8px] text-zinc-200 ${ICON_CHIP}`}>
                    <Icon aria-hidden strokeWidth={1.75} className="h-[20px] w-[20px]" />
                  </span>
                  <h1
                    className={`min-w-0 bg-gradient-to-b from-white from-40% to-zinc-400 bg-clip-text pb-[4px] text-[34px] text-transparent sm:text-[40px] md:text-[46px] ${DISPLAY}`}
                  >
                    {doc.title}
                  </h1>
                  {doc.tag && <DocTag className="mt-[6px]">{doc.tag}</DocTag>}
                </div>
                <p className="mt-[20px] max-w-[64ch] text-[17px] leading-[1.65] tracking-[-0.012em] text-zinc-400 [text-wrap:pretty] md:text-[18px]">
                  {rich(doc.summary)}
                </p>
                <p className="mt-[20px] flex flex-wrap items-center gap-x-[12px] gap-y-[4px] text-[13px] text-zinc-500">
                  <span>
                    In the console: <span className="text-zinc-300">{consolePath(doc)}</span>
                  </span>
                  <span aria-hidden className="h-[12px] w-px bg-white/[0.12]" />
                  <span>Updated {DOCS_UPDATED.display}</span>
                </p>
              </header>

              {video && (
                <div className="mt-[40px]">
                  <DocVideo title={doc.title} video={video} />
                </div>
              )}

              <div className="mt-[48px] flex flex-col gap-[64px]">
                <DocBlock id="why" label="Why you need it">
                  <p className={READ}>{rich(doc.why)}</p>
                  <div className={`p-[20px] md:p-[24px] ${PANEL}`}>
                    <p className={`text-[15px] text-white ${HEADING}`}>For example</p>
                    <ul className="mt-[12px] flex flex-col gap-[10px]">
                      {doc.examples.map((example) => (
                        <li
                          key={example}
                          className="flex gap-[12px] text-[15px] leading-[1.7] text-zinc-300 [text-wrap:pretty]"
                        >
                          <Dot />
                          <span className="min-w-0">{rich(example)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </DocBlock>

                <DocBlock id="how" label="How it works">
                  <Steps steps={doc.how} />
                </DocBlock>

                {hasTry && (
                  <DocBlock id="try" label="Try it">
                    {doc.prompts.length > 0 && (
                      <>
                        <p className={READ}>
                          {doc.slug === 'connect'
                            ? rich('Once the install command has run, start a new conversation with your agent and ask:')
                            : rich('Once your coding agent is [connected](/docs/connect), ask it:')}
                        </p>
                        {doc.prompts.map((prompt) => (
                          <CodeBlock key={prompt} code={prompt} label="Ask your agent" language="text" wrap />
                        ))}
                      </>
                    )}
                    {doc.code && <CodeBlock code={doc.code.code} label={doc.code.label} language={doc.code.language} />}
                  </DocBlock>
                )}

                <DocBlock id="notes" label="Good to know">
                  <ul className={`border-t ${ROW_RULE}`}>
                    {doc.notes.map((note) => (
                      <li key={note} className={`flex gap-[12px] border-b py-[16px] ${ROW_RULE}`}>
                        <Dot />
                        <span className={`min-w-0 ${READ}`}>{rich(note)}</span>
                      </li>
                    ))}
                  </ul>
                </DocBlock>
              </div>

              <nav aria-label="Previous and next section" className="mt-[72px] grid gap-[12px] sm:grid-cols-2">
                {previous ? (
                  <Link href={`/docs/${previous.slug}`} className={pager}>
                    <span className="inline-flex items-center gap-[6px] text-[13px] text-zinc-500">
                      <ArrowLeft aria-hidden className="h-[14px] w-[14px] transition-transform duration-200 group-hover:-translate-x-0.5" />
                      Previous
                    </span>
                    <span className={`text-[16px] text-white ${HEADING}`}>{previous.title}</span>
                  </Link>
                ) : (
                  <span className="hidden sm:block" />
                )}
                {next && (
                  <Link href={`/docs/${next.slug}`} className={`${pager} items-end text-right`}>
                    <span className="inline-flex items-center gap-[6px] text-[13px] text-zinc-500">
                      Next
                      <ArrowRight aria-hidden className="h-[14px] w-[14px] transition-transform duration-200 group-hover:translate-x-0.5" />
                    </span>
                    <span className={`text-[16px] text-white ${HEADING}`}>{next.title}</span>
                  </Link>
                )}
              </nav>
            </article>

            <aside className="hidden xl:block">
              <div className="sticky top-[100px] pt-[4px]">
                <p className="mb-[12px] text-[13px] font-medium text-zinc-500">On this page</p>
                <ScrollSpy label="On this page" items={toc} />
              </div>
            </aside>
          </div>
        </div>
      </Page>
    </SiteShell>
  )
}
