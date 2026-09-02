import { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { SiteShell } from '@/components/site/SiteShell'
import {
  Breadcrumb,
  InlineArrow,
  PageHero,
  PrimaryButton,
  SecondaryButton,
  Section,
  SectionHeading,
  Lead,
  ComparisonTable,
  SplitDecision,
  FaqList,
  CtaSection,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'
import { COMPARISONS, COMPARISON_LIST, type ComparisonData } from '../data'

const APP_URL = 'https://backenly.com'

export function generateStaticParams() {
  return COMPARISON_LIST.map((c) => ({ slug: c.slug }))
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const params = await props.params
  const c = COMPARISONS[params.slug]
  if (!c) return { title: 'Not Found' }

  return {
    title: c.metaTitle,
    description: c.metaDescription,
    openGraph: {
      title: c.metaTitle,
      description: c.metaDescription,
      url: `${APP_URL}/comparisons/${c.slug}`,
      type: 'article',
    },
    twitter: { card: 'summary_large_image', title: c.metaTitle, description: c.metaDescription },
    alternates: { canonical: `${APP_URL}/comparisons/${c.slug}` },
  }
}

/**
 * A strength, on either side. Rendered identically for the competitor and for
 * Backenly so the page cannot visually weight one over the other — the only
 * difference is the border accent, and the competitor's section comes first.
 */
function StrengthList({ items }: { items: { title: string; body: string }[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.title} className="rounded-lg border border-white/10 bg-white/[0.02] p-6">
          <h3 className="text-sm font-medium text-white">{item.title}</h3>
          <p className="mt-2 text-sm font-light leading-6 text-neutral-400">{item.body}</p>
        </div>
      ))}
    </div>
  )
}

export default async function ComparisonSlugPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params
  const c: ComparisonData | undefined = COMPARISONS[params.slug]
  if (!c) notFound()

  /**
   * Structured data mirrors what is on the page and nothing else. The FAQ
   * entries and the breadcrumb are both rendered below; no rating, offer, or
   * product schema is emitted, because none of it would correspond to visible
   * content.
   */
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: c.faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: APP_URL },
      { '@type': 'ListItem', position: 2, name: 'Comparisons', item: `${APP_URL}/comparisons` },
      {
        '@type': 'ListItem',
        position: 3,
        name: c.headline,
        item: `${APP_URL}/comparisons/${c.slug}`,
      },
    ],
  }

  const others = COMPARISON_LIST.filter((x) => x.slug !== c.slug)

  return (
    <SiteShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(faqSchema) }} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbSchema) }}
      />
      <main className="relative z-20">
        <Breadcrumb
          width="wide"
          items={[
            { label: 'Home', href: '/' },
            { label: 'Comparisons', href: '/comparisons' },
            { label: c.competitor },
          ]}
        />

        <PageHero
          width="wide"
          title={c.headline}
          subtitle={c.intro}
          actions={
            <>
              <PrimaryButton href="/auth/signup">
                Try Backenly free
                <InlineArrow />
              </PrimaryButton>
              <SecondaryButton href="/pricing">See pricing</SecondaryButton>
            </>
          }
        />

        {/* The difference in one paragraph. */}
        <Section width="prose" className="!pt-0">
          <SectionHeading className="!text-xl mb-4">The difference in one paragraph</SectionHeading>
          <Lead>{c.summary}</Lead>
        </Section>

        {/* Architecture and workflow. */}
        <Section width="prose" aria-label={`How Backenly and ${c.competitor} are shaped`}>
          <SectionHeading className="mb-8">How they are shaped</SectionHeading>
          <div className="flex flex-col gap-10">
            {c.architecture.map((section) => (
              <div key={section.heading}>
                <h3 className="text-lg font-normal tracking-tight text-white">{section.heading}</h3>
                <p className="mt-3 text-base leading-7 text-zinc-400">{section.body}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* Capability table. */}
        <Section width="wide" aria-label="Capability comparison">
          <SectionHeading className="mb-8">Capability comparison</SectionHeading>
          <ComparisonTable
            caption={`Backenly compared with ${c.competitor}, by capability`}
            competitor={c.competitor}
            rows={c.table}
          />
        </Section>

        {/* Competitor strengths first. Deliberately. */}
        <Section width="wide-prose">
          <SectionHeading className="mb-3">Where {c.competitor} is stronger</SectionHeading>
          <Lead className="mb-8 max-w-3xl">
            These are real advantages, not concessions written to look balanced. If one of them is
            decisive for you, it should decide it.
          </Lead>
          <StrengthList items={c.competitorStrengths} />
        </Section>

        <Section width="wide-prose">
          <SectionHeading className="mb-8">Where Backenly is stronger</SectionHeading>
          <StrengthList items={c.backenlyStrengths} />
        </Section>

        {/* Operating model — only where it is the actual difference. */}
        {c.operating && (
          <Section width="prose">
            <SectionHeading className="!text-xl mb-4">{c.operating.heading}</SectionHeading>
            <Lead>{c.operating.body}</Lead>
          </Section>
        )}

        {/* Agent workflow — only where the two genuinely diverge. */}
        {c.agents && (
          <Section width="prose">
            <SectionHeading className="!text-xl mb-4">{c.agents.heading}</SectionHeading>
            <Lead>{c.agents.body}</Lead>
          </Section>
        )}

        {/* Migration and adoption. The limits are not optional. */}
        {c.migration && (
          <Section width="prose">
            <SectionHeading className="!text-xl mb-4">{c.migration.heading}</SectionHeading>
            <Lead>{c.migration.body}</Lead>
            <h3 className="mt-8 text-sm font-medium text-white">What stays your work</h3>
            <ul className="mt-4 flex flex-col gap-3">
              {c.migration.limits.map((limit) => (
                <li key={limit} className="text-sm font-light leading-6 text-neutral-400">
                  {limit}
                </li>
              ))}
            </ul>
            {c.migration.link && (
              <p className="mt-8">
                <Link
                  href={c.migration.link.href}
                  className="text-sm font-medium text-zinc-200 underline decoration-white/25 underline-offset-4 transition hover:text-white"
                >
                  {c.migration.link.label}
                </Link>
              </p>
            )}
          </Section>
        )}

        {/* The decision. */}
        <Section width="wide-prose">
          <SplitDecision
            heading="Which one to pick"
            competitor={c.competitor}
            chooseCompetitor={c.chooseCompetitorWhen}
            chooseBackenly={c.chooseBackenlyWhen}
          />
        </Section>

        <Section width="prose" aria-label="Frequently asked questions">
          <SectionHeading className="mb-8">Common questions</SectionHeading>
          <FaqList items={c.faq} />
        </Section>

        {/*
         * Sourcing. Every checkable statement about the competitor on this page
         * carries the URL it came from and the date it was read, because
         * competitor pricing and capabilities move and an undated claim is one
         * nobody can audit later.
         */}
        {c.facts.length > 0 && (
          <Section width="prose" aria-label={`Sources for claims about ${c.competitor}`}>
            <h2 className="text-sm font-medium text-white">
              Where the {c.competitor} facts on this page came from
            </h2>
            <ul className="mt-5 flex flex-col gap-4">
              {c.facts.map((fact) => (
                <li key={fact.source} className="text-sm font-light leading-6 text-neutral-500">
                  {fact.claim}{' '}
                  <a
                    href={fact.source}
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                    className="break-words text-neutral-400 underline decoration-white/20 underline-offset-4 transition hover:text-white"
                  >
                    {fact.source}
                  </a>{' '}
                  <span className="whitespace-nowrap">(read {fact.verifiedOn})</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section width="prose" className="!py-12">
          <ChipRow label="Other comparisons:">
            {others.map((x) => (
              <ChipLink key={x.slug} href={`/comparisons/${x.slug}`}>
                {x.headline}
              </ChipLink>
            ))}
            <ChipLink href="/alternatives">How to evaluate an alternative</ChipLink>
          </ChipRow>
        </Section>

        <CtaSection
          title="Try Backenly free"
          body="One free project, kept permanently. No credit card."
        >
          <PrimaryButton href="/auth/signup">Get started free</PrimaryButton>
          <SecondaryButton href="/pricing">See pricing</SecondaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
