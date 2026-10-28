import type { Metadata } from 'next'
import type { ComponentType } from 'react'
import { notFound } from 'next/navigation'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { SiteShell } from '@/components/site/SiteShell'
import { CodeBlock } from '@/components/site/CodeBlock'
import { AuthDiagram, DatabaseDiagram, RestApiDiagram } from '@/components/landing/CapabilityDiagrams'
import { ChangePath } from '@/components/landing/ChangePath'
import { ButtonLink, HorizonClose, JsonLd, NextLinks, Page, PageHero, Section, SectionHead, withCode } from '@/components/site/kit'
import { Faq } from '@/components/site/Faq'
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
 * The agent page shows a session rather than a drawing. It names real tools
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

/**
 * The restructuring and undo pages show the same kind of session. Restructuring
 * reads a proposal the way autonomy { action: "evolution" } words it
 * (lib/structural-evolution/words.ts); undo is a change that was verified and
 * still broke the app, undone through the real deploy actions (changes,
 * revert_change). In both, a person approves, never the agent.
 */
const RESTRUCTURE_SESSION = `You:   Why is Backenly asking about
       orders?
Agent: autonomy evolution
       Move refund data out of orders
       into its own table. The refund
       columns are set later in an
       order's life, and changing them
       has been locking orders.
       Rehearsed on a copy. Waiting
       for your approval.
You:   (approves it in the dashboard)
       Later: is it done?
Agent: autonomy evolution
       order_refunds is open. Apps that
       use orders keep working, and undo
       puts orders back as it was.`

const UNDO_SESSION = `You:   Checkout broke after the last
       change. Undo it.
Agent: deploy changes
       #41 renamed orders.total to
       amount. Verified.
Agent: deploy revert_change #41
       Parked for your approval:
       amount goes back to total.
       No data is set aside.
You:   (approves it in the dashboard)
Agent: check_approval: executed.
       Checkout reads total again, and
       every order since is still there.`

/** The pages that show a session in place of a drawing. */
const HERO_SESSIONS: Record<string, { code: string; label: string } | undefined> = {
  'ai-backend-generation': { code: AGENT_SESSION, label: 'Your agent, over MCP' },
  'self-restructuring-schema': { code: RESTRUCTURE_SESSION, label: 'A restructuring, over MCP' },
  'undo-and-rollback': { code: UNDO_SESSION, label: 'Undoing a change, over MCP' },
}

export function generateStaticParams() {
  return FEATURE_SLUGS.map((slug) => ({ slug }))
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params
  const f = FEATURES[params.slug]
  if (!f) return { title: 'Not Found' }

  return pageMetadata({ title: f.metaTitle, description: f.metaDescription, path: `/features/${f.slug}` })
}

/* ─────────────────────────────────────────────────────────────
   One capability in depth (2026-10-15, founders: clean, no jargon, no lots of
   text, no big banners). A compact header beside the capability's drawing,
   then what you get as four cells, the change path on the operations page,
   questions, related capabilities, the close.

   The long-form fields in data.ts (what / how / why / inPractice) are no
   longer rendered: they were three essays between the header and the cells.
───────────────────────────────────────────────────────────── */

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
  const session = HERO_SESSIONS[f.slug]
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
            ) : session ? (
              <CodeBlock code={session.code} label={session.label} language="text" />
            ) : undefined
          }
        />

        <Section flush aria-labelledby="what-you-get">
          <SectionHead id="what-you-get" size="sm" title="What you get" />
          <div className="mt-[40px] grid gap-[12px] md:grid-cols-2">
            {f.details.map((detail) => (
              <SpotlightPanel key={detail.title} className="p-[24px] md:p-[28px]">
                <h3 className={`text-[17px] text-white ${HEADING}`}>{detail.title}</h3>
                <p className="mt-[10px] max-w-[52ch] text-[15px] leading-[1.7] tracking-[-0.004em] text-zinc-400 [text-wrap:pretty]">
                  {withCode(detail.body)}
                </p>
              </SpotlightPanel>
            ))}
          </div>
        </Section>

        {isOperationsPage && (
          <Section aria-label="One day and night on production">
            <ChangePath />
          </Section>
        )}

        <Section aria-labelledby="feature-faq">
          <div className="grid gap-[40px] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-[64px]">
            <div className="lg:sticky lg:top-[112px] lg:self-start">
              <SectionHead id="feature-faq" size="sm" title="Questions" />
            </div>
            <Faq items={f.faq} />
          </div>
        </Section>

        {related.length > 0 && (
          <Section aria-labelledby="related-features">
            <h2 id="related-features" className={`text-[22px] text-white md:text-[26px] ${TITLE}`}>
              Related features
            </h2>
            <NextLinks
              className="mt-[32px]"
              items={related.map((r) => ({ href: `/features/${r.slug}`, title: r.name }))}
            />
          </Section>
        )}

        <HorizonClose title="Try it on a live project" lede="One free project, no credit card.">
          <StartButton />
          <ButtonLink href="/docs/connect" variant="secondary">
            Connect your agent
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
