import { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { SiteShell } from '@/components/site/SiteShell'
import { articles } from '../data'
import {
  ALL_ARTICLES,
  ARTICLES_BY_SLUG,
  ARTICLE_AUTHOR,
  type ArticleBlock,
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

export function generateStaticParams() {
  return ALL_ARTICLES.map((a) => ({ slug: a.slug }))
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const a = ARTICLES_BY_SLUG[params.slug]
  if (!a) return { title: 'Not Found' }
  return {
    title: a.title,
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

function BlockRenderer({ block }: { block: ArticleBlock }) {
  switch (block.kind) {
    case 'p':
      return <Lead>{block.text}</Lead>
    case 'code':
      return (
        <figure className="my-2">
          {block.label && (
            <figcaption className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
              {block.label}
            </figcaption>
          )}
          <div className="overflow-x-auto rounded-lg border border-white/10 bg-[#0a0a0c]">
            <pre className="px-5 py-4 font-mono text-[13px] leading-6 text-zinc-200">
              <code>{block.code}</code>
            </pre>
          </div>
        </figure>
      )
    case 'list':
      return (
        <ul className="flex flex-col gap-3">
          {block.items.map((item) => (
            <li key={item} className="flex gap-3 text-[15px] leading-7 text-neutral-400 font-extralight">
              <span aria-hidden className="mt-3 h-1 w-1 shrink-0 rounded-full bg-violet-300/70" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )
    case 'note':
      return (
        <aside className="rounded-lg border border-violet-400/20 bg-violet-400/[0.04] px-5 py-4">
          <p className="text-sm leading-7 text-neutral-300 font-extralight">{block.text}</p>
        </aside>
      )
  }
}

export default function ResourceSlugPage({ params }: { params: { slug: string } }) {
  const a = ARTICLES_BY_SLUG[params.slug]
  if (!a) notFound()

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
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
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(articleSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbSchema) }} />
      <main className="relative z-20">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Resources', href: '/resources' },
            { label: a.title },
          ]}
        />

        <PageHero
          eyebrow={a.category}
          title={a.title}
          subtitle={a.intro}
          proof={[
            { label: 'Author', value: ARTICLE_AUTHOR.name },
            { label: 'Reading time', value: a.readTime },
            { label: 'Last updated', value: a.dateDisplay },
          ]}
        />

        {/* Article body */}
        <article className="pb-16">
          <div className="max-w-3xl mx-auto px-6">
            <div className="flex flex-col gap-12">
              {a.sections.map((section) => (
                <section key={section.heading}>
                  <h2 className="text-xl font-light tracking-tight text-white mb-4">
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

            {/* Conclusion */}
            <div className="mt-12 pt-8 border-t border-white/[0.07]">
              <h2 className="text-lg font-normal text-white mb-3">The bottom line</h2>
              <Lead>{a.conclusion}</Lead>
            </div>

            {/* Author line */}
            <div className="mt-10 flex items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-5 py-4">
              <div>
                <p className="text-sm font-normal text-white">{ARTICLE_AUTHOR.name}</p>
                <p className="text-xs text-neutral-500">
                  {ARTICLE_AUTHOR.role} · Published {a.datePublished} · Updated {a.dateModified}
                </p>
              </div>
            </div>

            {/* Article CTA */}
            <Card className="mt-12 !border-violet-400/20 !p-8 text-center">
              <h3 className="text-lg font-normal text-white mb-2">
                Build your backend with Backenly
              </h3>
              <p className="text-sm text-neutral-400 font-extralight leading-relaxed mb-6">
                Free forever plan. No credit card. Describe your backend and watch it verify itself.
              </p>
              <PrimaryButton href="/auth/signup">
                Get started free
                <InlineArrow />
              </PrimaryButton>
            </Card>
          </div>
        </article>

        {/* Related articles */}
        {related.length > 0 && (
          <Section aria-label="Related articles" className="!pt-0">
            <h2 className="text-lg font-normal text-white mb-6">Related reading</h2>
            <div className="flex flex-col gap-4">
              {related.map((r) => (
                <Link key={r.slug} href={`/resources/${r.slug}`} className="group block">
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5 transition-colors group-hover:border-white/20 group-hover:bg-white/[0.04]">
                    <div className="flex items-center gap-2.5 mb-1.5">
                      <Tag>{r.category}</Tag>
                      <span className="text-xs text-neutral-500">{r.readTime}</span>
                    </div>
                    <p className="text-sm font-normal text-white">{r.title}</p>
                  </div>
                </Link>
              ))}
            </div>
            <div className="mt-6">
              <Link
                href="/resources"
                className="text-sm text-violet-300 hover:text-white transition-colors"
              >
                All resources
              </Link>
            </div>
          </Section>
        )}
      </main>
    </SiteShell>
  )
}
