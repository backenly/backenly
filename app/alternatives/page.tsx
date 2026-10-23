import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, Check, Minus } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { SiteShell } from '@/components/site/SiteShell'
import { BentoCell, CellBody, CellTitle } from '@/components/landing-v7/shared'
import {
  ArrowLink,
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
import { HEADING, TEXT_LINK, TITLE } from '@/components/site/tokens'
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

   The cells are the landing's (components/landing-v7). Violet marks only
   Backenly's own answers.

   2026-10-23 (founders: match the landing and the rest of the site): the six
   questions sit two to a row, each paragraph on the landing's own floor so
   Backenly's answers start on one line across a row, without the mono
   "01" to "06" (the questions are ordered, not steps). What switching costs
   is one cell set like the landing's "Also built in", and the questions take
   the landing FAQ's header.
───────────────────────────────────────────────────────────── */

/** The gap between a section title and its first cell. */
const BODY_GAP = 'mt-[40px] md:mt-[56px]'

/**
 * The landing FAQ's two links. Literal here: SiteShell's ROUTES is a client
 * module's export, and a server page that imports it receives a client
 * reference rather than the string. Keep them equal to ROUTES.docs and
 * ROUTES.founder.
 */
const DOCS_HREF = '/docs/database'
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
    <SiteShell>
      <JsonLd json={safeJsonLd(faqSchema)} />
      <Page>
        <PageHero
          readableTrail
          trail={[{ label: 'Home', href: '/' }, { label: 'Alternatives' }]}
          title="Choosing a backend platform"
          lede="Six questions to ask any platform, this one included, and when to stay where you are."
        />

        <Section flush aria-labelledby="criteria">
          <SectionHead
            id="criteria"
            title={
              <>
                Six questions to ask. <span className="text-zinc-500">With Backenly&apos;s answers.</span>
              </>
            }
          />
          <ol className={`${BODY_GAP} grid gap-3 md:grid-cols-2`}>
            {CRITERIA.map((criterion) => (
              <li key={criterion.question} className="min-w-0">
                <BentoCell className="h-full">
                  <CellTitle>{criterion.question}</CellTitle>
                  {/* A four-line floor (the longest reason runs four), the landing's
                      own trick (PrimitivesV7), so the answers start on one line
                      across a row. */}
                  <CellBody className="[text-wrap:pretty] md:min-h-[102px]">{criterion.why}</CellBody>
                  <div className="mt-6 border-t border-white/[0.08] pt-5">
                    <p className="text-[13px] font-medium text-violet-300">Backenly</p>
                    <p className="mt-2 max-w-[46ch] text-[15px] leading-[1.7] tracking-[-0.004em] text-zinc-300 [text-wrap:pretty]">
                      {criterion.backenly}
                    </p>
                  </div>
                </BentoCell>
              </li>
            ))}
          </ol>
        </Section>

        <Section aria-labelledby="not-a-fit">
          <SectionHead
            id="not-a-fit"
            title={
              <>
                Where Backenly does not fit. <span className="text-zinc-500">If one applies, that settles it.</span>
              </>
            }
          />
          <div className={`${BODY_GAP} grid gap-[12px] lg:grid-cols-2`}>
            <LimitCell title="Not built for" items={NOT_FOR} />
            <LimitCell title="Do not switch if" items={DO_NOT_SWITCH} />
          </div>
        </Section>

        <Section aria-labelledby="switching-costs">
          <SectionHead
            id="switching-costs"
            title={
              <>
                What switching costs. <span className="text-zinc-500">Most of it is your work.</span>
              </>
            }
          />
          {/* One cell, set like the landing's "Also built in" (PrimitivesV7): a
              hairline over each part, its glyph, its name and one sentence. A
              dash is work that stays yours; the one check is the cheap part. */}
          <BentoCell className={BODY_GAP}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
              <CellTitle>What a move involves</CellTitle>
              <ArrowLink href="/comparisons/backenly-vs-supabase">Moving from Supabase, in detail</ArrowLink>
            </div>
            <ul className="mt-6 grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
              {SWITCHING_COSTS.map((cost) => {
                const Glyph = cost.cheap ? Check : Minus
                return (
                  <li key={cost.item} className="min-w-0 border-t border-white/[0.08] pt-5">
                    <Glyph
                      aria-hidden
                      strokeWidth={2}
                      className={`h-[18px] w-[18px] ${cost.cheap ? 'text-violet-300' : 'text-zinc-500'}`}
                    />
                    <h4 className={`mt-4 text-[15px] text-white ${HEADING}`}>{cost.item}</h4>
                    <p className="mt-2 text-[14px] leading-[1.65] text-zinc-400 [text-wrap:pretty]">{cost.detail}</p>
                  </li>
                )
              })}
            </ul>
          </BentoCell>
        </Section>

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

/**
 * A titled list of limits: a dash for each, its name, and one sentence. Dashes
 * because these are what Backenly does not do; never a check.
 */
function LimitCell({ title, items }: { title: string; items: { title: string; body: string }[] }) {
  return (
    <BentoCell className="h-full">
      <CellTitle>{title}</CellTitle>
      <ul className="mt-[18px] flex flex-col">
        {items.map((item) => (
          <li
            key={item.title}
            className="flex gap-[12px] border-t border-white/[0.07] py-[14px] first:border-t-0 first:pt-0 last:pb-0"
          >
            <Minus aria-hidden strokeWidth={2} className="mt-[3px] h-4 w-4 shrink-0 text-zinc-500" />
            <div className="min-w-0">
              <p className={`text-[15px] text-zinc-100 ${HEADING}`}>{item.title}</p>
              <p className="mt-[4px] text-[14px] leading-[1.6] text-zinc-400 [text-wrap:pretty]">{item.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </BentoCell>
  )
}
