import type { Metadata } from 'next'
import { Check, Minus } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
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
import { HEADING, TITLE } from '@/components/site/tokens'
import { COMPARISON_LIST } from '../comparisons/data'
import { CRITERIA, DO_NOT_SWITCH, FAQ, NOT_FOR, SWITCHING_COSTS } from './data'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Backend platform alternatives: how to evaluate one, and when to stay',
  description:
    'Six questions that decide a backend platform: the data model, schema changes, upkeep after launch, agent access, leaving, and pricing. Includes where Backenly does not fit.',
  keywords: [
    'backend platform alternatives',
    'Supabase alternative',
    'Firebase alternative',
    'backend as a service evaluation',
  ],
  openGraph: {
    title: 'Backend platform alternatives: how to evaluate one, and when to stay',
    description:
      'The criteria that decide a backend platform, where Backenly fits, and when the right answer is to stay where you are.',
    url: `${APP_URL}/alternatives`,
    type: 'article',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backend platform alternatives',
    description: 'How to evaluate one, where Backenly fits, and when not to switch.',
  },
  alternates: { canonical: `${APP_URL}/alternatives` },
}

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
───────────────────────────────────────────────────────────── */

/** The gap between a section title and its first cell. */
const BODY_GAP = 'mt-[40px] md:mt-[56px]'

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
          <ol className={`${BODY_GAP} grid gap-[12px] md:grid-cols-2 lg:grid-cols-3`}>
            {CRITERIA.map((criterion, index) => (
              <li key={criterion.question} className="min-w-0">
                <BentoCell bare className="h-full">
                  <div className="flex h-full flex-col p-[20px] md:p-[26px]">
                    <span aria-hidden className="font-mono text-[11px] tabular-nums tracking-tight text-zinc-500">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <h3 className={`mt-[14px] text-[18px] text-white [text-wrap:balance] ${HEADING}`}>
                      {criterion.question}
                    </h3>
                    <p className="mt-[10px] text-[15px] leading-[1.65] tracking-[-0.004em] text-zinc-400 [text-wrap:pretty]">
                      {criterion.why}
                    </p>
                    <div className="mt-auto pt-[24px]">
                      <div className="border-t border-white/[0.07] pt-[16px]">
                        <p className="text-[13px] font-medium text-violet-300">Backenly</p>
                        <p className="mt-[6px] text-[14px] leading-[1.65] text-zinc-300 [text-wrap:pretty]">
                          {criterion.backenly}
                        </p>
                      </div>
                    </div>
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
          >
            <ArrowLink href="/comparisons/backenly-vs-supabase">Moving from Supabase, in detail</ArrowLink>
          </SectionHead>
          <ul className={`${BODY_GAP} grid gap-[12px] md:grid-cols-2 lg:grid-cols-3`}>
            {SWITCHING_COSTS.map((cost) => {
              const Glyph = cost.cheap ? Check : Minus
              return (
                <li key={cost.item} className="min-w-0">
                  <BentoCell className="h-full">
                    <Glyph
                      aria-hidden
                      strokeWidth={2}
                      className={`h-[18px] w-[18px] ${cost.cheap ? 'text-violet-300' : 'text-zinc-500'}`}
                    />
                    <div className="mt-[16px]">
                      <CellTitle>{cost.item}</CellTitle>
                    </div>
                    <CellBody>{cost.detail}</CellBody>
                  </BentoCell>
                </li>
              )
            })}
          </ul>
        </Section>

        <Section aria-labelledby="switching-faq">
          <div className="grid gap-[40px] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-[64px]">
            <div className="lg:sticky lg:top-[112px] lg:self-start">
              <SectionHead id="switching-faq" title="Questions about switching" />
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
