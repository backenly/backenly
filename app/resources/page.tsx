import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { ConnectTabs } from '@/components/landing/ConnectTabs'
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
import { Reveal } from '@/components/site/Reveal'
import { StartButton } from '@/components/site/StartButton'
import { HEADING, TITLE } from '@/components/site/tokens'
import { articles } from './data'
import { LANES } from './content'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Documentation: Backenly',
  description:
    'How Backenly works and how to use it: connecting a coding agent over MCP, the build loop and its verification checks, the data API and its two grammars, the row-level security model, what the autonomy loop does after launch, and self-hosting.',
  keywords: [
    'Backenly documentation',
    'MCP backend server',
    'PostgREST REST API',
    'row-level security postgres',
    'autonomous backend platform',
  ],
  openGraph: {
    title: 'Backenly Documentation',
    description:
      'Connect an agent over MCP, build a backend, read the verification evidence, and understand what keeps operating it afterwards.',
    url: `${APP_URL}/resources`,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly Documentation',
    description: 'How Backenly works and how to use it.',
  },
  alternates: { canonical: `${APP_URL}/resources` },
}

const collectionSchema = {
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: 'Backenly Documentation',
  description:
    'Guides covering agent setup over MCP, the governed build loop, the data API, the access-control model, post-launch autonomy, and self-hosting.',
  url: `${APP_URL}/resources`,
  publisher: { '@type': 'Organization', name: 'Backenly', url: APP_URL },
  hasPart: articles.map((a) => ({
    '@type': 'TechArticle',
    headline: a.title,
    url: `${APP_URL}/resources/${a.slug}`,
    description: a.answers,
  })),
}

/* ─────────────────────────────────────────────────────────────
   /resources: the documentation hub.

   The guides are ordered as a reading path (content/index.ts), so the hub
   draws them as one: numbered in the order to read them, on two shelves,
   each row carrying the question the guide answers rather than a summary of
   it. A reader scanning this page is holding a question, and matching it is
   the whole job of a row. Under the path, the real connect commands, because
   the first guide's answer fits in one of them.
───────────────────────────────────────────────────────────── */

export default function ResourcesPage() {
  // Reading-order position across both shelves, so the numbers run 1..n.
  const position = new Map(articles.map((a, index) => [a.slug, index + 1]))

  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(collectionSchema)} />
      <Page>
        <PageHero
          trail={[{ label: 'Home', href: '/' }, { label: 'Documentation' }]}
          title="How Backenly works, and how to use it"
          lede="Seven guides, in reading order: connect an agent, build and verify a backend, call it from a frontend, and understand what keeps it running."
          actions={
            <>
              <ButtonLink href="/resources/connect-your-coding-agent">
                Start here
                <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </ButtonLink>
              <ButtonLink href="/llms.txt" variant="secondary">
                Full reference for agents
              </ButtonLink>
            </>
          }
        />

        <Section flush aria-label="Guides">
          {LANES.map((lane, laneIndex) => {
            const inLane = articles.filter((a) => a.lane === lane.id)
            if (inLane.length === 0) return null

            return (
              <div
                key={lane.id}
                className={`grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16 ${
                  laneIndex === 0 ? '' : 'mt-20 md:mt-28'
                }`}
              >
                <Reveal className="lg:sticky lg:top-28 lg:self-start">
                  <h2 className={`text-[26px] text-white md:text-[34px] ${TITLE}`}>{lane.title}</h2>
                  <p className="mt-4 max-w-[40ch] text-[16px] leading-[1.65] text-zinc-400">{lane.body}</p>
                </Reveal>
                <Reveal delay={0.06}>
                  <ol>
                    {inLane.map((a, index) => (
                      <li key={a.slug}>
                        <Link
                          href={`/resources/${a.slug}`}
                          className={`group grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-5 py-7 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 ${
                            index === 0 ? 'border-t border-white/[0.10]' : 'border-t border-white/[0.07]'
                          }`}
                        >
                          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.12] text-[13px] font-medium tabular-nums text-zinc-400 transition-colors duration-200 group-hover:border-violet-300/40 group-hover:text-white">
                            {position.get(a.slug)}
                          </span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-zinc-500">
                              <span>{a.category}</span>
                              <span aria-hidden className="h-3 w-px bg-white/[0.12]" />
                              <span>{a.readMinutes} min read</span>
                            </span>
                            <span className={`mt-2 block text-[19px] text-white md:text-[21px] ${HEADING}`}>{a.title}</span>
                            <span className="mt-2 block max-w-[62ch] text-[15px] leading-[1.65] text-zinc-400 [text-wrap:pretty]">
                              {a.answers}
                            </span>
                          </span>
                          <ArrowRight
                            aria-hidden
                            className="mt-9 hidden h-4 w-4 text-zinc-600 transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:text-white sm:block"
                          />
                        </Link>
                      </li>
                    ))}
                  </ol>
                </Reveal>
              </div>
            )
          })}
        </Section>

        <Section aria-labelledby="quickstart">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
            <Reveal>
              <SectionHead
                id="quickstart"
                title="The first guide, in one command"
                lede="Mint a key in the dashboard, run the line for your host, and start a new session. The key is scoped to one project and revocable."
              />
              <ArrowLink href="/resources/connect-your-coding-agent" className="mt-8">
                Every host, step by step
              </ArrowLink>
            </Reveal>
            <Reveal delay={0.06}>
              <ConnectTabs />
            </Reveal>
          </div>
        </Section>

        <Section aria-labelledby="elsewhere">
          <Reveal>
            <SectionHead
              id="elsewhere"
              title="Reference that lives elsewhere"
              lede="Some of what you might want is better read at its source than paraphrased here."
            />
          </Reveal>
          <Reveal delay={0.06}>
            <NextLinks
              className="mt-10"
              items={[
                {
                  href: '/llms.txt',
                  meta: 'For agents',
                  title: 'llms.txt',
                  body: 'Every endpoint, the full tool table, plan limits and the architecture. Also fetchable at run time with fetch_docs.',
                },
                {
                  href: 'https://github.com/backenly/backenly',
                  meta: 'Apache-2.0',
                  title: 'The source',
                  body: 'Everything the hosted product runs, including the autonomy engine. Client libraries are MIT.',
                },
                {
                  href: '/pricing',
                  meta: 'Plan limits',
                  title: 'Pricing',
                  body: 'Capacity per plan, kept in one place so no guide restates a number that can move.',
                },
                {
                  href: '/use-cases',
                  meta: 'Workflows',
                  title: 'Use cases',
                  body: 'Five workflows, with what Backenly does, what stays yours, and where each one stops.',
                },
              ]}
            />
          </Reveal>
        </Section>

        <HorizonClose
          title="Read it, then run it"
          lede="One free project, no card. Connect your agent and check every guide against a live backend."
        >
          <StartButton />
          <ButtonLink href="/contact" variant="secondary">
            Ask a question
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
