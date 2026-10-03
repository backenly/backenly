import type { Metadata } from 'next'
import type { ComponentType } from 'react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { ConnectTabs } from '@/components/landing/ConnectTabs'
import {
  AuthDiagram,
  DatabaseDiagram,
  FunctionsDiagram,
  RealtimeDiagram,
  RestApiDiagram,
  StorageDiagram,
} from '@/components/landing/CapabilityDiagrams'
import { ArrowLink, ButtonLink, HorizonClose, JsonLd, Page, PageHero, Section, withCode } from '@/components/site/kit'
import { Reveal } from '@/components/site/Reveal'
import { ScrollSpy } from '@/components/site/ScrollSpy'
import { SpotlightPanel } from '@/components/site/SpotlightPanel'
import { StartButton } from '@/components/site/StartButton'
import { HEADING, TITLE } from '@/components/site/tokens'
import { ATLAS, type AtlasGroup, type AtlasVisual } from './data'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Features: Every Capability of the Autonomous Backend',
  description:
    'Everything in Backenly: PostgreSQL with pgvector, PostgREST APIs, auth, storage, realtime, functions and triggers, governed change with approvals and restore points, and a self-healing loop that runs every minute on every plan.',
  keywords: [
    'AI backend features',
    'MCP backend for coding agents',
    'PostgreSQL backend platform',
    'PostgREST REST API',
    'backend authentication',
    'realtime backend',
  ],
  openGraph: {
    title: 'Backenly Features: the complete backend, operated for you',
    description:
      'Postgres, APIs, auth, storage, realtime and functions, built by your coding agent and kept healthy by Backenly after launch.',
    url: `${APP_URL}/features`,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly Features',
    description: 'The complete backend, built by your agent and operated by Backenly.',
  },
  alternates: { canonical: `${APP_URL}/features` },
}

/* ─────────────────────────────────────────────────────────────
   /features: the product catalog.

   The landing page argues; this page answers "does it have X?". So it is
   built as a reference, in the manner of a spec sheet a buyer can scan:
   a sticky index on the left that follows your scroll, and ten groups of
   capabilities on the right, each with the one drawing that shows the
   primitive doing its job (the landing's own figures, not screenshots that go
   stale). Groups without a primitive to draw carry no picture rather than a
   decorative one.
───────────────────────────────────────────────────────────── */

const SIDE_VISUALS: Partial<Record<AtlasVisual, ComponentType>> = {
  database: DatabaseDiagram,
  rest: RestApiDiagram,
  auth: AuthDiagram,
  storage: StorageDiagram,
  realtime: RealtimeDiagram,
  functions: FunctionsDiagram,
}

const softwareSchema = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Backenly',
  url: APP_URL,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Web',
  featureList: ATLAS.flatMap((group) => group.items.map((item) => item.name)),
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
}

export default function FeaturesPage() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(softwareSchema)} />
      <Page>
        <PageHero
          trail={[{ label: 'Home', href: '/' }, { label: 'Features' }]}
          title="The complete backend, operated for you"
          lede="Postgres, APIs, auth, storage, realtime and functions, built by your coding agent over MCP and kept healthy by Backenly after launch."
          actions={
            <>
              <StartButton />
              <ButtonLink href="/resources" variant="secondary">
                Read the docs
              </ButtonLink>
            </>
          }
        />

        <Section flush aria-label="Capabilities">
          <div className="lg:grid lg:grid-cols-[196px_minmax(0,1fr)] lg:gap-14 xl:gap-20">
            <aside className="hidden lg:block">
              <div className="sticky top-[100px]">
                <ScrollSpy
                  label="Capabilities on this page"
                  items={ATLAS.map((group) => ({ id: group.id, label: group.title }))}
                />
              </div>
            </aside>

            <div className="min-w-0">
              {/* Below lg the index becomes a row of jump links. */}
              <nav aria-label="Capabilities on this page" className="-mx-5 mb-12 overflow-x-auto px-5 sm:-mx-6 sm:px-6 lg:hidden">
                <ul className="flex w-max gap-2">
                  {ATLAS.map((group) => (
                    <li key={group.id}>
                      <a
                        href={`#${group.id}`}
                        className="inline-flex h-9 items-center whitespace-nowrap rounded-lg border border-white/[0.10] bg-white/[0.03] px-3.5 text-[14px] text-zinc-300 transition-colors duration-200 hover:border-white/20 hover:text-white"
                      >
                        {group.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>

              {ATLAS.map((group, index) => (
                <AtlasSection key={group.id} group={group} first={index === 0} />
              ))}
            </div>
          </div>
        </Section>

        <HorizonClose
          title="The whole backend, free to start"
          lede="One live project, no card. Connect your agent in one command and judge Backenly by the evidence it gives back."
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

function AtlasSection({ group, first }: { group: AtlasGroup; first: boolean }) {
  const SideVisual = group.visual ? SIDE_VISUALS[group.visual] : undefined
  const titleId = `${group.id}-title`

  return (
    <section
      id={group.id}
      aria-labelledby={titleId}
      className={`scroll-mt-[100px] ${first ? '' : 'mt-20 border-t border-white/[0.08] pt-14 md:mt-28 md:pt-16'}`}
    >
      <Reveal>
        <h2 id={titleId} className={`text-[28px] text-white [text-wrap:balance] md:text-[36px] ${TITLE}`}>
          {group.title}
        </h2>
        <p className="mt-4 max-w-[58ch] text-[16px] leading-[1.65] tracking-[-0.008em] text-zinc-400 [text-wrap:pretty] md:text-[17px]">
          {group.lede}
        </p>

        <div className={`mt-10 ${SideVisual ? 'grid gap-10 xl:grid-cols-[minmax(0,1fr)_400px] xl:gap-14' : ''}`}>
          <div className="min-w-0">
            <ul className={`grid gap-x-10 gap-y-8 sm:grid-cols-2 ${SideVisual ? '' : 'xl:grid-cols-3'}`}>
              {group.items.map((item) => {
                const ItemIcon = item.icon
                return (
                  <li key={item.name} className="flex min-w-0 gap-4">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.09] bg-white/[0.03]">
                      <ItemIcon aria-hidden className="h-4 w-4 text-zinc-300" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0">
                      <h3 className={`text-[15px] text-white ${HEADING}`}>{item.name}</h3>
                      <p className="mt-1.5 text-[14px] leading-[1.6] text-zinc-400 [text-wrap:pretty]">
                        {withCode(item.body)}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>

            {group.deepDive && (
              <ArrowLink href={`/features/${group.deepDive.slug}`} className="mt-10">
                {group.deepDive.label}
              </ArrowLink>
            )}
          </div>

          {SideVisual && (
            <SpotlightPanel className="px-6 pb-6 xl:-mt-2 xl:self-start">
              <SideVisual />
            </SpotlightPanel>
          )}
        </div>

        {group.visual === 'connect' && (
          <div className="mt-12">
            <ConnectTabs />
          </div>
        )}
      </Reveal>
    </section>
  )
}
