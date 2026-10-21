import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { BentoCell, CellBody, CellTitle } from '@/components/landing-v7/shared'
import {
  ArrowLink,
  ButtonLink,
  ComparisonTable,
  GlyphList,
  HorizonClose,
  JsonLd,
  NextLinks,
  Page,
  PageHero,
  Section,
  SectionHead,
} from '@/components/site/kit'
import { Faq } from '@/components/site/Faq'
import { StartButton } from '@/components/site/StartButton'
import { TITLE } from '@/components/site/tokens'
import { COMPARISONS, COMPARISON_LIST, type ComparisonData, type ExternalFact } from '../data'

const APP_URL = 'https://backenly.com'

/* ─────────────────────────────────────────────────────────────
   /comparisons/<slug> (2026-10-15, founders: "no jargon, no lots of text, no
   big banners, clean and professional").

   One job: an honest side by side. The page reads top to bottom as three
   short points, the table, which one to pick, what moving costs, and a short
   FAQ. The essays that sat between those blocks are gone; the table carries
   the detail, and every cell is one plain line.

   The competitor comes first wherever the two sit side by side, on the page
   as in the DOM. Violet marks only Backenly's own column and cell.

   The bento cells and fact chips are the landing's (components/landing-v7).
   Plain class strings are restated here rather than imported, because a
   string exported from that client module would arrive in this server page
   as a client reference.
───────────────────────────────────────────────────────────── */

/** The landing bento's fact chip. */
const CHIP =
  'inline-flex items-center rounded-[6px] border border-white/[0.08] bg-white/[0.03] px-[10px] py-[5px] text-[13px] text-zinc-300'

/** The gap between a section title and its first cell. */
const BODY_GAP = 'mt-[40px] md:mt-[56px]'

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

export default async function ComparisonSlugPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params
  const c: ComparisonData | undefined = COMPARISONS[params.slug]
  if (!c) notFound()

  /** The competitor mid-sentence: "Choose no-code app builders when". */
  const name = c.nameInSentence ?? c.competitor

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
        />

        {/* The difference in three short points, before any detail. */}
        <Section flush aria-labelledby="at-a-glance">
          <h2 id="at-a-glance" className="sr-only">
            At a glance
          </h2>
          <div className="grid gap-[12px] lg:grid-cols-3">
            {c.architecture.map((point) => (
              <BentoCell key={point.heading}>
                <CellTitle>{point.heading}</CellTitle>
                <CellBody>{point.body}</CellBody>
              </BentoCell>
            ))}
          </div>
        </Section>

        <Section aria-labelledby="side-by-side">
          <SectionHead
            id="side-by-side"
            title={
              <>
                Side by side. <span className="text-zinc-500">What changes in practice.</span>
              </>
            }
          />
          <div className={BODY_GAP}>
            <ComparisonTable
              caption={`Backenly compared with ${name}, by capability`}
              competitor={c.competitor}
              rows={c.table}
            />
          </div>
          {c.facts.length > 0 && <Sources competitor={c.competitor} facts={c.facts} />}
        </Section>

        <Section aria-labelledby="which-to-pick">
          <SectionHead id="which-to-pick" title="Which one to pick" lede={c.summary} />
          <div className={`${BODY_GAP} grid gap-[12px] md:grid-cols-2`}>
            <BentoCell>
              <CellTitle>Choose {name} when</CellTitle>
              <GlyphList glyph="dash" items={c.chooseCompetitorWhen} className="mt-[20px]" />
            </BentoCell>
            <BentoCell bare>
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.7),transparent)]"
              />
              <div className="p-[20px] md:p-[26px]">
                <CellTitle>Choose Backenly when</CellTitle>
                <GlyphList glyph="check" items={c.chooseBackenlyWhen} className="mt-[20px]" />
              </div>
            </BentoCell>
          </div>
        </Section>

        {/* Moving across. What stays the reader's work is never softened. */}
        {c.migration && (
          <Section aria-labelledby="moving">
            <div className="grid gap-[40px] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-[64px]">
              <div>
                <SectionHead id="moving" title={c.migration.heading} lede={c.migration.body} />
                {c.migration.link && (
                  <ArrowLink href={c.migration.link.href} className="mt-[24px]">
                    {c.migration.link.label}
                  </ArrowLink>
                )}
              </div>
              <BentoCell>
                {c.migration.carries && (
                  <div className="mb-[28px] border-b border-white/[0.07] pb-[28px]">
                    <CellTitle>What carries over</CellTitle>
                    <ul className="mt-[16px] flex flex-wrap gap-[6px]">
                      {c.migration.carries.map((item) => (
                        <li key={item} className={CHIP}>
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <CellTitle>What stays your work</CellTitle>
                <GlyphList glyph="dash" items={c.migration.limits} className="mt-[16px]" />
              </BentoCell>
            </div>
          </Section>
        )}

        <Section aria-labelledby="comparison-faq">
          <div className="grid gap-[40px] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-[64px]">
            <div className="lg:sticky lg:top-[112px] lg:self-start">
              <SectionHead id="comparison-faq" title="Common questions" />
            </div>
            <Faq items={c.faq} />
          </div>
        </Section>

        <Section aria-labelledby="more-comparisons">
          <h2 id="more-comparisons" className={`text-[22px] text-white md:text-[26px] ${TITLE}`}>
            More comparisons
          </h2>
          <NextLinks
            className="mt-[28px]"
            items={[
              ...others.map((x) => ({ href: `/comparisons/${x.slug}`, meta: x.category, title: x.headline })),
              { href: '/alternatives', meta: 'Before a shortlist', title: 'How to evaluate an alternative' },
            ]}
          />
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

/**
 * Where the competitor facts came from: each claim, its official URL and the
 * date it was read, under the table they support. Closed by default so the
 * page stays short; native <details>, so it needs no client code.
 */
function Sources({ competitor, facts }: { competitor: string; facts: ExternalFact[] }) {
  return (
    <details className="group/sources mt-[20px]">
      <summary className="inline-flex cursor-pointer list-none items-center gap-[6px] rounded-sm text-[14px] text-zinc-500 transition-colors duration-200 hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="h-[14px] w-[14px] transition-transform duration-200 group-open/sources:rotate-90"
        />
        Where the {competitor} facts on this page come from
      </summary>
      <ul className="mt-[14px] flex max-w-[84ch] flex-col gap-[10px] pl-[20px]">
        {facts.map((fact) => (
          <li key={fact.source} className="text-[13px] leading-[1.65] text-zinc-500 [text-wrap:pretty]">
            {fact.claim}{' '}
            <a
              href={fact.source}
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="break-words text-zinc-400 underline decoration-white/20 underline-offset-4 transition-colors duration-200 hover:text-white"
            >
              {fact.source.replace(/^https:\/\//, '')}
            </a>{' '}
            <span className="whitespace-nowrap">(read {fact.verifiedOn})</span>
          </li>
        ))}
      </ul>
    </details>
  )
}
