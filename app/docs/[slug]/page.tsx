import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { ORGANIZATION_ID } from '@/lib/seo/schema'
import { SiteShell } from '@/components/site/SiteShell'
import { CodeBlock } from '@/components/site/CodeBlock'
import { JsonLd, Page, Steps, Trail } from '@/components/site/kit'
import { ScrollSpy } from '@/components/site/ScrollSpy'
import { CONTAINER, DISPLAY, HEADING, PANEL, TITLE } from '@/components/site/tokens'
import { Light, Tag } from '@/components/landing-v8/Box'
import { DOC_ICONS } from '@/components/docs/DocIcon'
import { DocsMobileNav, DocsSidebar, DocTag } from '@/components/docs/DocsNav'
import { DocVideo } from '@/components/docs/DocVideo'
import { READ, ROW_RULE } from '@/components/docs/tokens'
import { rich } from '@/components/docs/rich'
import { consolePath, DOC_GROUPS, DOC_HEADINGS, DOC_SECTIONS, DOCS_BY_SLUG, DOCS_UPDATED, docsInGroup, type DocSection } from '../content'
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

  // "Database: Postgres tables, REST API and RLS | Backenly Docs": what the
  // section covers first, then whose docs these are.
  return pageMetadata({
    title: `${doc.metaTitle} | Backenly Docs`,
    brandInTitle: true,
    description: doc.metaDescription,
    path: `/docs/${doc.slug}`,
    type: 'article',
    modifiedTime: DOCS_UPDATED.iso,
  })
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
          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
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

   2026-11-15 (site-wide pass, to match the v8 landing): the landing's tag over
   a plain white title, its painted light kept low behind the header, no
   entrance, the page's four headings under the header below xl, and Connect
   first in the sidebar and in previous / next. Violet marks the tag and the
   section you are reading in the "On this page" rail.
───────────────────────────────────────────────────────────── */

export default async function DocPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params
  const doc = findDoc(slug)
  if (!doc) notFound()

  const Icon = DOC_ICONS[doc.slug]
  const video = DOC_VIDEOS[doc.slug]
  const url = `${APP_URL}/docs/${doc.slug}`

  // Previous and next follow the sidebar's reading order (Connect first), not the order the sections are written in.
  const reading = DOC_GROUPS.flatMap((group) => docsInGroup(group.id))
  const order = reading.findIndex((d) => d.slug === doc.slug)
  const previous = order > 0 ? reading[order - 1] : undefined
  const next = order < reading.length - 1 ? reading[order + 1] : undefined
  const groupLabel = DOC_GROUPS.find((group) => group.id === doc.group)?.label ?? 'Docs'

  const hasTry = doc.prompts.length > 0 || Boolean(doc.code)
  const toc = DOC_HEADINGS.filter((h) => h.id !== 'try' || hasTry).map((h) => ({ id: h.id, label: h.label }))

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: doc.title,
    description: doc.metaDescription,
    dateModified: DOCS_UPDATED.iso,
    // The organization node is the root layout's (lib/seo/schema.ts).
    author: { '@id': ORGANIZATION_ID },
    publisher: { '@id': ORGANIZATION_ID },
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

  const pager = `group flex min-w-0 flex-col gap-[8px] p-[20px] transition-colors duration-200 hover:border-white/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${PANEL}`

  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(articleSchema)} />
      <JsonLd json={safeJsonLd(breadcrumbSchema)} />
      <Page>
        {/* The landing's painted light, kept low for reading and gone before the first section; still, like every light on the site. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 isolate h-[520px] overflow-hidden">
          <Light art="b" reach={520} mask="linear-gradient(to bottom, rgba(0,0,0,0.38) 0%, rgba(0,0,0,0.3) 45%, transparent 100%)" />
        </div>

        <div className={`${CONTAINER} relative pb-[120px] pt-[28px] md:pt-[48px]`}>
          <div className="grid gap-[40px] lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-[48px] xl:grid-cols-[232px_minmax(0,1fr)_200px] xl:gap-[64px]">
            {/* Plain containers: the navs inside them are the landmarks (two unlabeled asides failed axe landmark-unique). */}
            <div className="hidden border-r border-white/[0.06] pr-[20px] lg:block">
              <DocsSidebar current={doc.slug} />
            </div>

            <article className="min-w-0 max-w-[760px] lg:pt-[4px]">
              <DocsMobileNav current={doc.slug} />

              {/* No entrance: a reader is here to read (site-wide pass, 2026-11-15). */}
              <header className={`mt-[28px] border-b pb-[36px] lg:mt-0 ${ROW_RULE}`}>
                <Trail
                  readable
                  items={[
                    { label: 'Home', href: '/' },
                    // Not a link: there is no docs index page; the sidebar is the map.
                    { label: 'Documentation' },
                    { label: doc.title },
                  ]}
                />
                {/* The landing's tag names the part of the console; the title is the section, in plain white. */}
                {/* Not where the group and the section share a name (Connect), so the tag never repeats the title. */}
                {groupLabel !== doc.title && (
                  <div className="mt-[24px]">
                    <Tag icon={Icon}>{groupLabel}</Tag>
                  </div>
                )}
                <div className={`${groupLabel !== doc.title ? 'mt-[18px]' : 'mt-[24px]'} flex flex-wrap items-center gap-x-[14px] gap-y-[8px]`}>
                  <h1 className={`min-w-0 text-[36px] text-white sm:text-[42px] md:text-[48px] ${DISPLAY}`}>{doc.title}</h1>
                  {doc.tag && <DocTag className="mt-[8px]">{doc.tag}</DocTag>}
                </div>
                <p className="mt-[18px] max-w-[64ch] text-[17px] leading-[1.65] tracking-[-0.012em] text-zinc-300 [text-wrap:pretty] md:text-[18px]">
                  {rich(doc.summary)}
                </p>
                <p className="mt-[20px] flex flex-wrap items-center gap-x-[12px] gap-y-[4px] text-[13px] text-faint">
                  <span>
                    In the console: <span className="text-zinc-300">{consolePath(doc)}</span>
                  </span>
                  <span aria-hidden className="h-[12px] w-px bg-white/[0.12]" />
                  <span>Updated {DOCS_UPDATED.display}</span>
                </p>
              </header>

              {/* Below xl the rail is gone, so the page's four headings sit under the header instead. */}
              <nav aria-label="On this page" className="mt-[20px] xl:hidden">
                <ul className="flex flex-wrap gap-x-[20px] gap-y-[8px] text-[14px]">
                  {toc.map((item) => (
                    <li key={item.id}>
                      <a href={`#${item.id}`} className="rounded-[3px] text-zinc-300 transition-colors duration-150 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>

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
                    <span className="inline-flex items-center gap-[6px] text-[13px] text-faint">
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
                    <span className="inline-flex items-center gap-[6px] text-[13px] text-faint">
                      Next
                      <ArrowRight aria-hidden className="h-[14px] w-[14px] transition-transform duration-200 group-hover:translate-x-0.5" />
                    </span>
                    <span className={`text-[16px] text-white ${HEADING}`}>{next.title}</span>
                  </Link>
                )}
              </nav>
            </article>

            <div className="hidden xl:block">
              <div className="sticky top-[100px] pt-[4px]">
                <p className="mb-[12px] text-[13px] font-medium text-faint">On this page</p>
                <ScrollSpy label="On this page" items={toc} readable />
              </div>
            </div>
          </div>
        </div>
      </Page>
    </SiteShell>
  )
}
