import type { Metadata } from 'next'
import type { ComponentType } from 'react'
import { notFound } from 'next/navigation'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { SiteShell } from '@/components/site/SiteShell'
import { Box, BoxHead, Cells, type BoxLight } from '@/components/landing-v8/Box'
import { AuthDiagram, DatabaseDiagram, RestApiDiagram } from '@/components/landing-v8/diagrams'
import { RepairChart } from '@/components/landing-v8/autonomy/RepairChart'
import { RestructurePlan } from '@/components/landing-v8/autonomy/RestructurePlan'
import { HistoryRecord } from '@/components/landing-v8/autonomy/HistoryRecord'
import { ButtonLink, HorizonClose, JsonLd, NextLinks, Page, PageHero, Section, SectionHead, withCode } from '@/components/site/kit'
import { Faq } from '@/components/site/Faq'
import { StartButton } from '@/components/site/StartButton'
import { TITLE } from '@/components/site/tokens'
import { FEATURES, FEATURE_SLUGS } from '../data'

const APP_URL = 'https://backenly.com'

/**
 * The agent page's figure: one real session, set as a conversation rather than
 * a terminal transcript. It names real tools (read_backend_state,
 * apply_migration) and the real refusal path.
 */
const AGENT_TURNS: { who: 'You' | 'Agent'; tool?: string; text: string }[] = [
  { who: 'You', text: 'What tables does this project have?' },
  { who: 'Agent', tool: 'read_backend_state', text: 'users, recipes, follows and favorites, with their columns, types and relations.' },
  { who: 'You', text: 'Add saved_searches with user_id and query.' },
  { who: 'Agent', tool: 'apply_migration', text: 'Applied. Served at /db/saved_searches straight away.' },
  { who: 'You', text: 'Drop the users table.' },
  { who: 'Agent', text: 'Not available over MCP. Sent to the Review Queue with its 1,284 live rows; approve it in the dashboard.' },
]

function AgentSession() {
  return (
    <figure className="overflow-hidden rounded-[8px] border border-white/[0.07] bg-[#0a0a0d]">
      <figcaption className="border-b border-white/[0.07] px-[20px] py-[14px] text-[12.5px] text-faint sm:px-[28px]">
        A session with your coding agent, over MCP
      </figcaption>
      <ol className="divide-y divide-white/[0.05]">
        {AGENT_TURNS.map((turn, i) => (
          <li key={i} className="grid grid-cols-[52px_minmax(0,1fr)] gap-x-[16px] px-[20px] py-[14px] sm:grid-cols-[64px_minmax(0,1fr)] sm:px-[28px]">
            <span className={`text-[13px] leading-[22px] ${turn.who === 'You' ? 'text-white' : 'text-violet-200'}`}>{turn.who}</span>
            <p className="text-[14.5px] leading-[22px] text-zinc-300 [text-wrap:pretty]">
              {turn.tool && (
                <span className="mr-[8px] inline-flex h-[20px] items-center rounded-[5px] border border-white/[0.10] bg-white/[0.03] px-[6px] align-[1px] font-mono text-[12px] text-zinc-200">
                  {turn.tool}
                </span>
              )}
              {turn.text}
            </p>
          </li>
        ))}
      </ol>
    </figure>
  )
}

/**
 * Each page opens with the landing's own figure for its capability (site-wide
 * pass, 2026-11-15), in a lit box whose cells are the page's "What you get".
 * The figures' claims are the landing's, checked when it shipped (#776); the
 * diagrams are components/landing-v8/diagrams.
 */
const FIGURES: Record<string, { title: string; body: string; Visual: ComponentType; light: BoxLight; small?: boolean }> = {
  'deployment-ready-backends': {
    title: 'A slow lookup, found and fixed',
    body: 'Backenly checks every project every minute. Here it adds a missing index at 03:07, then holds your agent’s risky request for a person at 03:12.',
    Visual: RepairChart,
    light: { art: 'c' },
  },
  'self-restructuring-schema': {
    title: 'A restructure you approve',
    body: 'Rehearsed on a copy of the real rows, run in stages while apps keep working, then judged on what it changed.',
    Visual: RestructurePlan,
    light: { art: 'a', flip: true },
  },
  'undo-and-rollback': {
    title: 'One project’s day, on the record',
    body: 'One change is restored, and the change made after it stays.',
    Visual: HistoryRecord,
    light: { art: 'b' },
  },
  'database-setup': {
    title: 'One schema per project',
    body: 'Each project is its own Postgres schema. Isolation is a Postgres grant, not a WHERE clause.',
    Visual: DatabaseDiagram,
    light: { art: 'a' },
    small: true,
  },
  'api-generation': {
    title: 'A table becomes an endpoint',
    body: 'Every table is served by PostgREST the moment it exists, with filters, related rows and counts.',
    Visual: RestApiDiagram,
    light: { art: 'c' },
    small: true,
  },
  authentication: {
    title: 'A signing secret per project',
    body: 'Passwords, Google sign-in and magic links, with tokens signed by a secret no other project shares.',
    Visual: AuthDiagram,
    light: { art: 'b' },
    small: true,
  },
  'ai-backend-generation': {
    title: 'Your agent, over MCP',
    body: 'It reads the backend, changes it with typed tools, and sends anything destructive to a person.',
    Visual: AgentSession,
    light: { art: 'a' },
  },
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
   text, no big banners). 2026-11-15 (site-wide pass, to match the v8
   landing): a header, then one lit box with the landing's own figure for the
   capability and "What you get" as its cells, then questions, related
   capabilities and the close. The terminal transcripts gave way to the
   landing's figures; the agent page keeps its real session, set as a
   conversation. The operations page's day-and-night drawing (ChangePath) went
   with them: its times contradicted the landing's 03:07 / 03:12 story.

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
  const figure = FIGURES[f.slug]
  const Icon = f.icon

  return (
    <SiteShell footerLit>
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
          rule={false}
          actions={
            <>
              <StartButton />
              <ButtonLink href="/features" variant="secondary">
                All features
              </ButtonLink>
            </>
          }
        />

        {/* The landing's figure for this capability, then what you get as the box's cells, as every landing box is built. */}
        <Box id="what-you-get" light={figure?.light ?? { art: 'a' }} className="!pt-[8px] md:!pt-[16px]">
          {/* A small drawing sits beside the words in the landing's figure panel; a wide figure takes the box's width under them. */}
          <BoxHead
            id="what-you-get"
            layout={figure?.small ? 'split' : 'stacked'}
            tag={{ icon: Icon, label: f.name }}
            title={figure?.title ?? 'What you get'}
            body={figure?.body ?? f.subheadline}
            visual={
              figure &&
              (figure.small ? (
                <div className="min-w-0 rounded-[8px] border border-white/[0.07] bg-[#0a0a0d] px-[20px] pb-[16px] pt-[4px] sm:px-[28px]">
                  <figure.Visual />
                </div>
              ) : (
                <figure.Visual />
              ))
            }
          />
          <Cells
            cols={f.details.length === 3 ? 3 : 4}
            items={f.details.map((detail) => ({ title: detail.title, body: withCode(detail.body) }))}
          />
        </Box>

        <Section aria-labelledby="feature-faq">
          <div className="grid gap-[40px] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-[64px]">
            <div className="lg:sticky lg:top-[112px] lg:self-start">
              <SectionHead id="feature-faq" title="Questions" />
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
