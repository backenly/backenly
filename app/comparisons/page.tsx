import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { ButtonLink, HorizonClose, JsonLd, NextLinks, Page, PageHero, Section, SectionHead } from '@/components/site/kit'
import { Reveal } from '@/components/site/Reveal'
import { SpotlightPanel } from '@/components/site/SpotlightPanel'
import { StartButton } from '@/components/site/StartButton'
import { TITLE } from '@/components/site/tokens'
import { COMPARISON_LIST } from './data'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Backenly comparisons: how it differs from other backend platforms',
  description:
    'Four comparisons against Supabase, Firebase, integrated app builders, and building a backend yourself. Each one says where the other option is the better choice.',
  keywords: [
    'Backenly vs Supabase',
    'Backenly vs Firebase',
    'backend platform comparison',
    'Postgres backend platform',
  ],
  openGraph: {
    title: 'Backenly comparisons: how it differs from other backend platforms',
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

/** "Backenly vs. no-code app builders" -> "No-code app builders". */
function opponent(headline: string) {
  const name = headline.replace(/^Backenly vs\.\s*/, '')
  return name.charAt(0).toUpperCase() + name.slice(1)
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
      <JsonLd json={safeJsonLd(itemListSchema)} />
      <Page>
        <PageHero
          trail={[{ label: 'Home', href: '/' }, { label: 'Comparisons' }]}
          title="How Backenly differs from other backend platforms"
          lede="Four comparisons, each written to be useful to someone who might not pick us. Every page says where the other option is stronger."
          actions={
            <>
              <StartButton />
              <ButtonLink href="/alternatives" variant="secondary">
                How to evaluate an alternative
              </ButtonLink>
            </>
          }
        />

        <Section flush aria-label="Comparison pages">
          <ul className="grid gap-3 md:grid-cols-2">
            {COMPARISON_LIST.map((c, index) => (
              <Reveal as="li" key={c.slug} delay={(index % 2) * 0.06} className="h-full">
                <SpotlightPanel className="h-full">
                  <Link
                    href={`/comparisons/${c.slug}`}
                    className="group flex h-full flex-col p-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 md:p-9"
                  >
                    <span className="text-[14px] text-zinc-500">Backenly vs.</span>
                    <span className={`mt-2 block text-[32px] text-white md:text-[40px] ${TITLE}`}>{opponent(c.headline)}</span>
                    <span className="mt-2 block text-[14px] text-zinc-500">{c.category}</span>
                    <span className="mt-8 block max-w-[52ch] flex-1 text-[16px] leading-[1.7] text-zinc-400 [text-wrap:pretty]">
                      {c.positioning}
                    </span>
                    <span className="mt-8 inline-flex items-center gap-1.5 text-[15px] font-medium text-zinc-300 transition-colors duration-200 group-hover:text-white">
                      Read the comparison
                      <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                </SpotlightPanel>
              </Reveal>
            ))}
          </ul>
        </Section>

        <Section aria-labelledby="actually-different">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
            <Reveal>
              <SectionHead id="actually-different" title="What is actually different" />
            </Reveal>
            <Reveal delay={0.06} className="flex max-w-[68ch] flex-col gap-6 text-[17px] leading-[1.75] tracking-[-0.008em] text-zinc-400 [text-wrap:pretty]">
              <p>
                Backenly is a backend platform on PostgreSQL: a database, a REST API, authentication,
                file storage, realtime and functions. That list is fairly ordinary for this category,
                and it is not where the difference is.
              </p>
              <p className="text-zinc-200">
                The difference is what happens around those parts. Structural changes go through one
                audited path that records what changed and takes a restore point before
                schema-touching work. Destructive operations stop for human approval rather than
                executing on request. A loop reconciles the running backend against a set of declared
                invariants on a schedule, repairing a narrow class of problems automatically and
                reporting the rest with their evidence.
              </p>
              <p>
                That is a trade rather than an upgrade. It suits a team that would rather not own
                migrations, policy review and incident response. It suits a team that wants direct
                control over all three considerably less well. The pages above are written on that
                basis.
              </p>
            </Reveal>
          </div>
        </Section>

        <Section aria-labelledby="earlier-than-that">
          <Reveal>
            <SectionHead
              id="earlier-than-that"
              title="Not sure what you are comparing against?"
              lede="These pages assume a shortlist. If you are earlier than that, deciding whether to move at all, start with the criteria that decide it, where Backenly does not fit, and when the right answer is to stay where you are."
            />
          </Reveal>
          <Reveal delay={0.06}>
            <NextLinks
              className="mt-10"
              items={[
                { href: '/alternatives', title: 'How to evaluate an alternative', body: 'The six questions that decide it, and who should not switch.' },
                { href: '/use-cases', title: 'Use cases', body: 'Five workflows, with what Backenly does and what stays yours.' },
                { href: '/features', title: 'Every feature', body: 'The whole product, capability by capability.' },
                { href: '/pricing', title: 'Pricing', body: 'Free, Pro at $25 a month, and Enterprise.' },
              ]}
            />
          </Reveal>
        </Section>

        <HorizonClose title="Try Backenly yourself" lede="One free project, kept permanently. No credit card.">
          <StartButton />
          <ButtonLink href="/pricing" variant="secondary">
            See pricing
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
