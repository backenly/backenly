import { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import {
  InlineArrow,
  PageHero,
  PrimaryButton,
  SecondaryButton,
  Section,
  SectionHeading,
  Lead,
  LinkCard,
  Tag,
  FaqList,
  CtaSection,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'
import { COMPARISON_LIST } from '../comparisons/data'
import { CRITERIA, DO_NOT_SWITCH, FAQ, NOT_FOR, REASONS_TEAMS_LOOK, SWITCHING_COSTS } from './data'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Backend platform alternatives — how to evaluate one, and when to stay',
  description:
    'The criteria that actually decide a backend platform: data model, who applies schema changes, who operates it after launch, agent blast radius, exit path, and billing shape. Includes where Backenly does not fit.',
  keywords: [
    'backend platform alternatives',
    'Supabase alternative',
    'Firebase alternative',
    'backend as a service evaluation',
  ],
  openGraph: {
    title: 'Backend platform alternatives — how to evaluate one, and when to stay',
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
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(faqSchema) }} />
      <main className="relative z-20">
        <PageHero
          align="center"
          eyebrow="Alternatives"
          title="Choosing a backend platform, including when not to"
          subtitle="What actually decides this, where Backenly fits against each criterion, and the cases where you should stay on what you have."
          actions={
            <PrimaryButton href="/auth/signup">
              Try Backenly free
              <InlineArrow />
            </PrimaryButton>
          }
        />

        <Section width="prose" className="!pt-0">
          <SectionHeading className="!text-xl mb-4">Why teams start looking</SectionHeading>
          <Lead className="mb-8">
            Worth being precise about the trigger, because two of the five reasons below are not
            problems a different platform solves.
          </Lead>
          <div className="flex flex-col gap-6">
            {REASONS_TEAMS_LOOK.map((reason) => (
              <div key={reason.title}>
                <h3 className="text-sm font-medium text-white">{reason.title}</h3>
                <p className="mt-2 text-sm font-light leading-6 text-neutral-400">{reason.body}</p>
              </div>
            ))}
          </div>
        </Section>

        {/*
         * `prose`, not `wide-prose`. These are single-column cards of body copy,
         * so a 1280px container puts a ~990px line under them at 1728 — the
         * exact over-stretch the wide-screen work was not meant to introduce.
         * The two-column sections below can take the wider container because
         * each column is half of it.
         */}
        <Section width="prose" aria-label="Evaluation criteria">
          <SectionHeading className="mb-3">What actually decides it</SectionHeading>
          <Lead className="mb-10">
            Six questions, roughly in the order they tend to bind. Ask them of any platform you are
            considering, this one included. Each carries where Backenly lands, stated plainly enough
            that you can check it.
          </Lead>
          <ol className="flex flex-col gap-8">
            {CRITERIA.map((criterion, i) => (
              <li
                key={criterion.question}
                className="rounded-lg border border-white/10 bg-white/[0.02] p-6 md:p-7"
              >
                <div className="flex items-baseline gap-3">
                  <span
                    aria-hidden="true"
                    className="font-mono text-xs text-neutral-600"
                  >{`0${i + 1}`}</span>
                  <h3 className="text-base font-normal tracking-tight text-white">
                    {criterion.question}
                  </h3>
                </div>
                <p className="mt-3 text-sm font-light leading-6 text-neutral-400">{criterion.why}</p>
                <p className="mt-4 border-t border-white/[0.07] pt-4 text-sm font-light leading-6 text-neutral-400">
                  <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-violet-300">
                    Backenly
                  </span>
                  <span className="mt-1 block">{criterion.backenly}</span>
                </p>
              </li>
            ))}
          </ol>
        </Section>

        <Section width="wide-prose" aria-label="Where Backenly does not fit">
          <SectionHeading className="mb-3">What Backenly is not for</SectionHeading>
          <Lead className="mb-8 max-w-3xl">
            Each of these is a real boundary rather than a roadmap item. If one of them is
            load-bearing for your product, that settles it and the rest of this page is academic.
          </Lead>
          <div className="grid gap-4 sm:grid-cols-2">
            {NOT_FOR.map((item) => (
              <div key={item.title} className="rounded-lg border border-white/10 bg-white/[0.02] p-6">
                <h3 className="text-sm font-medium text-white">{item.title}</h3>
                <p className="mt-2 text-sm font-light leading-6 text-neutral-400">{item.body}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section width="wide-prose" aria-label="When not to switch">
          <SectionHeading className="mb-8">Who should not switch</SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2">
            {DO_NOT_SWITCH.map((item) => (
              <div key={item.title} className="rounded-lg border border-white/10 bg-white/[0.02] p-6">
                <h3 className="text-sm font-medium text-white">{item.title}</h3>
                <p className="mt-2 text-sm font-light leading-6 text-neutral-400">{item.body}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section width="prose" aria-label="What switching costs">
          <SectionHeading className="mb-3">What switching actually costs</SectionHeading>
          <Lead className="mb-8">
            There is no migration service on any plan. This is the real list of what you would be
            taking on.
          </Lead>
          <dl className="flex flex-col gap-5">
            {SWITCHING_COSTS.map((cost) => (
              <div key={cost.item} className="border-l border-white/10 pl-5">
                <dt className="text-sm font-medium text-white">{cost.item}</dt>
                <dd className="mt-1.5 text-sm font-light leading-6 text-neutral-400">
                  {cost.detail}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-8">
            <SecondaryButton href="/use-cases/migrate-from-supabase">
              Moving from Supabase, in detail
              <InlineArrow />
            </SecondaryButton>
          </p>
        </Section>

        <Section width="wide-prose" aria-label="Detailed comparisons">
          <SectionHeading className="mb-3">Comparisons against specific platforms</SectionHeading>
          <Lead className="mb-8 max-w-3xl">
            Once you know which criterion is binding, the detailed pages go capability by capability
            and say where each alternative is stronger.
          </Lead>
          <div className="grid gap-6 sm:grid-cols-2">
            {COMPARISON_LIST.map((c) => (
              <LinkCard key={c.slug} href={`/comparisons/${c.slug}`}>
                <h3 className="mb-3 text-lg font-normal tracking-tight text-white">{c.headline}</h3>
                <p className="flex-1 text-sm font-light leading-relaxed text-neutral-400">
                  {c.intro}
                </p>
                <div className="mt-5">
                  <Tag>{c.category}</Tag>
                </div>
              </LinkCard>
            ))}
          </div>
        </Section>

        <Section width="prose" aria-label="Frequently asked questions">
          <SectionHeading className="mb-8">Questions about switching</SectionHeading>
          <FaqList items={FAQ} />
        </Section>

        <Section width="prose" className="!py-12">
          <ChipRow label="Related:">
            {[
              { href: '/comparisons', label: 'All comparisons' },
              { href: '/use-cases', label: 'Use cases' },
              { href: '/resources', label: 'Documentation' },
              { href: '/pricing', label: 'Pricing' },
            ].map((link) => (
              <ChipLink key={link.href} href={link.href}>
                {link.label}
              </ChipLink>
            ))}
          </ChipRow>
        </Section>

        <CtaSection
          title="Test it on something real"
          body="One free project, kept permanently. Rebuild a non-critical part of your schema and see whether the workflow suits you."
        >
          <PrimaryButton href="/auth/signup">Get started free</PrimaryButton>
          <SecondaryButton href="/pricing">See pricing</SecondaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
