import { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import {
  InlineArrow,
  PageHero,
  PrimaryButton,
  SecondaryButton,
  Section,
  SectionHeading,
  Lead,
  LinkCard,
  Tag,
  CtaSection,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'
import { COMPARISON_LIST } from './data'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Backenly comparisons — how it differs from other backend platforms',
  description:
    'Four comparisons against Supabase, Firebase, integrated app builders, and building a backend yourself. Each one says where the other option is the better choice.',
  keywords: [
    'Backenly vs Supabase',
    'Backenly vs Firebase',
    'backend platform comparison',
    'Postgres backend platform',
  ],
  openGraph: {
    title: 'Backenly comparisons — how it differs from other backend platforms',
    description:
      'Comparisons against Supabase, Firebase, integrated app builders, and building it yourself. Each one says where the other option wins.',
    url: `${APP_URL}/comparisons`,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly comparisons',
    description: 'How Backenly differs from Supabase, Firebase, app builders, and building it yourself.',
  },
  alternates: { canonical: `${APP_URL}/comparisons` },
}

export default function ComparisonsPage() {
  /**
   * An ItemList of exactly the four cards rendered below. No product, offer, or
   * rating schema: none of it would correspond to anything on this page.
   */
  const itemListSchema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Backenly comparisons',
    itemListElement: COMPARISON_LIST.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.headline,
      url: `${APP_URL}/comparisons/${c.slug}`,
    })),
  }

  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListSchema) }}
      />
      <main className="relative z-20">
        <PageHero
          align="center"
          eyebrow="Comparisons"
          title="How Backenly differs from other backend platforms"
          subtitle="Four comparisons, each one written to be useful to someone who might not pick us. Every page says where the other option is stronger."
          actions={
            <PrimaryButton href="/auth/signup">
              Try Backenly free
              <InlineArrow />
            </PrimaryButton>
          }
        />

        <Section width="prose" className="!pt-0">
          <SectionHeading className="!text-xl mb-4">What is actually different</SectionHeading>
          <Lead className="mb-4">
            Backenly is a backend platform on PostgreSQL: a database, a REST API, authentication,
            file storage, realtime, and functions. That list is fairly ordinary for this category,
            and it is not where the difference is.
          </Lead>
          <Lead className="mb-4">
            The difference is what happens around those parts. Structural changes go through one
            audited path that records what changed and takes a restore point before schema-touching
            work. Destructive operations stop for human approval rather than executing on request.
            A loop reconciles the running backend against a set of declared invariants on a
            schedule, repairing a narrow class of problems automatically and reporting the rest with
            their evidence.
          </Lead>
          <Lead>
            That is a trade rather than an upgrade. It suits a team that would rather not own
            migrations, policy review, and incident response. It suits a team that wants direct
            control over all three considerably less well. The pages below are written on that
            basis.
          </Lead>
        </Section>

        <Section aria-label="Comparison pages" width="wide-prose">
          <SectionHeading className="mb-8">Pick a comparison</SectionHeading>
          <div className="grid gap-6 sm:grid-cols-2">
            {COMPARISON_LIST.map((c) => (
              <LinkCard key={c.slug} href={`/comparisons/${c.slug}`}>
                <h3 className="mb-3 text-lg font-normal tracking-tight text-white">{c.headline}</h3>
                <p className="flex-1 text-sm font-light leading-relaxed text-neutral-400">
                  {c.positioning}
                </p>
                <div className="mt-5">
                  <Tag>{c.category}</Tag>
                </div>
              </LinkCard>
            ))}
          </div>
        </Section>

        <Section width="prose">
          <SectionHeading className="!text-xl mb-4">
            Not sure which one you are comparing against?
          </SectionHeading>
          <Lead className="mb-6">
            These pages assume you already have a shortlist. If you are earlier than that — working
            out whether to move at all, or what to weigh — the alternatives page covers the criteria
            that decide it, where Backenly does not fit, and when the right answer is to stay where
            you are.
          </Lead>
          <SecondaryButton href="/alternatives">
            How to evaluate an alternative
            <InlineArrow />
          </SecondaryButton>
        </Section>

        <Section width="prose" className="!py-12">
          <ChipRow label="Related:">
            {[
              { href: '/features', label: 'All features' },
              { href: '/use-cases', label: 'Use cases' },
              { href: '/resources', label: 'Documentation' },
              { href: '/pricing', label: 'Pricing' },
            ].map((link) => (
              <ChipLink key={link.href} href={link.href}>
                {link.label}
              </ChipLink>
            ))}
          </ChipRow>
        </Section>

        <CtaSection
          title="Try Backenly yourself"
          body="One free project, kept permanently. No credit card."
        >
          <PrimaryButton href="/auth/signup">Get started free</PrimaryButton>
          <SecondaryButton href="/pricing">See pricing</SecondaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
