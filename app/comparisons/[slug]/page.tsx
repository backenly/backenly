import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowRight, ArrowRightLeft, ChevronRight, Signpost } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { SiteShell } from '@/components/site/SiteShell'
import { Box, BoxHead, BoxLink, Pane, Panes } from '@/components/landing-v8/Box'
import {
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
import { TEXT_LINK, TITLE } from '@/components/site/tokens'
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

   2026-10-23 (founders: match the landing and the rest of the site): the
   header takes the feature pages' two actions, the questions take the
   landing FAQ's own header (a line and two links under the title), and every
   card under "More comparisons" says what is on the other side of it.

   2026-11-15 (site-wide pass, to match the v8 landing): the three points sit
   in one joined strip, the choice and the move are the landing's lit boxes,
   and the table is even-handed (no violet wash on Backenly's column; both
   sides of the choice are set alike, the other option first). Plain class
   strings are restated here rather than imported, because a string exported
   from a client module would arrive in this server page as a client
   reference.
───────────────────────────────────────────────────────────── */

/** The landing bento's fact chip. */
const CHIP =
  'inline-flex items-center rounded-[6px] border border-white/[0.08] bg-white/[0.03] px-[10px] py-[5px] text-[13px] text-zinc-300'

/**
 * The landing FAQ's two links. Literal here: SiteShell's ROUTES is a client
 * module's export, and a server page that imports it receives a client
 * reference rather than the string. Keep them equal to ROUTES.docs and
 * ROUTES.founder.
 */
const DOCS_HREF = '/docs/connect'
const FOUNDERS_HREF = 'https://calendly.com/adarsh-c-jose/30min'

/** The gap between a section title and its first cell. */
const BODY_GAP = 'mt-[40px] md:mt-[56px]'

export function generateStaticParams() {
  return COMPARISON_LIST.map((c) => ({ slug: c.slug }))
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params
  const c = COMPARISONS[params.slug]
  if (!c) return { title: 'Not Found' }

  // Every comparison title leads with "Backenly vs", so the template's suffix
  // would only repeat the brand.
  return pageMetadata({
    title: c.metaTitle,
    brandInTitle: true,
    description: c.metaDescription,
    path: `/comparisons/${c.slug}`,
    type: 'article',
  })
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
    <SiteShell footerLit>
      <JsonLd json={safeJsonLd(faqSchema)} />
      <JsonLd json={safeJsonLd(breadcrumbSchema)} />
      <Page>
        <PageHero
          readableTrail
          trail={[
            { label: 'Home', href: '/' },
            { label: 'Comparisons', href: '/comparisons' },
            { label: c.competitor },
          ]}
          title={c.headline}
          lede={c.intro}
          rule={false}
          actions={
            <>
              <StartButton />
              <ButtonLink href="/comparisons" variant="secondary">
                All comparisons
              </ButtonLink>
            </>
          }
        />

        {/* The difference in three short points, before any detail: one joined strip, set like the landing's cells. */}
        <Section flush aria-labelledby="at-a-glance">
          <h2 id="at-a-glance" className="sr-only">
            At a glance
          </h2>
          <ul className="grid gap-px overflow-hidden rounded-[10px] border border-white/[0.10] bg-white/[0.08] lg:grid-cols-3">
            {c.architecture.map((point) => (
              <li key={point.heading} className="min-w-0 bg-[#0b0c0f] p-[24px] lg:p-[28px]">
                <h3 className="text-[16px] font-medium tracking-[-0.012em] text-white">{point.heading}</h3>
                <p className="mt-[12px] text-[15px] leading-[1.6] text-zinc-400 [text-wrap:pretty]">{point.body}</p>
              </li>
            ))}
          </ul>
        </Section>

        <Section aria-labelledby="side-by-side">
          <SectionHead id="side-by-side" title="Side by side" lede="What changes in practice, capability by capability." />
          <div className={BODY_GAP}>
            <ComparisonTable
              caption={`Backenly compared with ${name}, by capability`}
              competitor={c.competitor}
              rows={c.table}
            />
          </div>
          {c.facts.length > 0 && <Sources competitor={c.competitor} facts={c.facts} />}
        </Section>

        {/* The choice, even-handed: the other option first, both sides set alike. */}
        <Box id="which-to-pick" light={{ art: 'c' }}>
          <BoxHead id="which-to-pick" layout="stacked" tag={{ icon: Signpost, label: 'Choosing' }} title="Which one to pick" body={c.summary} />
          <Panes>
            <Pane title={`Choose ${name} when`}>
              <GlyphList items={c.chooseCompetitorWhen} />
            </Pane>
            <Pane title="Choose Backenly when">
              <GlyphList items={c.chooseBackenlyWhen} />
            </Pane>
          </Panes>
        </Box>

        {/* Moving across. What stays the reader's work is never softened. */}
        {c.migration && (
          <Box id="moving" light={{ art: 'c', flip: true }}>
            <BoxHead
              id="moving"
              tag={{ icon: ArrowRightLeft, label: 'Moving' }}
              title={c.migration.heading}
              body={c.migration.body}
              extra={c.migration.link && <BoxLink href={c.migration.link.href}>{c.migration.link.label}</BoxLink>}
              visual={
                <div className="min-w-0 rounded-[8px] border border-white/[0.07] bg-[#0a0a0d] p-[20px] sm:p-[28px]">
                  {c.migration.carries && (
                    <div className="mb-[24px] border-b border-white/[0.07] pb-[24px]">
                      <h3 className="text-[15px] font-medium text-white">What carries over</h3>
                      <ul className="mt-[14px] flex flex-wrap gap-[6px]">
                        {c.migration.carries.map((item) => (
                          <li key={item} className={CHIP}>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <h3 className="text-[15px] font-medium text-white">What stays your work</h3>
                  <GlyphList glyph="dash" items={c.migration.limits} className="mt-[14px]" />
                </div>
              }
            />
          </Box>
        )}

        <Section aria-labelledby="comparison-faq">
          <div className="grid gap-[40px] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-[64px]">
            <div className="lg:sticky lg:top-[112px] lg:self-start">
              <SectionHead id="comparison-faq" title="Common questions" />
              {/* The landing FAQ's own close to the header. */}
              <p className="mt-5 max-w-[36ch] text-[15px] leading-[1.7] text-zinc-400">
                Anything else, ask the people who built it.
              </p>
              <div className="mt-7 flex flex-wrap gap-x-6 gap-y-3">
                <Link href={DOCS_HREF} className={TEXT_LINK}>
                  Read the docs
                  <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </Link>
                <a href={FOUNDERS_HREF} target="_blank" rel="noopener noreferrer" className={TEXT_LINK}>
                  Book 30 minutes
                  <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </a>
              </div>
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
              ...others.map((x) => ({
                href: `/comparisons/${x.slug}`,
                meta: x.category,
                title: x.headline,
                body: x.positioning,
              })),
              {
                href: '/alternatives',
                meta: 'Before a shortlist',
                title: 'How to evaluate an alternative',
                body: 'Six questions to ask any platform, and when to stay where you are.',
              },
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
      <summary className="inline-flex cursor-pointer list-none items-center gap-[6px] rounded-sm text-[14px] text-zinc-400 transition-colors duration-200 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="h-[14px] w-[14px] transition-transform duration-200 group-open/sources:rotate-90"
        />
        Where the {competitor} facts on this page come from
      </summary>
      <ul className="mt-[14px] flex max-w-[84ch] flex-col gap-[10px] pl-[20px]">
        {facts.map((fact) => (
          <li key={fact.source} className="text-[13px] leading-[1.65] text-zinc-400 [text-wrap:pretty]">
            {fact.claim}{' '}
            <a
              href={fact.source}
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="break-words text-zinc-300 underline decoration-white/20 underline-offset-4 transition-colors duration-200 hover:text-white"
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
