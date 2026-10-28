import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { SiteShell } from '@/components/site/SiteShell'
import { BentoCell, CellBody, CellTitle } from '@/components/landing-v7/shared'
import { ButtonLink, HorizonClose, JsonLd, Page, PageHero, Section } from '@/components/site/kit'
import { StartButton } from '@/components/site/StartButton'
import { CRITERIA } from '../alternatives/data'
import { COMPARISON_LIST } from './data'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = pageMetadata({
  title: 'Backenly comparisons: Supabase, Firebase and more',
  brandInTitle: true,
  description:
    'How Backenly compares with Supabase, Firebase, no-code app builders and building your own backend, including when the other option is the better choice.',
  path: '/comparisons',
  social: {
    title: 'Backenly comparisons',
    description: 'How Backenly differs from Supabase, Firebase, app builders, and building it yourself.',
  },
})

/* ─────────────────────────────────────────────────────────────
   /comparisons (2026-10-15, founders: "no jargon, no lots of text, no big
   banners, clean and professional").

   One job: pick a comparison. A short header, then the landing's bento
   (components/landing-v7/PrimitivesV7.tsx) with its own parts, so the page
   reads like the rest of the site (2026-10-23, founders: match the landing):
   one cell per comparison with the landing's cell title and body, its
   category as the landing's fact chip, and the whole cell as the link. The
   guide for readers earlier than a shortlist closes the grid as a wide cell,
   set like the landing's lead cell: words on the left, its six questions
   beside them.
───────────────────────────────────────────────────────────── */

/** The landing bento's fact chip (PrimitivesV7), restated: strings from its client module arrive here as client references. */
const CHIP = 'rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[12.5px] text-zinc-300'

/** The cell's call to action: the landing's text link, as a label (the cell is the link). */
const ACTION =
  'inline-flex items-center gap-1.5 text-[15px] font-medium tracking-[-0.006em] text-zinc-300 transition-colors duration-200 group-hover:text-white'

/** The link's box covers the whole cell, so the cell is the target. */
const CELL_LINK =
  'after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-violet-300'

export default function ComparisonsPage() {
  /**
   * An ItemList of exactly the cards rendered below. No product, offer, or
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
          readableTrail
          trail={[{ label: 'Home', href: '/' }, { label: 'Comparisons' }]}
          title="Comparisons"
          lede="How Backenly compares with the main alternatives, including when to pick them instead."
        />

        <Section flush aria-labelledby="all-comparisons">
          {/* The cells' titles are the landing's h3s, so the grid takes the h2. */}
          <h2 id="all-comparisons" className="sr-only">
            All comparisons
          </h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {COMPARISON_LIST.map((c, i) => (
              // An odd count leaves the last comparison alone in its row; it takes the
              // row's full width, like the guide card below it, rather than half of it.
              <li
                key={c.slug}
                className={`min-w-0 ${COMPARISON_LIST.length % 2 === 1 && i === COMPARISON_LIST.length - 1 ? 'md:col-span-2' : ''}`}
              >
                <BentoCell className="h-full">
                  <CellTitle>
                    <Link href={`/comparisons/${c.slug}`} className={CELL_LINK}>
                      {c.headline}
                    </Link>
                  </CellTitle>
                  <CellBody>{c.positioning}</CellBody>
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-x-6 gap-y-4 pt-8">
                    <span className={CHIP}>{c.category}</span>
                    <span aria-hidden className={ACTION}>
                      Read the comparison
                      <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </BentoCell>
              </li>
            ))}

            {/* The guide, wide: the landing's lead-cell layout, words beside the six questions it asks. */}
            <li className="min-w-0 md:col-span-2">
              <BentoCell className="h-full">
                <div className="grid h-full gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
                  <div className="flex h-full flex-col">
                    <CellTitle>
                      <Link href="/alternatives" className={CELL_LINK}>
                        Choosing a backend platform
                      </Link>
                    </CellTitle>
                    <CellBody>
                      Six questions to ask any platform, this one included, and when to stay where you are.
                    </CellBody>
                    <div className="mt-auto flex flex-wrap items-center gap-x-6 gap-y-4 pt-8">
                      <span className={CHIP}>A guide for before you have a shortlist</span>
                      <span aria-hidden className={ACTION}>
                        Read the guide
                        <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                      </span>
                    </div>
                  </div>
                  <ol aria-label="The six questions" className="border-t border-white/[0.08] lg:border-t-0">
                    {CRITERIA.map((criterion) => (
                      <li
                        key={criterion.question}
                        className="border-b border-white/[0.08] py-[11px] text-[14px] leading-[1.55] text-zinc-300 [text-wrap:pretty] lg:first:border-t"
                      >
                        {criterion.question}
                      </li>
                    ))}
                  </ol>
                </div>
              </BentoCell>
            </li>
          </ul>
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
