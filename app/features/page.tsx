import type { Metadata } from 'next'
import type { ComponentType } from 'react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { graph, softwareNode } from '@/lib/seo/schema'
import { SiteShell } from '@/components/site/SiteShell'
import {
  AuthDiagram,
  DatabaseDiagram,
  FunctionsDiagram,
  RealtimeDiagram,
  RestApiDiagram,
  StorageDiagram,
} from '@/components/landing/CapabilityDiagrams'
import { BentoCell } from '@/components/landing-v7/shared'
import { ArrowLink, ButtonLink, HorizonClose, JsonLd, Page, PageHero, Section } from '@/components/site/kit'
import { StartButton } from '@/components/site/StartButton'
import { HEADING } from '@/components/site/tokens'
import { ATLAS, type AtlasGroup, type AtlasVisual } from './data'

export const metadata: Metadata = pageMetadata({
  title: 'Features: Postgres, APIs, auth, storage, realtime',
  description:
    'Everything in Backenly: PostgreSQL with pgvector, PostgREST APIs, auth, storage, realtime, functions, governed changes with restore points, and self-healing.',
  path: '/features',
  social: {
    title: 'Backenly Features: the complete backend, operated for you',
    description:
      'Postgres, APIs, auth, storage, realtime and functions, built by your coding agent and kept healthy by Backenly after launch.',
  },
})

/* ─────────────────────────────────────────────────────────────
   /features (2026-10-15, founders: "clean and professional, no jargon, no
   lots of text, no big banners").

   The whole product as one bento in the landing's system and rhythm
   (2+1 / 1+1+1 / 1+1+1 / 2+1): each capability is a cell with its title, one
   plain sentence, its parts as chips, and the landing's own drawing where the
   capability has one. Chips name what is there; a plan tag says what a part
   needs, so nobody reads a Pro feature as a Free one. The longer explanations
   are on the deep-dive pages and in the docs.
───────────────────────────────────────────────────────────── */

const VISUALS: Record<AtlasVisual, ComponentType> = {
  database: DatabaseDiagram,
  rest: RestApiDiagram,
  auth: AuthDiagram,
  storage: StorageDiagram,
  realtime: RealtimeDiagram,
  functions: FunctionsDiagram,
}

/** Cells that take two columns from lg up. */
const WIDE = new Set(['database', 'autonomy'])

/** The bento's order, by group id. */
const ORDER = ['database', 'agents', 'apis', 'auth', 'storage', 'realtime', 'functions', 'governance', 'autonomy', 'platform']

// The home page's product node (same @id), with this page's full catalog as
// its feature list.
const softwareSchema = graph({
  ...softwareNode,
  featureList: ATLAS.flatMap((group) => group.items.map((item) => item.name)),
})

export default function FeaturesPage() {
  const groups = ORDER.map((id) => ATLAS.find((g) => g.id === id)).filter((g): g is AtlasGroup => Boolean(g))

  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(softwareSchema)} />
      <Page>
        <PageHero
          trail={[{ label: 'Home', href: '/' }, { label: 'Features' }]}
          title="Features"
          lede="Everything your backend needs, built by your coding agent and kept running by Backenly."
        />

        <Section flush aria-label="Capabilities">
          <ul className="grid gap-[12px] md:grid-cols-2 lg:grid-cols-3">
            {groups.map((group) => (
              <li key={group.id} className={`min-w-0 ${WIDE.has(group.id) ? 'md:col-span-2' : ''}`}>
                <FeatureCell group={group} wide={WIDE.has(group.id)} />
              </li>
            ))}
          </ul>
        </Section>

        <HorizonClose title="The whole backend, free to start" lede="One live project, no credit card.">
          <StartButton />
          <ButtonLink href="/pricing" variant="secondary">
            See pricing
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}

function FeatureCell({ group, wide }: { group: AtlasGroup; wide: boolean }) {
  const Visual = group.visual ? VISUALS[group.visual] : undefined
  const titleId = `${group.id}-title`

  const head = (
    <div className="min-w-0">
      <h2 id={titleId} className={`text-[19px] text-white ${HEADING}`}>
        {group.title}
      </h2>
      <p className="mt-[10px] max-w-[46ch] text-[15px] leading-[1.7] tracking-[-0.004em] text-zinc-400 [text-wrap:pretty]">
        {group.lede}
      </p>
    </div>
  )

  const chips = (
    <ul className="flex flex-wrap gap-[6px]" aria-label={`${group.title}: what is included`}>
      {group.items.map((item) => {
        const ItemIcon = item.icon
        return (
          <li
            key={item.name}
            className="inline-flex items-center gap-[7px] rounded-[6px] border border-white/[0.08] bg-white/[0.03] px-[10px] py-[5px] text-[13px] text-zinc-300"
          >
            <ItemIcon aria-hidden className="h-[13px] w-[13px] shrink-0 text-zinc-500" strokeWidth={1.75} />
            {item.name}
            {item.plan && (
              <span className="rounded-[4px] border border-white/[0.10] px-[5px] text-[10.5px] font-medium leading-[16px] text-zinc-400">
                {item.plan}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )

  const more = group.deepDive && (
    <ArrowLink href={`/features/${group.deepDive.slug}`}>
      {group.deepDive.label}
    </ArrowLink>
  )

  return (
    <section id={group.id} aria-labelledby={titleId} className="h-full scroll-mt-[100px]">
      <BentoCell className="h-full">
        {wide ? (
          <div className={`grid h-full gap-[32px] ${Visual ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-end' : 'lg:grid-cols-2'}`}>
            <div className="flex h-full min-w-0 flex-col">
              {head}
              <div className="mt-[24px]">{Visual ? chips : more}</div>
              {Visual && more && <div className="mt-auto pt-[24px]">{more}</div>}
            </div>
            {Visual ? <Visual /> : <div className="min-w-0 lg:self-center">{chips}</div>}
          </div>
        ) : (
          <div className="flex h-full flex-col">
            {head}
            <div className="mt-[20px]">{chips}</div>
            {Visual && (
              <div className="mt-auto">
                <Visual />
              </div>
            )}
            {more && <div className={Visual ? 'pt-[24px]' : 'mt-auto pt-[24px]'}>{more}</div>}
          </div>
        )}
      </BentoCell>
    </section>
  )
}
