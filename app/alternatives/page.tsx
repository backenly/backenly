import type { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
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
  withCode,
} from '@/components/site/kit'
import { Faq } from '@/components/site/Faq'
import { Reveal } from '@/components/site/Reveal'
import { StartButton } from '@/components/site/StartButton'
import { HEADING, PANEL, TITLE } from '@/components/site/tokens'
import { COMPARISON_LIST } from '../comparisons/data'
import { CRITERIA, DO_NOT_SWITCH, FAQ, NOT_FOR, REASONS_TEAMS_LOOK, SWITCHING_COSTS } from './data'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Backend platform alternatives: how to evaluate one, and when to stay',
  description:
    'The criteria that actually decide a backend platform: data model, who applies schema changes, who operates it after launch, agent blast radius, exit path, and billing shape. Includes where Backenly does not fit.',
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
   /alternatives: for the reader who is earlier than a shortlist.

   The centrepiece is the six criteria, each set as a row: the question on the
   left, why it binds, and on the right where Backenly lands, in a lit panel so
   the answer is easy to find and impossible to mistake for the question. The
   rows are numbered because the data file orders them by how early they bind.
───────────────────────────────────────────────────────────── */

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
          title="Choosing a backend platform, including when not to"
          lede="What actually decides it, where Backenly lands on each criterion, and the cases where you should stay on what you have."
          actions={
            <>
              <StartButton />
              <ButtonLink href="/comparisons" variant="secondary">
                See comparisons
              </ButtonLink>
            </>
          }
        />

        <Section flush aria-labelledby="why-look">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
            <Reveal className="lg:sticky lg:top-28 lg:self-start">
              <SectionHead
                id="why-look"
                title="Why teams start looking"
                lede="Worth being precise about the trigger, because two of these five are not problems a different platform solves."
              />
            </Reveal>
            <Reveal delay={0.06}>
              <ul className="flex flex-col">
                {REASONS_TEAMS_LOOK.map((reason, index) => (
                  <li key={reason.title} className={`py-7 ${index === 0 ? 'pt-0 lg:pt-2' : 'border-t border-white/[0.08]'}`}>
                    <h3 className={`text-[18px] text-white ${HEADING}`}>{reason.title}</h3>
                    <p className="mt-2 max-w-[64ch] text-[15px] leading-[1.7] text-zinc-400 [text-wrap:pretty]">
                      {withCode(reason.body)}
                    </p>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </Section>

        <Section aria-labelledby="criteria">
          <Reveal>
            <SectionHead
              id="criteria"
              title="What actually decides it"
              lede="Six questions, roughly in the order they tend to bind. Ask them of any platform you are considering, this one included. Each carries where Backenly lands, stated plainly enough to check."
            />
          </Reveal>
          <ol className="mt-14">
            {CRITERIA.map((criterion, index) => (
              <Reveal
                as="li"
                key={criterion.question}
                className="grid gap-6 border-t border-white/[0.08] py-10 lg:grid-cols-[48px_minmax(0,6fr)_minmax(0,5fr)] lg:gap-10"
              >
                <span aria-hidden className="text-[15px] font-medium tabular-nums text-zinc-600">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h3 className={`max-w-[34ch] text-[20px] text-white [text-wrap:balance] md:text-[22px] ${HEADING}`}>
                    {criterion.question}
                  </h3>
                  <p className="mt-3 max-w-[60ch] text-[15px] leading-[1.7] text-zinc-400 [text-wrap:pretty]">
                    {withCode(criterion.why)}
                  </p>
                </div>
                <div className={`relative self-start overflow-hidden p-5 md:p-6 ${PANEL}`}>
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 left-0 w-px bg-[linear-gradient(to_bottom,rgba(196,181,253,0.7),rgba(196,181,253,0.05))]"
                  />
                  <p className="text-[13px] font-medium text-violet-300">Where Backenly lands</p>
                  <p className="mt-2 text-[15px] leading-[1.7] text-zinc-300 [text-wrap:pretty]">
                    {withCode(criterion.backenly)}
                  </p>
                </div>
              </Reveal>
            ))}
          </ol>
        </Section>

        <Section aria-label="Where Backenly does not fit">
          <Reveal>
            <p className="max-w-[62ch] text-[17px] leading-[1.7] text-zinc-400">
              Each of these is a real boundary rather than a roadmap item. If one is load-bearing for
              your product, that settles it, and the rest of this page is academic.
            </p>
          </Reveal>
          <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:gap-16">
            <BoundaryColumn id="not-for" title="What Backenly is not for" items={NOT_FOR} />
            <BoundaryColumn id="do-not-switch" title="Who should not switch" items={DO_NOT_SWITCH} delay={0.06} />
          </div>
        </Section>

        <Section aria-labelledby="switching-costs">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
            <Reveal className="lg:sticky lg:top-28 lg:self-start">
              <SectionHead
                id="switching-costs"
                title="What switching actually costs"
                lede="There is no migration service on any plan. This is the real list of what you would be taking on."
              />
              <ArrowLink href="/use-cases/migrate-from-supabase" className="mt-8">
                Moving from Supabase, in detail
              </ArrowLink>
            </Reveal>
            <Reveal delay={0.06}>
              <dl className="flex flex-col">
                {SWITCHING_COSTS.map((cost, index) => (
                  <div key={cost.item} className={`py-6 ${index === 0 ? 'pt-0 lg:pt-2' : 'border-t border-white/[0.08]'}`}>
                    <dt className={`text-[17px] text-white ${HEADING}`}>{cost.item}</dt>
                    <dd className="mt-2 max-w-[64ch] text-[15px] leading-[1.7] text-zinc-400 [text-wrap:pretty]">
                      {withCode(cost.detail)}
                    </dd>
                  </div>
                ))}
              </dl>
            </Reveal>
          </div>
        </Section>

        <Section aria-labelledby="detailed-comparisons">
          <Reveal>
            <SectionHead
              id="detailed-comparisons"
              title="Comparisons against specific platforms"
              lede="Once you know which criterion binds, the detailed pages go capability by capability and say where each alternative is stronger."
            />
          </Reveal>
          <Reveal delay={0.06}>
            <NextLinks
              className="mt-10"
              items={COMPARISON_LIST.map((c) => ({ href: `/comparisons/${c.slug}`, meta: c.category, title: c.headline }))}
            />
          </Reveal>
        </Section>

        <Section aria-labelledby="switching-faq">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
            <Reveal className="lg:sticky lg:top-28 lg:self-start">
              <SectionHead id="switching-faq" title="Questions about switching" />
            </Reveal>
            <Reveal delay={0.06}>
              <Faq items={FAQ} />
            </Reveal>
          </div>
        </Section>

        <HorizonClose
          title="Test it on something real"
          lede="One free project, kept permanently. Rebuild a non-critical part of your schema and see whether the workflow suits you."
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

function BoundaryColumn({
  id,
  title,
  items,
  delay = 0,
}: {
  id: string
  title: string
  items: { title: string; body: string }[]
  delay?: number
}) {
  return (
    <Reveal delay={delay}>
      <h2 id={id} className={`text-[24px] text-white md:text-[30px] ${TITLE}`}>
        {title}
      </h2>
      <ul className="mt-8 flex flex-col">
        {items.map((item) => (
          <li key={item.title} className="border-t border-white/[0.08] py-6">
            <h3 className={`text-[17px] text-white ${HEADING}`}>{item.title}</h3>
            <p className="mt-2 max-w-[58ch] text-[15px] leading-[1.7] text-zinc-400 [text-wrap:pretty]">
              {withCode(item.body)}
            </p>
          </li>
        ))}
      </ul>
    </Reveal>
  )
}
