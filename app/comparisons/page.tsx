import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { BentoCell } from '@/components/landing-v7/shared'
import { ArrowLink, ButtonLink, HorizonClose, JsonLd, Page, PageHero, Section } from '@/components/site/kit'
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

/* ─────────────────────────────────────────────────────────────
   /comparisons (2026-10-15, founders: "no jargon, no lots of text, no big
   banners, clean and professional").

   One job: pick a comparison. A short header, then one bento cell per
   comparison: the name, its category as a chip, one line, and the whole cell
   is the link. The essay on what is different is gone; each comparison page
   says it in its own table.
───────────────────────────────────────────────────────────── */

/** The landing bento's fact chip, restated: strings from its client module arrive here as client references. */
const CHIP =
  'inline-flex items-center rounded-[6px] border border-white/[0.08] bg-white/[0.03] px-[10px] py-[5px] text-[13px] text-zinc-300'

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
          trail={[{ label: 'Home', href: '/' }, { label: 'Comparisons' }]}
          title="Comparisons"
          lede="How Backenly compares with the main alternatives, including when to pick them instead."
        />

        <Section flush aria-label="Comparisons">
          <ul className="grid gap-[12px] md:grid-cols-2">
            {COMPARISON_LIST.map((c) => (
              <li key={c.slug} className="min-w-0">
                <BentoCell bare className="h-full">
                  <div className="flex h-full flex-col p-[20px] md:p-[26px]">
                    <h2 className={`text-white ${TITLE}`}>
                      {/* The link's box covers the whole cell, so the cell is the target. */}
                      <Link
                        href={`/comparisons/${c.slug}`}
                        className="block after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-violet-300"
                      >
                        <span className="block text-[14px] font-normal tracking-[-0.006em] text-zinc-500">Backenly vs.</span>{' '}
                        <span className="mt-[6px] block text-[28px] md:text-[32px]">{c.competitor}</span>
                      </Link>
                    </h2>
                    <span className={`mt-[16px] self-start ${CHIP}`}>{c.category}</span>
                    <p className="mt-[20px] max-w-[46ch] flex-1 text-[15px] leading-[1.7] tracking-[-0.004em] text-zinc-400 [text-wrap:pretty]">
                      {c.positioning}
                    </p>
                    <span
                      aria-hidden
                      className="mt-[28px] inline-flex items-center gap-[6px] self-start text-[14px] font-medium text-zinc-300 transition-colors duration-200 group-hover:text-white"
                    >
                      Read the comparison
                      <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </BentoCell>
              </li>
            ))}
          </ul>

          <ArrowLink href="/alternatives" className="mt-[28px]">
            How to evaluate an alternative, and when to stay
          </ArrowLink>
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
