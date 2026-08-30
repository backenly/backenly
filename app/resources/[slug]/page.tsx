import { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { notFound } from 'next/navigation'
import Link from 'next/link'
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
import {
  Breadcrumb,
  InlineArrow,
  PageHero,
  Section,
  Lead,
  Card,
  Tag,
  PrimaryButton,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'

/** Shelf label for the hero, resolved from the same LANES the index renders. */
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
    title: `${a.title} — Backenly docs`,
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
 * in-page nav and the heading ids can never disagree — they call the same
 * function on the same string.
 */
function anchorFor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function BlockRenderer({ block }: { block: ArticleBlock }) {
  switch (block.kind) {
    case 'p':
      return <Lead>{block.text}</Lead>

    case 'code':
      return <CodeBlock code={block.code} label={block.label} language={block.language} />

    case 'list':
      return (
        <ul className="flex flex-col gap-3">
          {block.items.map((item) => (
            <li key={item} className="flex gap-3 text-[15px] leading-7 text-neutral-300 font-light">
              <span aria-hidden className="mt-3 h-1 w-1 shrink-0 rounded-full bg-violet-300/70" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )

    case 'note':
      return (
        <aside className="rounded-lg border border-violet-400/20 bg-violet-400/[0.04] px-5 py-4">
          <p className="text-sm leading-7 text-neutral-300 font-light">{block.text}</p>
        </aside>
      )

    /**
     * A mechanism, not decoration: input → what the platform does → result. The
     * rail is a single hairline so it reads as one sequence rather than a stack
     * of cards, and the whole thing is an ordered list so it is a sequence to a
     * screen reader too.
     */
    case 'steps':
      return (
        <ol className="relative flex flex-col gap-6 border-l border-white/10 pl-6">
          {block.steps.map((step) => (
            <li key={step.title} className="relative">
              <span
                aria-hidden
                className="absolute -left-[27px] top-1.5 h-2 w-2 rounded-full border border-white/25 bg-black"
              />
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
                {step.label}
              </p>
              <p className="mt-1 text-[15px] font-medium text-white">{step.title}</p>
              <p className="mt-1.5 text-[15px] leading-7 text-neutral-400 font-light">
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      )

    /**
     * Wide content scrolls inside its own container. The page body must never
     * scroll horizontally, which is the failure mode a bare <table> produces on
     * a 375px screen.
     */
    case 'table':
      return (
        <figure className="flex flex-col gap-2">
          <div className="-mx-1 overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full min-w-[34rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.03]">
                  {block.columns.map((col) => (
                    <th
                      key={col}
                      scope="col"
                      className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-400"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row) => (
                  <tr key={row.join('|')} className="border-b border-white/[0.06] last:border-0">
                    {row.map((cell, i) => (
                      <td
                        key={i}
                        className={`px-4 py-3 align-top text-sm leading-6 ${
                          i === 0 ? 'font-medium text-zinc-200' : 'text-neutral-400 font-light'
                        }`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {block.caption && (
            <figcaption className="text-xs leading-6 text-neutral-500">{block.caption}</figcaption>
          )}
        </figure>
      )

    case 'responsibility':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          {(
            [
              { title: 'Backenly does', items: block.platform, dot: 'bg-violet-300/70' },
              { title: 'You own', items: block.you, dot: 'bg-zinc-500' },
            ] as const
          ).map((col) => (
            <div key={col.title} className="rounded-lg border border-white/10 bg-white/[0.02] p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-neutral-400">
                {col.title}
              </p>
              <ul className="mt-4 flex flex-col gap-3">
                {col.items.map((item) => (
                  <li
                    key={item}
                    className="flex gap-2.5 text-sm leading-6 text-neutral-300 font-light"
                  >
                    <span aria-hidden className={`mt-2 h-1 w-1 shrink-0 rounded-full ${col.dot}`} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )
  }
}

export default async function ResourceSlugPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params
  const a = ARTICLES_BY_SLUG[params.slug]
  if (!a) notFound()

  const readMinutes = READ_MINUTES[a.slug]

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

  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(articleSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbSchema) }}
      />
      <main className="relative z-20">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Resources', href: '/resources' },
            { label: a.title },
          ]}
        />

        {/*
          The proof row is a three-up grid of small tiles, so its values have to
          stay short — a full sentence wraps to four lines and leaves the other
          two tiles half empty. The question this guide answers is the index
          card's job; by the time someone is on the page they have chosen it,
          and the intro below does the orienting.
        */}
        <PageHero
          eyebrow={a.category}
          title={a.title}
          subtitle={a.intro}
          proof={[
            { label: 'Section', value: LANE_TITLES[a.lane] },
            { label: 'Reading time', value: `${readMinutes} min` },
            { label: 'Last updated', value: a.dateDisplay.replace('Updated ', '') },
          ]}
        />

        {/*
          The article shares the hero's container (max-w-4xl) at every width, so
          the title and the first heading always start at the same x. From 2xl
          up, the in-page nav hangs in the right margin that a 1536px+ viewport
          leaves over — using empty space rather than reflowing the text. Below
          2xl nothing moves: phones, tablets and 13"/14" laptops render exactly
          the single column they always did.
        */}
        <div className="relative mx-auto w-full max-w-4xl px-6 pb-16">
          <article className="min-w-0">
            <div className="flex flex-col gap-12">
              {a.sections.map((section) => (
                <section
                  key={section.heading}
                  id={anchorFor(section.heading)}
                  className="scroll-mt-28"
                >
                  <h2 className="mb-5 text-xl font-normal tracking-tight text-white">
                    {section.heading}
                  </h2>
                  <div className="flex flex-col gap-5">
                    {section.blocks.map((block, i) => (
                      <BlockRenderer key={i} block={block} />
                    ))}
                  </div>
                </section>
              ))}
            </div>

            <div className="mt-12 border-t border-white/[0.07] pt-8">
              <h2 className="mb-3 text-lg font-normal text-white">In short</h2>
              <Lead>{a.conclusion}</Lead>
            </div>

            <div className="mt-10 rounded-lg border border-white/[0.07] bg-white/[0.02] px-5 py-4">
              <p className="text-sm font-normal text-white">{ARTICLE_AUTHOR.name}</p>
              <p className="text-xs text-neutral-500">
                {ARTICLE_AUTHOR.role} · Updated {a.dateDisplay.replace('Updated ', '')}
              </p>
            </div>

            <Card className="mt-12 !border-violet-400/20 !p-8">
              <h2 className="mb-2 text-lg font-normal text-white">Try it on a live project</h2>
              <p className="mb-6 text-sm font-light leading-relaxed text-neutral-400">
                One free project, no credit card. Connect your agent over MCP and read the
                verification evidence yourself.
              </p>
              <PrimaryButton href="/auth/signup">
                Create a project
                <InlineArrow />
              </PrimaryButton>
            </Card>
          </article>

          {/*
            In-page nav, 2xl and up only.

            It hangs in the right margin rather than sitting in a grid column,
            because the article has to share the hero's container to line up
            with it. A grid wide enough to hold both centred its first column at
            a different x than the hero above, and the ~100px step between the
            title and the first heading read as a broken layout on a 16" screen.
            `left-full` pins it just outside that shared container, so the two
            can never drift apart again.
          */}
          <aside className="absolute inset-y-0 left-full ml-10 hidden w-56 2xl:block">
            <nav aria-label="On this page" className="sticky top-28">
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-neutral-500">
                On this page
              </p>
              <ul className="mt-4 flex flex-col gap-2.5 border-l border-white/10 pl-4">
                {a.sections.map((section) => (
                  <li key={section.heading}>
                    <a
                      href={`#${anchorFor(section.heading)}`}
                      className="block text-sm leading-6 text-neutral-500 transition-colors hover:text-white focus-visible:text-white focus-visible:outline-none"
                    >
                      {section.heading}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        </div>

        {related.length > 0 && (
          <Section aria-label="Related guides" className="!pt-0">
            <h2 className="mb-6 text-lg font-normal text-white">Next</h2>
            <div className="flex flex-col gap-4">
              {related.map((r) => (
                <Link key={r.slug} href={`/resources/${r.slug}`} className="group block">
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5 transition-colors group-hover:border-white/20 group-hover:bg-white/[0.04]">
                    <div className="mb-1.5 flex items-center gap-2.5">
                      <Tag>{r.category}</Tag>
                      <span className="text-xs text-neutral-500">{r.readMinutes} min</span>
                    </div>
                    <p className="text-sm font-normal text-white">{r.title}</p>
                    <p className="mt-1 text-sm font-light text-neutral-500">{r.answers}</p>
                  </div>
                </Link>
              ))}
            </div>
            <div className="mt-6">
              <Link
                href="/resources"
                className="text-sm text-violet-300 transition-colors hover:text-white"
              >
                All guides
              </Link>
            </div>
          </Section>
        )}
      </main>
    </SiteShell>
  )
}
