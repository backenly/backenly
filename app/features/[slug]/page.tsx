import type { Metadata } from 'next'
import type { ComponentType } from 'react'
import { notFound } from 'next/navigation'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { CodeBlock } from '@/components/site/CodeBlock'
import { AuthDiagram, DatabaseDiagram, RestApiDiagram } from '@/components/landing/CapabilityDiagrams'
import { ChangePath } from '@/components/landing/ChangePath'
import {
  ButtonLink,
  Facts,
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
import { SpotlightPanel } from '@/components/site/SpotlightPanel'
import { StartButton } from '@/components/site/StartButton'
import { HEADING, TITLE } from '@/components/site/tokens'
import { FEATURES, FEATURE_SLUGS } from '../data'

const APP_URL = 'https://backenly.com'

/** The drawing that shows each primitive doing its job, where one exists. */
const HERO_DIAGRAMS: Record<string, ComponentType | undefined> = {
  'database-setup': DatabaseDiagram,
  authentication: AuthDiagram,
  'api-generation': RestApiDiagram,
}

/**
 * The agent page shows a session rather than a drawing. The exchange is the
 * one on the agent-driven use case page, which names real tools
 * (read_backend_state, apply_migration) and the real refusal path.
 */
const AGENT_SESSION = `You:   What tables does this project have?
Agent: read_backend_state
       users, recipes, follows, favorites,
       with columns, types and relations.

You:   Add saved_searches with user_id
       and query.
Agent: apply_migration: applied. Served at
       /db/saved_searches immediately.

You:   Drop the users table.
Agent: Not available over MCP. Sent to the
       Review Queue: 1,284 live rows.
       Approve it in the dashboard.`

export function generateStaticParams() {
  return FEATURE_SLUGS.map((slug) => ({ slug }))
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params
  const f = FEATURES[params.slug]
  if (!f) return { title: 'Not Found' }
  return {
    title: f.metaTitle,
    description: f.metaDescription,
    openGraph: { title: f.metaTitle, description: f.metaDescription, url: `${APP_URL}/features/${f.slug}`, type: 'website' },
    twitter: { card: 'summary_large_image', title: f.metaTitle, description: f.metaDescription },
    alternates: { canonical: `${APP_URL}/features/${f.slug}` },
  }
}

export default async function FeatureSlugPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params
  const f = FEATURES[params.slug]
  if (!f) notFound()

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: f.faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: APP_URL },
      { '@type': 'ListItem', position: 2, name: 'Features', item: `${APP_URL}/features` },
      { '@type': 'ListItem', position: 3, name: f.name, item: `${APP_URL}/features/${f.slug}` },
    ],
  }

  const related = f.relatedFeatures.map((slug) => FEATURES[slug]).filter(Boolean)
  const Diagram = HERO_DIAGRAMS[f.slug]
  const isAgentPage = f.slug === 'ai-backend-generation'
  const isOperationsPage = f.slug === 'deployment-ready-backends'

  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(faqSchema)} />
      <JsonLd json={safeJsonLd(breadcrumbSchema)} />
      <Page>
        <PageHero
          trail={[
            { label: 'Home', href: '/' },
            { label: 'Features', href: '/features' },
            { label: f.name },
          ]}
          title={f.headline}
          lede={f.subheadline}
          actions={
            <>
              <StartButton />
              <ButtonLink href="/features" variant="secondary">
                All features
              </ButtonLink>
            </>
          }
          aside={
            Diagram ? (
              <SpotlightPanel className="px-6 pb-6">
                <Diagram />
              </SpotlightPanel>
            ) : isAgentPage ? (
              <CodeBlock code={AGENT_SESSION} label="Your agent, over MCP" language="text" />
            ) : undefined
          }
        />

        {/* In practice first: the concrete walkthrough is the most convincing
            thing on the page, so it opens the page rather than closing it. */}
        <Section flush aria-labelledby="in-practice">
          <Reveal className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
            <h2 id="in-practice" className={`text-[26px] text-white md:text-[34px] ${TITLE}`}>
              In practice
            </h2>
            <p className="max-w-[64ch] text-[17px] leading-[1.75] tracking-[-0.01em] text-zinc-300 [text-wrap:pretty] md:text-[18px]">
              {withCode(f.inPractice)}
            </p>
          </Reveal>
        </Section>

        {isOperationsPage && (
          <Section aria-label="One day and night on production">
            <Reveal>
              <ChangePath />
            </Reveal>
          </Section>
        )}

        <Section aria-label={`What ${f.name} is, how it works and why it matters`}>
          <Reveal>
            <Facts
              items={[
                { title: 'What it is', body: withCode(f.what) },
                { title: 'How it works', body: withCode(f.how) },
                { title: 'Why it matters', body: withCode(f.why) },
              ]}
            />
          </Reveal>
        </Section>

        <Section aria-labelledby="what-you-get">
          <Reveal>
            <SectionHead id="what-you-get" title="What you get" />
          </Reveal>
          <Reveal delay={0.06} className="mt-12 grid gap-3 md:grid-cols-2">
            {f.details.map((detail) => (
              <SpotlightPanel key={detail.title} className="p-6 md:p-8">
                <h3 className={`text-[19px] text-white ${HEADING}`}>{detail.title}</h3>
                <p className="mt-3 max-w-[52ch] text-[15px] leading-[1.7] tracking-[-0.004em] text-zinc-400 [text-wrap:pretty]">
                  {withCode(detail.body)}
                </p>
              </SpotlightPanel>
            ))}
          </Reveal>
        </Section>

        <Section aria-labelledby="feature-faq">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
            <Reveal className="lg:sticky lg:top-28 lg:self-start">
              <SectionHead id="feature-faq" title="Common questions" />
            </Reveal>
            <Reveal delay={0.06}>
              <Faq items={f.faq} />
            </Reveal>
          </div>
        </Section>

        {related.length > 0 && (
          <Section aria-labelledby="related-features">
            <Reveal>
              <h2 id="related-features" className={`text-[22px] text-white md:text-[26px] ${TITLE}`}>
                Related features
              </h2>
              <NextLinks
                className="mt-8"
                items={related.map((r) => ({ href: `/features/${r.slug}`, title: r.name, body: r.subheadline }))}
              />
            </Reveal>
          </Section>
        )}

        <HorizonClose
          title={`Try it on a live project`}
          lede="One free project, no card. Connect your agent over MCP and read the verification evidence yourself."
        >
          <StartButton />
          <ButtonLink href="/resources/connect-your-coding-agent" variant="secondary">
            Connect your agent
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
