import type { Metadata } from 'next'
import {
  Activity,
  Bot,
  Braces,
  Code2,
  Database,
  FlaskConical,
  FolderOpen,
  History,
  KeyRound,
  Layers,
  LineChart,
  Radio,
  Ruler,
  Server,
  Split,
  Zap,
} from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { graph, softwareNode } from '@/lib/seo/schema'
import { SiteShell } from '@/components/site/SiteShell'
import { Box, BoxHead, BoxLink, Cells, type CellItem } from '@/components/landing-v8/Box'
import { CommandBlock } from '@/components/landing-v8/CommandBlock'
import { ButtonLink, HorizonClose, JsonLd, Page, PageHero } from '@/components/site/kit'
import { StartButton } from '@/components/site/StartButton'
import { ATLAS, type AtlasGroup, type Capability } from './data'

export const metadata: Metadata = pageMetadata({
  title: 'Features: Postgres, APIs, auth, storage, realtime',
  description:
    'Everything in Backenly: PostgreSQL with pgvector, PostgREST APIs, auth, storage, realtime, functions, undo for any change, self-healing and restructuring.',
  path: '/features',
  social: {
    title: 'Backenly Features: the complete backend, operated for you',
    description:
      'Postgres, APIs, auth, storage, realtime and functions, built by your coding agent and kept healthy by Backenly after launch.',
  },
})

/* ─────────────────────────────────────────────────────────────
   /features, in the landing's grammar (site-wide pass, 2026-11-15: "our
   landing page is now world class but remaining pages are not matching").

   The whole catalog in four lit boxes, in the order of the page's one
   sentence: built by your coding agent (Agents), everything your backend
   needs (Platform), kept running by Backenly (Autonomy), then Teams and
   hosting. Each part of the backend is a cell with its sentence, the list of
   what is in it, and a link to the page that explains it. Every name and
   sentence comes from ATLAS (./data.ts) or from the landing's own boxes;
   a plan tag says what a part needs, so nobody reads a Pro feature as Free.
───────────────────────────────────────────────────────────── */

// The home page's product node (same @id), with this page's full catalog as its feature list.
const softwareSchema = graph({
  ...softwareNode,
  featureList: ATLAS.flatMap((group) => group.items.map((item) => item.name)),
})

/** Literal for the reason app/alternatives gives (SiteShell's ROUTES is a client reference here): keep it equal to ROUTES.github. */
const GITHUB = 'https://github.com/backenly/backenly'

function group(id: string): AtlasGroup {
  const found = ATLAS.find((g) => g.id === id)
  if (!found) throw new Error(`features: no catalog group "${id}"`)
  return found
}

/** What is in a part of the backend, as a plain list; a plan tag where a part needs one. */
function Parts({ items, className = '' }: { items: Capability[]; className?: string }) {
  return (
    <ul className={`grid gap-[10px] ${className}`}>
      {items.map((item) => {
        const ItemIcon = item.icon
        return (
          <li key={item.name} className="flex items-start gap-[10px] text-[14px] leading-[1.45] text-zinc-300">
            <ItemIcon aria-hidden className="mt-[2px] h-[15px] w-[15px] shrink-0 text-zinc-400" strokeWidth={1.75} />
            <span className="min-w-0">
              {item.name}
              {item.plan && (
                <span className="ml-[8px] inline-flex h-[18px] items-center rounded-[4px] border border-white/[0.12] px-[5px] align-[1px] text-[11.5px] font-medium text-zinc-300">
                  <span className="sr-only">(</span>
                  {item.plan}
                  <span className="sr-only"> plan)</span>
                </span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** A box's inventory beside its words: the landing's figure panel. */
function Panel({ children }: { children: React.ReactNode }) {
  // min-w-0: the command's one unbreakable line would otherwise set the column's width and push the box past a phone's edge.
  return <div className="min-w-0 rounded-[8px] border border-white/[0.07] bg-[#0a0a0d] p-[20px] sm:p-[28px]">{children}</div>
}

/** A cell for one part of the backend: its sentence, what is in it, and where it is explained. */
function partCell(id: string, icon: CellItem['icon'], fallback: { href: string; link: string }): CellItem {
  const g = group(id)
  return {
    icon,
    title: g.title,
    body: g.lede,
    list: <Parts items={g.items} />,
    ...(g.deepDive ? { href: `/features/${g.deepDive.slug}`, link: 'How it works' } : fallback),
  }
}

export default function FeaturesPage() {
  const agents = group('agents')
  const autonomy = group('autonomy')
  const hosting = group('platform')
  const docs = (slug: string) => ({ href: `/docs/${slug}`, link: 'Read the docs' })

  return (
    <SiteShell footerLit>
      <JsonLd json={safeJsonLd(softwareSchema)} />
      <Page>
        <PageHero
          trail={[{ label: 'Home', href: '/' }, { label: 'Features' }]}
          title="Features"
          lede="Everything your backend needs, built by your coding agent and kept running by Backenly."
          rule={false}
        />

        <Box id="agents-title" light={{ art: 'a' }} className="!pt-[8px] md:!pt-[16px]">
          <BoxHead
            id="agents-title"
            tag={{ icon: Bot, label: 'Agents' }}
            title="Built by your coding agent"
            body={agents.lede}
            extra={agents.deepDive && <BoxLink href={`/features/${agents.deepDive.slug}`}>How it works</BoxLink>}
            visual={
              <Panel>
                <CommandBlock />
                <p className="mt-[12px] text-[13px] leading-[1.5] text-faint">Asks for your project&apos;s MCP key, then prints the setup for Claude Code, Codex, Cursor or Cline.</p>
                <Parts items={agents.items} className="mt-[24px] border-t border-white/[0.07] pt-[24px] sm:grid-cols-2 sm:gap-x-[24px]" />
              </Panel>
            }
          />
        </Box>

        <Box id="platform-title" light={{ art: 'c' }}>
          <BoxHead
            id="platform-title"
            layout="stacked"
            tag={{ icon: Layers, label: 'Platform' }}
            title="Every part of the backend"
            body="Standard PostgreSQL with REST APIs, auth, storage, realtime and functions, in a schema of your own."
          />
          <Cells
            cols={3}
            items={[
              partCell('database', Database, docs('database')),
              partCell('apis', Braces, docs('database')),
              partCell('auth', KeyRound, docs('auth')),
              partCell('storage', FolderOpen, docs('storage')),
              partCell('realtime', Radio, docs('realtime')),
              partCell('functions', Zap, docs('functions')),
            ]}
          />
        </Box>

        <Box id="autonomy-title" light={{ art: 'a', flip: true }}>
          <BoxHead
            id="autonomy-title"
            layout="stacked"
            tag={{ icon: Activity, label: 'Autonomy' }}
            title="Kept running after launch"
            body="Backenly checks every project every minute, fixes what is safe on its own and holds risky changes for you."
          />
          <Cells
            cols={3}
            items={[
              {
                icon: Activity,
                title: 'Self-healing',
                body: autonomy.lede,
                list: <Parts items={autonomy.items.filter((item) => !item.name.startsWith('Restructuring'))} />,
                href: autonomy.deepDive ? `/features/${autonomy.deepDive.slug}` : '/docs/autonomy',
                link: 'How it works',
              },
              {
                icon: Split,
                title: 'Restructuring',
                body: 'When a table starts doing two jobs, Backenly separates them once you approve.',
                list: (
                  <Parts
                    items={[
                      { icon: Ruler, name: 'Measured first' },
                      { icon: FlaskConical, name: 'Rehearsed on a copy' },
                      { icon: Code2, name: 'Apps keep working' },
                      { icon: LineChart, name: 'Judged afterwards' },
                    ]}
                  />
                ),
                href: '/features/self-restructuring-schema',
                link: 'How it works',
              },
              partCell('governance', History, docs('autonomy')),
            ]}
          />
        </Box>

        <Box id="hosting-title" light={{ art: 'b' }}>
          <BoxHead
            id="hosting-title"
            tag={{ icon: Server, label: 'Teams and hosting' }}
            title="Your team, your servers"
            body={hosting.lede}
            extra={<BoxLink href={GITHUB}>View on GitHub</BoxLink>}
            visual={
              <Panel>
                <Parts items={hosting.items} className="sm:grid-cols-2 sm:gap-x-[24px]" />
              </Panel>
            }
          />
        </Box>

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
