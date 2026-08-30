import { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { articles } from './data'
import { LANES } from './content'
import {
  InlineArrow,
  PageHero,
  PrimaryButton,
  SecondaryButton,
  Section,
  SectionIntro,
  LinkCard,
  Tag,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Documentation — Backenly',
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

export default function ResourcesPage() {
  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(collectionSchema) }}
      />
      <main className="relative z-20">
        <PageHero
          eyebrow="Documentation"
          title="How Backenly works, and how to use it"
          subtitle="Seven guides covering the whole path: connecting a coding agent over MCP, the build loop and the checks that run after it, the data API your frontend calls, the authorization model, what the autonomy loop does once you are live, and how to run all of it yourself."
          actions={
            <>
              <PrimaryButton href="/resources/connect-your-coding-agent">
                Start here
                <InlineArrow />
              </PrimaryButton>
              <SecondaryButton href="/llms.txt" external>
                Full reference for agents
              </SecondaryButton>
            </>
          }
          proof={[
            { label: 'Guides', value: `${articles.length}` },
            { label: 'MCP tools documented', value: '20 advertised' },
            { label: 'Also available as', value: '/llms.txt · fetch_docs' },
          ]}
        />

        {LANES.map((lane, laneIndex) => {
          const inLane = articles.filter((a) => a.lane === lane.id)
          if (inLane.length === 0) return null

          return (
            <Section
              key={lane.id}
              aria-label={lane.title}
              width="wide-prose"
              className={laneIndex === 0 ? '!pt-0' : ''}
            >
              {/*
                The eyebrow carries the count, not the title — passing
                lane.title to both rendered the same words twice, once as a
                pill and once as the heading directly under it.
              */}
              <SectionIntro
                eyebrow={`${inLane.length} guides`}
                title={lane.title}
                body={lane.body}
              />
              <div className="grid gap-5 md:grid-cols-2">
                {inLane.map((a) => (
                  <LinkCard key={a.slug} href={`/resources/${a.slug}`}>
                    <div className="mb-3 flex flex-wrap items-center gap-3">
                      <Tag>{a.category}</Tag>
                      <span className="text-xs text-neutral-500">{a.readMinutes} min</span>
                    </div>
                    <h3 className="mb-2 text-lg font-semibold leading-tight text-white">
                      {a.title}
                    </h3>
                    {/*
                      The card carries the QUESTION the guide answers, not a
                      summary of it. A reader scanning this page is holding a
                      question, and matching it is the whole job of the card.
                    */}
                    <p className="text-sm font-light leading-relaxed text-neutral-400">
                      {a.answers}
                    </p>
                    <p className="mt-5 text-sm font-semibold text-zinc-200 transition-colors group-hover:text-white">
                      Read
                    </p>
                  </LinkCard>
                ))}
              </div>
            </Section>
          )
        })}

        <Section aria-label="Other references" width="wide-prose">
          <SectionIntro
            eyebrow="Elsewhere"
            title="Reference that lives outside these pages"
            body="Some of what you might want is better read at its source than paraphrased here."
          />
          <div className="grid gap-5 md:grid-cols-2">
            {[
              {
                href: '/llms.txt',
                external: true,
                title: 'llms.txt',
                body: 'The complete machine-readable reference: every endpoint, the full tool table, plan limits, and the architecture. Agents can also fetch it at run time with the fetch_docs tool.',
              },
              {
                href: 'https://github.com/backenly/backenly',
                external: true,
                title: 'The source',
                body: 'The platform is Apache-2.0 and the client libraries are MIT. Everything the hosted product runs is in the repository, including the autonomy engine.',
              },
              {
                href: '/pricing',
                external: false,
                title: 'Plan limits',
                body: 'Capacity per plan — projects, monthly active users, storage, AI credits, and which features are plan-gated. Kept in one place so no guide restates a number that can move.',
              },
              {
                href: '/use-cases',
                external: false,
                title: 'Use cases',
                body: 'Five workflows with the problem, what Backenly does, what stays yours, and the known limitations of each.',
              },
            ].map((item) => (
              <LinkCard key={item.href} href={item.href} external={item.external}>
                <h3 className="mb-2 text-lg font-semibold leading-tight text-white">
                  {item.title}
                </h3>
                <p className="text-sm font-light leading-relaxed text-neutral-400">{item.body}</p>
              </LinkCard>
            ))}
          </div>
        </Section>

        <Section width="prose" className="!py-12">
          <ChipRow label="Explore Backenly:">
            {[
              { href: '/features', label: 'Features' },
              { href: '/use-cases', label: 'Use cases' },
              { href: '/comparisons', label: 'Comparisons' },
              { href: '/alternatives', label: 'Alternatives' },
              { href: '/pricing', label: 'Pricing' },
            ].map((link) => (
              <ChipLink key={link.href} href={link.href}>
                {link.label}
              </ChipLink>
            ))}
          </ChipRow>
        </Section>
      </main>
    </SiteShell>
  )
}
