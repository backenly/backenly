import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import {
  ArrowLink,
  ButtonLink,
  ComparisonTable,
  Facts,
  GlyphList,
  HorizonClose,
  JsonLd,
  NextLinks,
  Page,
  PageHero,
  Section,
  SectionHead,
  SplitDecision,
  withCode,
} from '@/components/site/kit'
import { Faq } from '@/components/site/Faq'
import { Reveal } from '@/components/site/Reveal'
import { StartButton } from '@/components/site/StartButton'
import { HEADING, TITLE } from '@/components/site/tokens'
import { COMPARISONS, COMPARISON_LIST, type ComparisonData } from '../data'

const APP_URL = 'https://backenly.com'

export function generateStaticParams() {
  return COMPARISON_LIST.map((c) => ({ slug: c.slug }))
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
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
 * Backenly so the page cannot visually weight one over the other. The
 * competitor's column comes first, on the page as in the DOM.
 */
function StrengthColumn({ id, title, items }: { id: string; title: string; items: { title: string; body: string }[] }) {
  return (
    <div className="min-w-0">
      <h2 id={id} className={`text-[24px] text-white md:text-[30px] ${TITLE}`}>
        {title}
      </h2>
      <ul className="mt-8 flex flex-col">
        {items.map((item) => (
          <li key={item.title} className="border-t border-white/[0.08] py-6">
            <h3 className={`text-[17px] text-white ${HEADING}`}>{item.title}</h3>
            <p className="mt-2 max-w-[58ch] text-[15px] leading-[1.7] text-zinc-400 [text-wrap:pretty]">{withCode(item.body)}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A heading on the left, prose on the right: for the per-page narrative blocks. */
function Editorial({ id, heading, children }: { id: string; heading: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
      <Reveal>
        <h2 id={id} className={`max-w-[20ch] text-[24px] text-white [text-wrap:balance] md:text-[30px] ${TITLE}`}>
          {heading}
        </h2>
      </Reveal>
      <Reveal delay={0.06}>{children}</Reveal>
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
      { '@type': 'ListItem', position: 3, name: c.headline, item: `${APP_URL}/comparisons/${c.slug}` },
    ],
  }

  const others = COMPARISON_LIST.filter((x) => x.slug !== c.slug)
  const PROSE = 'max-w-[66ch] text-[17px] leading-[1.75] tracking-[-0.008em] text-zinc-400 [text-wrap:pretty]'

  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(faqSchema)} />
      <JsonLd json={safeJsonLd(breadcrumbSchema)} />
      <Page>
        <PageHero
          trail={[
            { label: 'Home', href: '/' },
            { label: 'Comparisons', href: '/comparisons' },
            { label: c.competitor },
          ]}
          title={c.headline}
          lede={c.intro}
          actions={
            <>
              <StartButton />
              <ButtonLink href="/pricing" variant="secondary">
                See pricing
              </ButtonLink>
            </>
          }
        />

        {/* The difference in one paragraph, set as the page's statement. */}
        <Section flush aria-labelledby="difference">
          <Reveal className="grid gap-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
            <h2 id="difference" className={`text-[22px] text-white md:text-[26px] ${TITLE}`}>
              The difference in one paragraph
            </h2>
            <p className="max-w-[60ch] text-[19px] leading-[1.65] tracking-[-0.016em] text-zinc-200 [text-wrap:pretty] md:text-[22px] md:leading-[1.55]">
              {withCode(c.summary)}
            </p>
          </Reveal>
        </Section>

        <Section aria-labelledby="shaped">
          <Reveal>
            <SectionHead id="shaped" title="How they are shaped" />
          </Reveal>
          <Reveal delay={0.06}>
            <Facts
              className="mt-12"
              items={c.architecture.map((section) => ({ title: section.heading, body: withCode(section.body) }))}
            />
          </Reveal>
        </Section>

        <Section aria-labelledby="capabilities">
          <Reveal>
            <SectionHead
              id="capabilities"
              title="Capability by capability"
              lede="The fourth column says what each difference costs or buys in practice, including when the honest answer is nothing."
            />
          </Reveal>
          <Reveal delay={0.06} className="mt-12">
            <ComparisonTable
              caption={`Backenly compared with ${c.competitor}, by capability`}
              competitor={c.competitor}
              rows={c.table}
            />
          </Reveal>
        </Section>

        {/* Competitor strengths first. Deliberately. */}
        <Section aria-label="Strengths on each side">
          <Reveal>
            <p className="max-w-[62ch] text-[17px] leading-[1.7] text-zinc-400">
              These are real advantages, not concessions written to look balanced. If one of them is
              decisive for you, it should decide it.
            </p>
          </Reveal>
          <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <StrengthColumn id="competitor-stronger" title={`Where ${c.competitor} is stronger`} items={c.competitorStrengths} />
            </Reveal>
            <Reveal delay={0.06}>
              <StrengthColumn id="backenly-stronger" title="Where Backenly is stronger" items={c.backenlyStrengths} />
            </Reveal>
          </div>
        </Section>

        {/* Operating model, only where it is the actual difference. */}
        {c.operating && (
          <Section aria-labelledby="operating">
            <Editorial id="operating" heading={c.operating.heading}>
              <p className={PROSE}>{withCode(c.operating.body)}</p>
            </Editorial>
          </Section>
        )}

        {/* Agent workflow, only where the two genuinely diverge. */}
        {c.agents && (
          <Section aria-labelledby="agents">
            <Editorial id="agents" heading={c.agents.heading}>
              <p className={PROSE}>{withCode(c.agents.body)}</p>
            </Editorial>
          </Section>
        )}

        {/* Migration and adoption. The limits are not optional. */}
        {c.migration && (
          <Section aria-labelledby="migration">
            <Editorial id="migration" heading={c.migration.heading}>
              <p className={PROSE}>{withCode(c.migration.body)}</p>
              <h3 className={`mt-10 text-[17px] text-white ${HEADING}`}>What stays your work</h3>
              <GlyphList className="mt-5 max-w-[66ch]" glyph="dash" items={c.migration.limits.map(withCode)} />
              {c.migration.link && (
                <ArrowLink href={c.migration.link.href} className="mt-9">
                  {c.migration.link.label}
                </ArrowLink>
              )}
            </Editorial>
          </Section>
        )}

        <Section aria-label="Which one to pick">
          <Reveal>
            <SplitDecision
              heading="Which one to pick"
              competitor={c.competitor}
              chooseCompetitor={c.chooseCompetitorWhen}
              chooseBackenly={c.chooseBackenlyWhen}
            />
          </Reveal>
        </Section>

        <Section aria-labelledby="comparison-faq">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
            <Reveal className="lg:sticky lg:top-28 lg:self-start">
              <SectionHead id="comparison-faq" title="Common questions" />
            </Reveal>
            <Reveal delay={0.06}>
              <Faq items={c.faq} />
            </Reveal>
          </div>
        </Section>

        {/*
         * Sourcing. Every checkable statement about the competitor on this page
         * carries the URL it came from and the date it was read, because
         * competitor pricing and capabilities move and an undated claim is one
         * nobody can audit later.
         */}
        {c.facts.length > 0 && (
          <Section aria-labelledby="sources">
            <Reveal className="grid gap-8 border-t border-white/[0.08] pt-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
              <h2 id="sources" className={`max-w-[24ch] text-[18px] text-white ${HEADING}`}>
                Where the {c.competitor} facts on this page came from
              </h2>
              <ul className="flex flex-col gap-4">
                {c.facts.map((fact) => (
                  <li key={fact.source} className="max-w-[80ch] text-[14px] leading-[1.65] text-zinc-500">
                    {fact.claim}{' '}
                    <a
                      href={fact.source}
                      rel="noopener noreferrer nofollow"
                      target="_blank"
                      className="break-words text-zinc-400 underline decoration-white/20 underline-offset-4 transition-colors duration-200 hover:text-white"
                    >
                      {fact.source}
                    </a>{' '}
                    <span className="whitespace-nowrap">(read {fact.verifiedOn})</span>
                  </li>
                ))}
              </ul>
            </Reveal>
          </Section>
        )}

        <Section aria-labelledby="other-comparisons">
          <Reveal>
            <h2 id="other-comparisons" className={`text-[22px] text-white md:text-[26px] ${TITLE}`}>
              Other comparisons
            </h2>
            <NextLinks
              className="mt-8"
              items={[
                ...others.map((x) => ({ href: `/comparisons/${x.slug}`, meta: x.category, title: x.headline })),
                { href: '/alternatives', meta: 'Before a shortlist', title: 'How to evaluate an alternative' },
              ]}
            />
          </Reveal>
        </Section>

        <HorizonClose title="Try Backenly free" lede="One free project, kept permanently. No credit card.">
          <StartButton />
          <ButtonLink href="/pricing" variant="secondary">
            See pricing
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
