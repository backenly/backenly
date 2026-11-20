import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeftRight, ArrowRight, ArrowUpRight, Bot, Check, Code2, Import, ListChecks, RefreshCw, Route, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata, SITE_URL } from '@/lib/seo/metadata'
import { graph, ORGANIZATION_ID } from '@/lib/seo/schema'
import { SiteShell } from '@/components/site/SiteShell'
import { CloseBox, JsonLd, Page, Trail } from '@/components/site/kit'
import { Faq } from '@/components/site/Faq'
import { Box, BoxHead, Cells, Light, Tag, type CellItem } from '@/components/landing-v8/Box'
import { CONTAINER, PRIMARY_CTA, SECONDARY_CTA } from '@/components/site/tokens'
import { migrationPublished } from '@/components/migrate/flag'
import { AcrossList } from '@/components/migrate/AcrossList'
import { HeroMove } from '@/components/migrate/HeroMove'
import { MoveLedger } from '@/components/migrate/MoveLedger'
import { MoveSteps } from '@/components/migrate/MoveSteps'
import { SourceTabs } from '@/components/migrate/SourceTabs'
import { ConnectPreview, WhatMoves } from '@/components/migrate/Welcome'
import { DEMO_PLANS, durationOf, progressAt } from '@/components/migrate/plan'
import type { SourceId } from '@/components/migrate/sources'
import {
  ACROSS,
  DESCRIPTION,
  FAQ,
  FIREBASE_NEEDS,
  FIREBASE_NOTES,
  GUIDE_PATH,
  GUIDE_UPDATED,
  POSTGRES_NEEDS,
  STEPS,
  SUPABASE_NEEDS,
  SUPABASE_NOTES,
  TITLE,
} from './content'

/* ─────────────────────────────────────────────────────────────
   /migrate: moving a project in (2026-11-14; rebuilt 2026-11-15, founders:
   "make the migration guide more professional, more animated ... use
   creativity").

   A product page in the landing's language rather than a guide document:
   - the hero shows the product's own move screen playing an example
     project (components/migrate/MoveLedger), in a softly lit frame, with
     the source to play picked beside it;
   - "How a move works" walks through Connect, Review and Move beside each
     step's real screen, by itself while on screen, holding still while read;
   - the sources are tabs (#supabase, #firebase, #postgres), each with what
     it needs, its Connect screen and "what comes across" drawn as lines that
     end in an arrow, an approval gate or a stop;
   - after the move as the landing's cells; the questions; the closing.

   The words are app/migrate/content.ts, checked against the importer as
   built on 2026-11-21, as are the words below. The page and its links wait
   for NEXT_PUBLIC_MIGRATION=published (components/migrate/flag.ts).
   Violet stays low (founders, 2026-11-15: less of the purple).
───────────────────────────────────────────────────────────── */

export const metadata: Metadata = pageMetadata({
  title: 'Migrate from Supabase or Firebase to Backenly',
  description: DESCRIPTION,
  path: GUIDE_PATH,
  type: 'article',
  modifiedTime: GUIDE_UPDATED,
})

const URL = `${SITE_URL}${GUIDE_PATH}`
// Nothing reads `start` yet: signup lands on /app, and the import is the
// "Import it" link under Create your first project (components/onboarding/WelcomeDialog.tsx).
const START = '/auth/signup?start=move'
// Literal, not SiteShell's ROUTES: that object comes from a client module and is undefined in a server page.
const FOUNDERS_HREF = 'https://calendly.com/adarsh-c-jose/30min'

const SUMMARY =
  'Backenly copies a project into a new Backenly project: its tables and rows, its users with their passwords, and its files. Your old project is only read, so your app keeps running there until you switch it over.'

/** Three facts from the guide's own pages, set under the actions. */
const HERO_FACTS = [
  'Backenly only reads your old project. Nothing there changes.',
  'Users who sign in with a password keep it.',
  'Every table is counted on both sides before the move is done.',
]

const structuredData = graph(
  {
    '@type': 'TechArticle',
    headline: TITLE,
    description: DESCRIPTION,
    datePublished: GUIDE_UPDATED,
    dateModified: GUIDE_UPDATED,
    author: { '@id': ORGANIZATION_ID },
    publisher: { '@id': ORGANIZATION_ID },
    url: URL,
    mainEntityOfPage: { '@type': 'WebPage', '@id': URL },
  },
  {
    '@type': 'FAQPage',
    mainEntity: FAQ.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })),
  },
)

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-[4px] bg-white/[0.06] px-[5px] py-[1px] font-mono text-[0.88em] text-zinc-200">{children}</code>
}

function Dots({ items }: { items: string[] }) {
  return (
    <ul className="grid gap-[12px]">
      {items.map((item) => (
        <li key={item} className="flex gap-[12px] text-[15px] leading-[1.6] text-zinc-300 [text-wrap:pretty]">
          <span aria-hidden className="mt-[10px] h-[4px] w-[4px] shrink-0 rounded-full bg-zinc-500" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  )
}

function SourcePanel({ id, needs, notes }: { id: SourceId; needs: string[]; notes?: string[] }) {
  const from = id === 'postgres' ? 'Postgres' : id === 'supabase' ? 'Supabase' : 'Firebase'
  return (
    <div className="grid gap-[36px] lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-[48px]">
      <div className="min-w-0">
        <h3 className="text-[17px] font-medium tracking-[-0.012em] text-white">What you need</h3>
        <div className="mt-[16px]">
          <Dots items={needs} />
        </div>
        <div className="mt-[24px]">
          <ConnectPreview source={id} />
        </div>
      </div>
      <div className="min-w-0">
        <h3 className="text-[17px] font-medium tracking-[-0.012em] text-white">What comes across</h3>
        <div className="mt-[16px]">
          <AcrossList rows={ACROSS[id]} from={from} />
        </div>
      </div>
      {notes && (
        <div className="border-t border-white/[0.07] pt-[28px] lg:col-span-2">
          <h3 className="text-[17px] font-medium tracking-[-0.012em] text-white">Good to know</h3>
          <ul className="mt-[16px] grid gap-x-[40px] gap-y-[12px] md:grid-cols-2">
            {notes.map((note) => (
              <li key={note} className="flex gap-[12px] text-[15px] leading-[1.6] text-zinc-300 [text-wrap:pretty]">
                <span aria-hidden className="mt-[10px] h-[4px] w-[4px] shrink-0 rounded-full bg-zinc-500" />
                <span className="min-w-0">{note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** A screen of the first-run move flow, under its own title and line, as the product sets it (components/migrate/Welcome.tsx). */
function StepScreen({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[16px] font-medium tracking-[-0.014em] text-zinc-50">{title}</p>
      <p className="mt-[4px] max-w-[60ch] text-[13px] leading-[1.5] text-zinc-400 [text-wrap:pretty]">{lede}</p>
      <div className="mt-[14px]">{children}</div>
    </div>
  )
}

const AFTER: CellItem[] = [
  {
    icon: ShieldCheck,
    title: 'Approve the access rules',
    body: 'Backenly translates the row-level security policies it understands into its own access rules and holds them for your approval on the project’s Autonomy page. Firestore Security Rules are not translated. Until a table has rules, only your server key can read or write it, so nothing is open while you check.',
  },
  {
    icon: Code2,
    title: 'Point your app at Backenly',
    body: (
      <>
        From Supabase, most supabase-js code keeps working: import <Code>createClient</Code> from <Code>@backenly/sdk/supabase</Code>{' '}
        instead, and pass it your Backenly project URL and key. Calls to <Code>rpc()</Code> are the exception. From Firebase, the
        app’s SDK calls change; your coding agent can make that change for you.
      </>
    ),
  },
  {
    icon: Bot,
    title: 'Rebuild what stayed behind',
    body: 'Connect your agent over MCP and ask it to rebuild your Edge Functions or Cloud Functions as Backenly functions. Each change it makes is planned, checked and can be undone.',
  },
  {
    icon: RefreshCw,
    title: 'Switch when you are ready',
    body: 'Your old project keeps running, untouched. Move again right before you switch, so the copy is fresh (each move makes a new project), then point your app at Backenly.',
  },
]

export default function MigrationGuide() {
  if (!migrationPublished()) notFound()
  const plan = DEMO_PLANS.supabase
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(structuredData)} />
      <Page>
        {/* The hero: the pitch beside the move itself. */}
        <section aria-labelledby="migrate-title" className="relative">
          <div
            className={`${CONTAINER} grid gap-[44px] pb-[24px] pt-[32px] md:pt-[48px] lg:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)] lg:items-center lg:gap-[56px]`}
          >
            <div className="min-w-0">
              <Trail readable className="hero-enter" items={[{ label: 'Home', href: '/' }, { label: 'Migration guide' }]} />
              <div className="hero-enter mt-[24px]">
                <Tag icon={Import}>Migration guide</Tag>
              </div>
              <h1
                id="migrate-title"
                className="hero-enter hero-enter-1 mt-[20px] max-w-[16ch] text-[42px] font-normal leading-[1.02] tracking-[-0.045em] text-white [text-wrap:balance] sm:text-[52px] lg:text-[60px]"
              >
                {TITLE}
              </h1>
              <p className="hero-enter hero-enter-2 mt-[20px] max-w-[50ch] text-[17px] leading-[1.6] text-zinc-300 [text-wrap:pretty] md:text-[18px]">{SUMMARY}</p>
              <div className="hero-enter hero-enter-3 mt-[28px] flex flex-col gap-[12px] sm:flex-row">
                <Link href={START} className={PRIMARY_CTA}>
                  Move your project
                  <ArrowRight aria-hidden className="h-[16px] w-[16px] transition-transform duration-150 group-hover:translate-x-[2px]" />
                </Link>
                <a href={FOUNDERS_HREF} target="_blank" rel="noopener noreferrer" className={SECONDARY_CTA}>
                  Talk to the founders
                  <ArrowUpRight aria-hidden className="h-[16px] w-[16px]" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </div>
              <ul className="hero-enter hero-enter-3 mt-[32px] grid gap-[10px]">
                {HERO_FACTS.map((fact) => (
                  <li key={fact} className="flex items-start gap-[10px] text-[14.5px] leading-[1.55] text-zinc-300">
                    <Check aria-hidden className="mt-[3px] h-[15px] w-[15px] shrink-0 text-zinc-400" strokeWidth={2} />
                    {fact}
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative isolate min-w-0 overflow-hidden rounded-[12px] border border-white/[0.10] bg-[#0b0c0f] p-[12px] sm:p-[20px]">
              <Light
                art="a"
                reach={760}
                strength={0.5}
                mask="linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.6) 55%, rgba(0,0,0,0.3) 100%)"
              />
              <HeroMove />
            </div>
          </div>
        </section>

        <Box id="how" light={{ art: 'c', strength: 0.35 }}>
          <BoxHead
            id="how"
            layout="stacked"
            tag={{ icon: Route, label: 'How it works' }}
            title="How a move works"
            body="A move copies a project into a new Backenly project and checks it: every table is counted on the old side and the new, and any count that differs is reported. Start one after you sign up, from Import it under Create your first project."
          />
          <div className="border-t border-white/[0.08] p-[16px] sm:p-[28px] lg:p-[40px]">
            <MoveSteps
              steps={STEPS}
              screens={[
                <StepScreen key="connect" title="Connect Supabase" lede="Paste the project’s connection string. Backenly only reads Supabase, and never writes to it.">
                  <ConnectPreview source="supabase" />
                </StepScreen>,
                <StepScreen
                  key="review"
                  title="Review the move"
                  lede={`${plan.project} moves into a new Backenly project. Nothing changes on Supabase, so your app keeps running there until you switch it over.`}
                >
                  <WhatMoves plan={plan} />
                  <dl className="mt-[10px] hidden grid-cols-3 overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#0f1012] sm:grid">
                    {[
                      ['Organization', plan.sourceOrg],
                      ['Project', plan.project],
                      ['Region', plan.region],
                    ].map(([label, value], i) => (
                      <div key={label} className={`min-w-0 px-[16px] py-[10px] ${i > 0 ? 'border-l border-white/[0.06]' : ''}`}>
                        <dt className="text-[12px] text-faint">{label}</dt>
                        <dd className="mt-[2px] truncate text-[13px] text-zinc-200">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </StepScreen>,
                // The finished move is taller than the frame: it fades out where the frame ends.
                <div
                  key="move"
                  className="[mask-image:linear-gradient(to_bottom,#000_360px,transparent_440px)] sm:[mask-image:linear-gradient(to_bottom,#000_280px,transparent_354px)]"
                >
                  <MoveLedger plan={plan} progress={progressAt(plan, durationOf(plan))} />
                </div>,
              ]}
            />
          </div>
        </Box>

        <Box id="sources">
          <BoxHead
            id="sources"
            layout="stacked"
            tag={{ icon: ArrowLeftRight, label: 'Sources' }}
            title="What moves, and what stays"
            body="Pick where your project lives now. Backenly only reads it, so your app keeps running there until you switch it over."
          />
          <div className="border-t border-white/[0.08] p-[16px] sm:p-[28px] lg:p-[40px]">
            <SourceTabs
              panels={{
                supabase: <SourcePanel id="supabase" needs={SUPABASE_NEEDS} notes={SUPABASE_NOTES} />,
                firebase: <SourcePanel id="firebase" needs={FIREBASE_NEEDS} notes={FIREBASE_NOTES} />,
                postgres: <SourcePanel id="postgres" needs={POSTGRES_NEEDS} />,
              }}
            />
          </div>
        </Box>

        <Box id="after" light={{ art: 'b', strength: 0.3 }}>
          <BoxHead
            id="after"
            layout="stacked"
            tag={{ icon: ListChecks, label: 'Next steps' }}
            title="After the move"
            body="Your old project keeps running, untouched, until you point your app at Backenly."
          />
          <Cells items={AFTER} />
        </Box>

        <section aria-labelledby="questions" className="pt-[96px] md:pt-[128px]">
          <div className={`${CONTAINER} grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16`}>
            <div className="lg:sticky lg:top-28 lg:self-start">
              <h2 id="questions" className="scroll-mt-[96px] text-[32px] font-normal leading-[1.08] tracking-[-0.035em] text-white sm:text-[40px]">
                Questions
              </h2>
              <p className="mt-[16px] max-w-[36ch] text-[16px] leading-[1.6] text-zinc-400">Anything else about your move? Ask the people who build it.</p>
              <a
                href={FOUNDERS_HREF}
                target="_blank"
                rel="noopener noreferrer"
                className="group mt-[20px] inline-flex items-center gap-[8px] rounded-[3px] text-[15px] font-medium text-zinc-100 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                Book a call with the founders
                <ArrowUpRight aria-hidden className="h-[15px] w-[15px] text-zinc-400" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </div>
            <Faq items={FAQ} defaultOpen={null} />
          </div>
        </section>

        <CloseBox title="Move your project" lede="Sign up, choose Import it when Backenly asks you to create your first project, and connect Supabase, Firebase or Postgres.">
          <Link href={START} className={PRIMARY_CTA}>
            Move your project
            <ArrowRight aria-hidden className="h-[16px] w-[16px] transition-transform duration-150 group-hover:translate-x-[2px]" />
          </Link>
          <a href={FOUNDERS_HREF} target="_blank" rel="noopener noreferrer" className={SECONDARY_CTA}>
            Talk to the founders
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </CloseBox>
      </Page>
    </SiteShell>
  )
}
