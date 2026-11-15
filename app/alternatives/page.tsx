import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, ArrowRightLeft, Ban, Check, ListChecks, Minus } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { SiteShell } from '@/components/site/SiteShell'
import { Box, BoxHead, BoxLink, Cells, Pane, Panes } from '@/components/landing-v8/Box'
import {
  ButtonLink,
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
import { COMPARISON_LIST } from '../comparisons/data'
import { CRITERIA, DO_NOT_SWITCH, FAQ, NOT_FOR, SWITCHING_COSTS } from './data'

export const metadata: Metadata = pageMetadata({
  title: 'How to choose a backend platform and when to stay',
  description:
    'Six questions that decide a backend platform: the data model, schema changes, upkeep, agent access, leaving and pricing. Includes where Backenly does not fit.',
  path: '/alternatives',
  type: 'article',
  social: {
    title: 'Backend platform alternatives',
    description: 'How to evaluate one, where Backenly fits, and when not to switch.',
  },
})

/* ─────────────────────────────────────────────────────────────
   /alternatives (2026-10-15, founders: "no jargon, no lots of text, no big
   banners, clean and professional"). For the reader who is earlier than a
   shortlist.

   One job: how to evaluate a platform, and who should not switch. Six
   questions, each a bento cell with Backenly's answer under a hairline; where
   Backenly does not fit; what a move costs; a short FAQ. The essay on why
   teams start looking is gone.

   2026-11-15 (site-wide pass, to match the v8 landing): the questions, the
   limits and the switching costs are the landing's lit boxes. Violet marks
   only the label over Backenly's own answers.

   2026-10-23 (founders: match the landing and the rest of the site): the six
   questions sit two to a row, each paragraph on the landing's own floor so
   Backenly's answers start on one line across a row, without the mono
   "01" to "06" (the questions are ordered, not steps). What switching costs
   is one cell set like the landing's "Also built in", and the questions take
   the landing FAQ's header.
───────────────────────────────────────────────────────────── */


/**
 * The landing FAQ's two links. Literal here: SiteShell's ROUTES is a client
 * module's export, and a server page that imports it receives a client
 * reference rather than the string. Keep them equal to ROUTES.docs and
 * ROUTES.founder.
 */
const DOCS_HREF = '/docs/connect'
const FOUNDERS_HREF = 'https://calendly.com/adarsh-c-jose/30min'

export default function AlternativesPage() {
  /** Mirrors the FAQ rendered near the foot of this page, and nothing else. */
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  }

  return (
    <SiteShell footerLit>
      <JsonLd json={safeJsonLd(faqSchema)} />
      <Page>
        <PageHero
          readableTrail
          trail={[{ label: 'Home', href: '/' }, { label: 'Alternatives' }]}
          title="Choosing a backend platform"
          lede="Six questions to ask any platform, this one included, and when to stay where you are."
          rule={false}
        />

        {/* The six questions, each a cell: the question, why it matters, and Backenly's own answer under a hairline. */}
        <Box id="criteria" light={{ art: 'a' }} className="!pt-[8px] md:!pt-[16px]">
          <BoxHead
            id="criteria"
            layout="stacked"
            tag={{ icon: ListChecks, label: 'Six questions' }}
            title="Six questions to ask any platform"
            body="Each one with Backenly's own answer, so you can hold it to the same standard."
          />
          <Cells
            cols={3}
            items={CRITERIA.map((criterion) => ({
              title: criterion.question,
              body: criterion.why,
              list: (
                <div className="border-t border-white/[0.08] pt-[16px]">
                  <p className="text-[13px] font-medium text-violet-200">Backenly</p>
                  <p className="mt-[6px] text-[15px] leading-[1.6] text-zinc-300 [text-wrap:pretty]">{criterion.backenly}</p>
                </div>
              ),
            }))}
          />
        </Box>

        {/* Dashes, because these are what Backenly does not do; never a check. */}
        <Box id="not-a-fit" light={{ art: 'c' }}>
          <BoxHead
            id="not-a-fit"
            layout="stacked"
            tag={{ icon: Ban, label: 'Limits' }}
            title="Where Backenly does not fit"
            body="If one of these applies, that settles it."
          />
          <Panes>
            <Pane title="Not built for">
              <Limits items={NOT_FOR} />
            </Pane>
            <Pane title="Do not switch if">
              <Limits items={DO_NOT_SWITCH} />
            </Pane>
          </Panes>
        </Box>

        {/* A dash is work that stays yours; the one check is the cheap part. */}
        <Box id="switching-costs" light={{ art: 'a', flip: true }}>
          <BoxHead
            id="switching-costs"
            layout="stacked"
            tag={{ icon: ArrowRightLeft, label: 'Switching' }}
            title="What switching costs"
            body="Most of it is your work."
            extra={<BoxLink href="/comparisons/backenly-vs-supabase">Moving from Supabase, in detail</BoxLink>}
          />
          <Cells
            cols={3}
            items={SWITCHING_COSTS.map((cost) => ({ icon: cost.cheap ? Check : Minus, title: cost.item, body: cost.detail }))}
          />
        </Box>

        <Section aria-labelledby="switching-faq">
          <div className="grid gap-[40px] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-[64px]">
            <div className="lg:sticky lg:top-[112px] lg:self-start">
              <SectionHead id="switching-faq" title="Questions about switching" />
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
            <Faq items={FAQ} />
          </div>
        </Section>

        <Section aria-labelledby="detailed-comparisons">
          <h2 id="detailed-comparisons" className={`text-[22px] text-white md:text-[26px] ${TITLE}`}>
            Compare against a specific platform
          </h2>
          <NextLinks
            className="mt-[28px]"
            items={COMPARISON_LIST.map((c) => ({ href: `/comparisons/${c.slug}`, meta: c.category, title: c.headline }))}
          />
        </Section>

        <HorizonClose
          title="Try it on something real"
          lede="One free project, kept permanently. Start with a non-critical part of your schema."
        >
          <StartButton />
          <ButtonLink href="/pricing" variant="secondary">
            See pricing
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}

/** A list of limits: a dash for each, its name, and one sentence. Dashes because these are what Backenly does not do. */
function Limits({ items }: { items: { title: string; body: string }[] }) {
  return (
    <ul className="flex flex-col">
      {items.map((item) => (
        <li key={item.title} className="flex gap-[12px] border-t border-white/[0.07] py-[14px] first:border-t-0 first:pt-0 last:pb-0">
          <Minus aria-hidden strokeWidth={2} className="mt-[3px] h-4 w-4 shrink-0 text-zinc-400" />
          <div className="min-w-0">
            <p className="text-[15px] font-medium tracking-[-0.01em] text-zinc-100">{item.title}</p>
            <p className="mt-[4px] text-[14px] leading-[1.6] text-zinc-400 [text-wrap:pretty]">{item.body}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}
