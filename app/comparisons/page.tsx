import type { Metadata } from 'next'
import { Bot, Code2, Database, Flame, LayoutTemplate, ListChecks, Scale, type LucideIcon } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { SiteShell } from '@/components/site/SiteShell'
import { Box, BoxHead, Cells } from '@/components/landing-v8/Box'
import { ButtonLink, HorizonClose, JsonLd, Page, PageHero } from '@/components/site/kit'
import { StartButton } from '@/components/site/StartButton'
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

   One job: pick a comparison. A short header, then one lit box in the v8
   landing's grammar (site-wide pass, 2026-11-15): a cell per comparison with
   its one-line difference, its category and a link, and the guide for readers
   earlier than a shortlist as the sixth cell, so the grid closes 3 + 3.
───────────────────────────────────────────────────────────── */

/** One icon per comparison, for the cell's title row. */
const ICONS: Record<string, LucideIcon> = {
  'backenly-vs-supabase': Database,
  'backenly-vs-firebase': Flame,
  'backenly-vs-insforge': Bot,
  'backenly-vs-no-code-builders': LayoutTemplate,
  'backenly-vs-traditional-backend-development': Code2,
}

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
    <SiteShell footerLit>
      <JsonLd json={safeJsonLd(itemListSchema)} />
      <Page>
        <PageHero
          readableTrail
          trail={[{ label: 'Home', href: '/' }, { label: 'Comparisons' }]}
          title="Comparisons"
          lede="How Backenly compares with the main alternatives, including when to pick them instead."
          rule={false}
        />

        {/* One lit box in the landing's grammar: each comparison is a cell with its one-line difference and its category. */}
        <Box id="all-comparisons" light={{ art: 'a' }} className="!pt-[8px] md:!pt-[16px]">
          <BoxHead
            id="all-comparisons"
            layout="stacked"
            tag={{ icon: Scale, label: 'Side by side' }}
            title="Pick a comparison"
            body="Each one says plainly when the other option is the better choice."
          />
          <Cells
            cols={3}
            items={[
              ...COMPARISON_LIST.map((c) => ({
                icon: ICONS[c.slug] ?? Scale,
                title: c.headline,
                body: c.positioning,
                list: <p className="text-[13px] text-faint">{c.category}</p>,
                href: `/comparisons/${c.slug}`,
                link: 'Read the comparison',
              })),
              {
                icon: ListChecks,
                title: 'Choosing a backend platform',
                body: 'Six questions to ask any platform, this one included, and when to stay where you are.',
                list: <p className="text-[13px] text-faint">Before you have a shortlist</p>,
                href: '/alternatives',
                link: 'Read the guide',
              },
            ]}
          />
        </Box>

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
