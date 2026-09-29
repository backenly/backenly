'use client'

import { useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion, type Variants } from 'framer-motion'
import { ArrowRight, BookOpen, Calendar, GitBranch, Plug, Plus, ShieldCheck, Terminal, Users } from 'lucide-react'
import { Icon } from '@iconify/react'
import { AutonomyFilm } from '@/components/site/AutonomyFilm'
import {
  AuthDiagram,
  DatabaseDiagram,
  FunctionsDiagram,
  RealtimeDiagram,
  RestApiDiagram,
  StorageDiagram,
} from '@/components/landing/CapabilityDiagrams'
import { AGENT_MARKS, AgentGlyph } from '@/components/landing/AgentMarks'
import { ChangePath } from '@/components/landing/ChangePath'
import { ConnectTabs } from '@/components/landing/ConnectTabs'
import { HeroFilm } from '@/components/landing/HeroFilm'
import { ROUTES, SiteShell } from '@/components/site/SiteShell'
import { BODY, HEADING, LEDE, MEASURE, TITLE } from '@/components/site/tokens'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { useUserSession } from '@/lib/hooks/useUserSession'

/* ─────────────────────────────────────────────────────────────
   The landing page, rebuilt 2026-09-29.

   The brief: an infrastructure landing page in the class of Linear, Supabase
   and Vercel. The previous page was disciplined but flat. Every section
   opened the same way (left headline, grey paragraph, content) on pure black,
   so nothing on it was memorable and the product's actual difference, that it
   GOVERNS change rather than just generating resources, was a sentence in a
   subline.

   The structure now follows the argument a sceptical engineer needs:

     Hero            what it is, and the real product on film
     Agent strip     it plugs into the agent you already use
     Change path     THE centrepiece: one change, planned, gated, applied,
                     verified, recorded (components/landing/ChangePath)
     Primitives      what you get, as a bento with one lead cell
     Connect         how you point your agent at it, per host
     Autonomy        what happens when nobody is at the keyboard
     FAQ             the trust questions, answered plainly
     Closing         one ask

   RULES THAT STILL HOLD FROM EARLIER ROUNDS (they were founder decisions):

   - Hero copy is locked (see project-two-door-positioning). Only its
     presentation moves.
   - No mono, uppercase, wide-tracked eyebrows over section headlines. The
     headline names the section by itself.
   - No self-host vs Cloud band and no "No lock-in" band. Open source lives in
     the FAQ, the footer, and the GitHub button.
   - Every claim on this page must be true of the product today. No invented
     customer logos, testimonials, counts or benchmarks. The agent strip shows
     MCP hosts the server runs in, not partners.

   SIZES ARE `px`. app/globals.css sets the root font-size to 13px, so 1rem is
   13px here and every rem-based Tailwind size renders at 81%. See
   components/site/tokens.ts before converting anything to rem.
───────────────────────────────────────────────────────────── */

/* ── Tokens local to this page ───────────────────────────────────────────── */

/** The page ground: a cool near-black, not #000, so panels can sit above it. */
const GROUND = 'bg-[#08090a]'

/** Aligns with the navbar and footer. 100rem is 1300px here, not 1600px. */
const CONTAINER = 'mx-auto w-full max-w-[100rem] px-5 sm:px-6'

/**
 * Vertical rhythm. Sections own their TOP padding only, so a boundary is one
 * gap rather than two stacked into a well of empty black. The closing section
 * owns the bottom of the page.
 */
const SECTION = 'relative pt-[88px] md:pt-[144px]'

const DISPLAY =
  'font-semibold leading-[1.02] tracking-[-0.045em] md:leading-[0.98]'

const PRIMARY_CTA =
  'group inline-flex h-[46px] items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-white px-5 text-[15px] font-semibold tracking-[-0.01em] text-black shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_8px_30px_-8px_rgba(255,255,255,0.35)] transition-[background-color,transform,box-shadow] duration-200 hover:bg-zinc-200 hover:shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_10px_40px_-8px_rgba(255,255,255,0.45)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]'

const SECONDARY_CTA =
  'group inline-flex h-[46px] items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-white/[0.12] bg-white/[0.03] px-5 text-[15px] font-medium tracking-[-0.01em] text-zinc-200 transition-[background-color,border-color,color,transform] duration-200 hover:border-white/25 hover:bg-white/[0.07] hover:text-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]'

/* ── Motion ──────────────────────────────────────────────────────────────── */

/**
 * One orchestrated entrance for the hero, and a quiet rise for each major
 * block after it. Nothing loops except the product itself.
 *
 * `useSettledReducedMotion` rather than framer's hook: the server has no media
 * query, and letting the preference pick different initial props made server
 * and client disagree at hydration. This hook reads it after hydration, so the
 * first render is identical and reduced-motion visitors then snap to rest.
 */
const EASE_OUT = [0.16, 1, 0.3, 1] as const

const heroItem: Variants = {
  hidden: { opacity: 0, y: 14, filter: 'blur(8px)' },
  visible: { opacity: 1, y: 0, filter: 'blur(0px)' },
}

/**
 * The film rises without the blur: framer leaves `filter` inline after the
 * entrance, and a filter on an ancestor can keep a playing video off the
 * browser's cheap compositing path for as long as the page is open.
 */
const heroFilm: Variants = {
  hidden: { opacity: 0, y: 28 },
  visible: { opacity: 1, y: 0 },
}

const rise: Variants = {
  hidden: { opacity: 0, y: 22 },
  visible: { opacity: 1, y: 0 },
}

export default function LandingPage() {
  return (
    <SiteShell>
      <main id="main-content" className={`relative overflow-x-clip ${GROUND}`}>
        <Grain />
        <Hero />
        <AgentStrip />
        <ChangeSection />
        <PrimitivesSection />
        <ConnectSection />
        <AutonomySection />
        <FaqSection />
        <ClosingSection />
      </main>
    </SiteShell>
  )
}

/**
 * Film grain over the whole page. Fixed and pointer-events-none, so it costs
 * one composited layer instead of repainting with the scroll. It breaks the
 * banding in the large gradients and takes the digital flatness off the black.
 */
function Grain() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-30 opacity-[0.035] mix-blend-overlay"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
      }}
    />
  )
}

/* ─────────────────────────────────────────────────────────────
   Launch chip  ·  TEMPORARY, comes out after the Product Hunt launch

   Flip SHOW_LAUNCH_PILL to false to pull it in one edit. To remove it for
   good, delete this block, its call site in `Hero`, `ROUTES.productHunt`, and
   the `.launch-sweep` rules in app/globals.css.

   Founder decisions, do not "improve" them back:
   - No Product Hunt brand mark and no hard date in the chip (rejected).
   - No dismissible site-wide bar above the navbar (#138, rejected). The
     announcement is this small chip in the hero.
   - The badge is white on black, the page's primary surface recipe. Never
     Product Hunt orange, which would be a third colour.
   - The sweep is a CSS keyframe, not framer-motion: nested in the hero's
     variant tree, a repeating motion.span froze after one pass.
   - It is not a second signup CTA; it is an external link.
───────────────────────────────────────────────────────────── */

const SHOW_LAUNCH_PILL = true

function LaunchPill({ quiet }: { quiet: boolean }) {
  return (
    <motion.div variants={heroItem} transition={{ duration: quiet ? 0 : 0.9, ease: EASE_OUT }} className="mb-8">
      <Link
        href={ROUTES.productHunt}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Launching soon on Product Hunt. Opens in a new tab."
        className="group relative inline-flex items-stretch overflow-hidden rounded-lg border border-white/[0.10] bg-white/[0.03] text-[14px] font-medium text-zinc-300 shadow-[0_16px_50px_-24px_rgba(139,92,246,0.55)] backdrop-blur-sm transition-[border-color,background-color,color,box-shadow] duration-200 hover:border-violet-400/30 hover:bg-white/[0.06] hover:text-white hover:shadow-[0_18px_60px_-22px_rgba(139,92,246,0.8)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]"
      >
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
          <span className="absolute inset-0 bg-gradient-to-r from-transparent via-violet-300/70 to-transparent" />
          <span className="launch-sweep absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-violet-100 to-transparent" />
        </span>
        <span className="flex items-center gap-2.5 py-2 pl-2.5 pr-3.5">
          <span className="rounded bg-white px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-black">
            New
          </span>
          <span className="tracking-[-0.006em]">Launching soon on Product Hunt</span>
        </span>
        <span aria-hidden className="w-px shrink-0 bg-white/[0.10] transition-colors duration-200 group-hover:bg-white/25" />
        <span className="flex items-center px-2.5">
          <ArrowRight
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:text-zinc-300"
          />
        </span>
      </Link>
    </motion.div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Hero

   Left-aligned, stacked: chip, headline, subline, actions, then the film. The
   old layout pushed the one CTA to the far right edge, where it read as
   belonging to nothing. Actions now sit directly under the sentence they act
   on, the way Linear and Vercel set theirs.

   The light is the point of the composition: a cold white key light from the
   top left, a violet fill behind the film, and a horizon line the film sits
   on. All static gradients, no blur filters, so it costs nothing per frame.
───────────────────────────────────────────────────────────── */

function Hero() {
  const quiet = useSettledReducedMotion()
  const { isLoggedIn } = useUserSession()

  return (
    <motion.section
      className="relative isolate pb-[64px] pt-[56px] sm:pt-[72px] md:pb-[88px] md:pt-[96px]"
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: quiet ? 0 : 0.1, delayChildren: quiet ? 0 : 0.05 } },
      }}
    >
      {/* Key light, top left, behind the headline. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[240px] left-[-10%] -z-10 h-[820px] w-[1100px] max-w-none bg-[radial-gradient(closest-side,rgba(255,255,255,0.075),transparent)]"
      />
      {/* Violet fill, the brand's one colour, low and wide behind the film. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[420px] -z-10 h-[900px] w-[1500px] max-w-none -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(139,92,246,0.16),rgba(139,92,246,0.04)_55%,transparent)]"
      />

      <div className={CONTAINER}>
        {SHOW_LAUNCH_PILL && <LaunchPill quiet={quiet} />}

        <motion.h1
          variants={heroItem}
          transition={{ duration: quiet ? 0 : 0.95, ease: EASE_OUT }}
          // One vertical falloff across the whole headline, white to a cool
          // grey, the way a lit object reads. Not a second colour on one
          // phrase: that is the most common tell of a generated hero.
          className={`bg-gradient-to-b from-white from-40% to-zinc-400 bg-clip-text pb-2 text-[38px] text-transparent [text-wrap:balance] sm:text-[60px] md:text-[76px] xl:text-[88px] ${DISPLAY}`}
        >
          The autonomous backend
          <span className="block">built for coding agents</span>
        </motion.h1>

        <motion.p
          variants={heroItem}
          transition={{ duration: quiet ? 0 : 0.95, ease: EASE_OUT }}
          className={`mt-7 max-w-[54ch] text-[17px] text-zinc-400 [text-wrap:pretty] md:mt-8 md:text-[20px] ${LEDE}`}
        >
          Real Postgres, APIs, auth, storage, and realtime, driven by your agent over MCP, with
          every change governed, verified, and reversible.
        </motion.p>

        <motion.div
          variants={heroItem}
          transition={{ duration: quiet ? 0 : 0.95, ease: EASE_OUT }}
          className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center"
        >
          <Link href={isLoggedIn ? ROUTES.app : ROUTES.signup} className={PRIMARY_CTA}>
            {isLoggedIn ? 'Go to console' : 'Start free'}
            <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
          <a href={ROUTES.github} target="_blank" rel="noopener noreferrer" className={SECONDARY_CTA}>
            <Icon icon="ri:github-fill" width={18} aria-hidden />
            Star on GitHub
          </a>
          <span className="mt-1 text-[13px] text-zinc-500 sm:ml-3 sm:mt-0">
            Free plan, no card. Apache-2.0.
          </span>
        </motion.div>

        <motion.div
          variants={heroFilm}
          transition={{ duration: quiet ? 0 : 1.2, ease: EASE_OUT }}
          className="relative mt-[56px] md:mt-[80px]"
        >
          {/* The horizon: a lit edge along the top of the frame. */}
          <div
            aria-hidden
            className="pointer-events-none absolute -top-px left-[8%] right-[8%] z-10 h-px bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.7),rgba(255,255,255,0.9),rgba(196,181,253,0.7),transparent)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-[60px] left-1/2 z-0 h-[120px] w-[70%] -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(167,139,250,0.28),transparent)]"
          />
          <div className="relative rounded-[18px] border border-white/[0.08] bg-white/[0.02] p-1.5 shadow-[0_60px_160px_-40px_rgba(0,0,0,1)] sm:p-2">
            <HeroFilm />
          </div>
        </motion.div>
      </div>
    </motion.section>
  )
}

/* ─────────────────────────────────────────────────────────────
   Agent strip

   Directly under the hero, where a logo wall goes, and honest about what it
   is: the hosts the MCP server runs in. Not customers, not partners.
───────────────────────────────────────────────────────────── */

function AgentStrip() {
  // One quiet line, centred under the film, then the marks alone at one grey.
  // No band, no boxed caption column: a logo row carries its own weight, and
  // anything heavier competes with the hero it sits under.
  return (
    <section aria-labelledby="agents-heading" className="relative pb-[8px] pt-[8px]">
      <div className={CONTAINER}>
        <h2 id="agents-heading" className="text-center text-[14px] tracking-[-0.006em] text-zinc-500">
          Works with the agent you already use, and any other MCP host
        </h2>
        <ul className="mx-auto mt-8 flex max-w-[1080px] flex-wrap items-center justify-center gap-x-10 gap-y-6 md:gap-x-14">
          {AGENT_MARKS.map((mark) => (
            <li
              key={mark.id}
              className="flex items-center gap-2.5 text-zinc-400/80 transition-colors duration-300 hover:text-white"
            >
              <AgentGlyph mark={mark} className="h-[22px] w-[22px] shrink-0" />
              <span className="whitespace-nowrap text-[17px] font-semibold tracking-[-0.03em]">{mark.name}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────
   Change path: the centrepiece
───────────────────────────────────────────────────────────── */

function ChangeSection() {
  return (
    <section id="how-it-works" className={`${SECTION} scroll-mt-20`}>
      <div className={CONTAINER}>
        <Reveal>
          <SectionHead
            title="Your agent moves fast. Every change still takes the same path."
            body="Backenly does not just generate resources. It plans each change, holds anything destructive for a person, applies it with a way back, and proves it works before calling it done."
          />
        </Reveal>
        <Reveal className="mt-[48px] md:mt-[64px]">
          <ChangePath />
        </Reveal>
      </div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────
   Primitives: a bento with one lead cell

   Six primitives and one "also built in" row, set 2+1 / 1+1+1 / 1+2 so the
   grid has a rhythm instead of six identical tiles. The drawings are the
   line-art figures in components/landing/CapabilityDiagrams: each one shows
   the primitive working, and none of them is a screenshot that can go stale.
───────────────────────────────────────────────────────────── */

type Primitive = {
  title: string
  body: string
  diagram: () => JSX.Element
  className?: string
}

const primitives: Primitive[] = [
  {
    title: 'Postgres, a schema of your own',
    body: 'Tables, relations, indexes, constraints and pgvector, in a PostgreSQL schema per project. Isolation is a Postgres grant, not a WHERE clause.',
    diagram: DatabaseDiagram,
  },
  {
    title: 'Auth',
    body: 'Sign-up, OAuth, magic links and verification emails for your users. Each project signs with its own secret.',
    diagram: AuthDiagram,
  },
  {
    title: 'REST APIs',
    body: 'PostgREST serves every table from the catalog: filters, ordering, pagination, embedded resources, OpenAPI.',
    diagram: RestApiDiagram,
  },
  {
    title: 'Realtime',
    body: 'Inserts, updates and deletes as they land, plus presence and broadcast. Delivered over SSE, with no socket server to run.',
    diagram: RealtimeDiagram,
  },
  {
    title: 'Storage',
    body: 'Buckets, uploads, metadata and expiring signed URLs, on local disk or any S3-compatible provider.',
    diagram: StorageDiagram,
  },
  {
    title: 'Functions and triggers',
    body: 'Run code on insert, update, delete or signup, or on a cron schedule. Webhooks and rate limits included.',
    diagram: FunctionsDiagram,
  },
]

const alsoBuiltIn = [
  {
    icon: ShieldCheck,
    title: 'Row-level security by description',
    body: 'Say who can read and write what. Backenly writes and enforces the Postgres policies.',
  },
  {
    icon: GitBranch,
    title: 'Branches for risky work',
    body: 'Clone the backend, let your agent experiment, review the diff, merge what works.',
  },
  {
    icon: Users,
    title: 'Teams and organizations',
    body: 'Invite teammates with roles. Every actor writes to the same change ledger.',
  },
]

const databaseFacts = ['Standard PostgreSQL', 'pgvector', 'Direct connection strings', 'pg_dump exports']

function PrimitivesSection() {
  const [database, auth, rest, realtime, storage, functions] = primitives

  return (
    <section id="capabilities" className={`${SECTION} scroll-mt-20`}>
      <div className={CONTAINER}>
        <Reveal>
          <SectionHead
            title="Every primitive, wired together from the first table"
            body="Not a kit of parts for you to assemble. One backend, where the database, the API, auth, storage, realtime and functions already know about each other."
          />
        </Reveal>

        <Reveal className="mt-[48px] grid gap-3 md:mt-[64px] md:grid-cols-2 lg:grid-cols-3">
          {/* Lead cell: the database, twice as wide, text and drawing side by side. */}
          <BentoCell className="md:col-span-2">
            <div className="grid h-full gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-end">
              <div className="flex h-full flex-col">
                <CellTitle>{database.title}</CellTitle>
                <CellBody>{database.body}</CellBody>
                <ul className="mt-auto flex flex-wrap gap-2 pt-6">
                  {databaseFacts.map((fact) => (
                    <li
                      key={fact}
                      className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[12.5px] text-zinc-300"
                    >
                      {fact}
                    </li>
                  ))}
                </ul>
              </div>
              <database.diagram />
            </div>
          </BentoCell>

          <PrimitiveCell primitive={auth} />
          <PrimitiveCell primitive={rest} />
          <PrimitiveCell primitive={realtime} />
          <PrimitiveCell primitive={storage} />
          <PrimitiveCell primitive={functions} />

          <BentoCell className="md:col-span-2">
            <div className="flex items-baseline justify-between gap-6">
              <CellTitle>Also built in</CellTitle>
              <Link href={ROUTES.features} className={TEXT_LINK}>
                Every feature
                <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
            </div>
            <div className="mt-6 grid gap-x-8 gap-y-7 sm:grid-cols-3">
              {alsoBuiltIn.map((item) => {
                const ItemIcon = item.icon
                return (
                  <div key={item.title} className="border-t border-white/[0.08] pt-5">
                    <ItemIcon aria-hidden className="h-[18px] w-[18px] text-violet-300" strokeWidth={1.75} />
                    <h4 className={`mt-4 text-[15px] text-white ${HEADING}`}>{item.title}</h4>
                    <p className="mt-2 text-[14px] leading-[1.65] text-zinc-400">{item.body}</p>
                  </div>
                )
              })}
            </div>
          </BentoCell>
        </Reveal>
      </div>
    </section>
  )
}

function PrimitiveCell({ primitive }: { primitive: Primitive }) {
  const Diagram = primitive.diagram
  return (
    <BentoCell>
      <CellTitle>{primitive.title}</CellTitle>
      {/* Three-line floor, so the drawings (bottom-aligned) sit on one line
          across a row even when one paragraph wraps shorter. */}
      <CellBody className="md:min-h-[81px]">{primitive.body}</CellBody>
      <div className="mt-auto">
        <Diagram />
      </div>
    </BentoCell>
  )
}

/**
 * A bento cell with a cursor-following spotlight on its border and surface.
 * The pointer position is written straight to CSS custom properties on the
 * element, never to React state, so moving the mouse re-renders nothing.
 */
function BentoCell({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null)

  function onMove(event: PointerEvent<HTMLElement>) {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty('--x', `${event.clientX - rect.left}px`)
    el.style.setProperty('--y', `${event.clientY - rect.top}px`)
  }

  return (
    <article
      ref={ref}
      onPointerMove={onMove}
      className={`group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(255,255,255,0.028),rgba(255,255,255,0.008))] p-6 transition-[border-color] duration-300 hover:border-white/[0.13] md:p-8 ${className}`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            'radial-gradient(420px circle at var(--x, 50%) var(--y, 0%), rgba(167,139,250,0.08), transparent 60%)',
        }}
      />
      <div className="relative flex h-full flex-col">{children}</div>
    </article>
  )
}

function CellTitle({ children }: { children: ReactNode }) {
  return <h3 className={`text-[19px] text-white ${HEADING}`}>{children}</h3>
}

function CellBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p className={`mt-3 max-w-[46ch] text-[15px] leading-[1.7] tracking-[-0.004em] text-zinc-400 ${className}`}>
      {children}
    </p>
  )
}

/* ─────────────────────────────────────────────────────────────
   Connect
───────────────────────────────────────────────────────────── */

const channels = [
  {
    icon: Plug,
    title: 'MCP server',
    body: 'Typed tools for schema, data, auth, storage and functions. Driving the backend this way is never metered as AI.',
  },
  {
    icon: Terminal,
    title: 'CLI',
    body: 'Schema, generated types, CI diffs, logs and read-only SQL: the part of the workflow that belongs in a pipeline.',
  },
  {
    icon: BookOpen,
    title: 'Agent skill',
    body: 'A canonical skill at backenly.com/skill.md, so an agent learns the platform before it touches anything.',
  },
]

function ConnectSection() {
  return (
    <section className={SECTION}>
      <div className={`${CONTAINER} grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16`}>
        <Reveal className="flex flex-col">
          <h2 className={`max-w-[16ch] text-[32px] text-white [text-wrap:balance] md:text-[46px] ${TITLE}`}>
            One command, and your agent reads the real schema
          </h2>
          <p className={`mt-5 ${MEASURE} text-[17px] text-zinc-400 [text-wrap:pretty] ${LEDE}`}>
            The key is scoped to one project and revocable from the dashboard. It can request a
            destructive change, and it can never approve one.
          </p>
          <ul className="mt-10 grid gap-6">
            {channels.map((channel) => {
              const ChannelIcon = channel.icon
              return (
                <li key={channel.title} className="flex gap-4">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.09] bg-white/[0.03]">
                    <ChannelIcon aria-hidden className="h-4 w-4 text-zinc-300" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0">
                    <h3 className={`text-[16px] text-white ${HEADING}`}>{channel.title}</h3>
                    <p className={`mt-1 max-w-[52ch] ${BODY} text-zinc-400`}>{channel.body}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        </Reveal>
        <Reveal delay={0.08} className="lg:pt-2">
          <ConnectTabs />
        </Reveal>
      </div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────
   Autonomy

   The one centred section before the close, and the one place the ground
   changes: a night band, because the claim is about what happens at 03:00.
   The instrument is drawn, not filmed (components/site/AutonomyFilm), so it
   cannot go stale behind the product.
───────────────────────────────────────────────────────────── */

const autonomyFacts = [
  {
    figure: 'Every minute',
    body: 'The loop checks every project on every plan, Free included.',
  },
  {
    figure: 'No model calls',
    body: 'Healing is deterministic, so it never spends your AI credits.',
  },
  {
    figure: 'Snapshot first',
    body: 'Only reversible fixes apply on their own. Anything risky becomes a proposal for you.',
  },
]

function AutonomySection() {
  return (
    // The band's lit top edge is a boundary of its own, so it needs clear
    // ground above it: margin, then the section's usual top padding inside.
    <section className={`${SECTION} mt-[88px] overflow-hidden md:mt-[144px]`}>
      {/* Night: a deep violet dusk falling from the top edge. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[900px] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(76,29,149,0.28),rgba(8,9,10,0))]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.35),transparent)]"
      />

      <div className={`${CONTAINER} relative`}>
        <Reveal className="mx-auto max-w-[760px] text-center">
          <h2 className={`text-[34px] text-white [text-wrap:balance] md:text-[56px] ${TITLE}`}>
            It fixes problems while you sleep
          </h2>
          <p className={`mx-auto mt-5 max-w-[56ch] text-[17px] text-zinc-400 [text-wrap:pretty] md:text-[18px] ${LEDE}`}>
            A resident loop watches every project: detect, fix safely, verify, and write down
            what it did. No prompt, no session, nobody at the keyboard.
          </p>
        </Reveal>

        <Reveal delay={0.06} className="mx-auto mt-[48px] w-full max-w-[1040px] md:mt-[64px]">
          <AutonomyFilm />
        </Reveal>

        <Reveal className="mx-auto mt-[56px] grid max-w-[1040px] gap-px overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.07] md:grid-cols-3">
          {autonomyFacts.map((fact) => (
            <div key={fact.figure} className="bg-[#0a0b0d] p-6 md:p-8">
              <p className="text-[24px] font-semibold tracking-[-0.03em] text-white md:text-[28px]">{fact.figure}</p>
              <p className="mt-2 text-[15px] leading-[1.65] text-zinc-400">{fact.body}</p>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────
   FAQ
───────────────────────────────────────────────────────────── */

const faqs = [
  {
    q: 'How does my coding agent connect?',
    a: 'One command installs the Backenly MCP server for Claude Code, Cursor, Codex, Cline, or any MCP host, or paste the setup prompt and your agent installs it itself. The key is scoped and revocable from your project dashboard. There is also a CLI (npx @backenly/cli) for schema, generated types, CI diffs, logs, and read-only SQL, and a canonical agent skill at backenly.com/skill.md.',
  },
  {
    q: 'What happens when the agent tries something destructive?',
    a: 'The change does not run. It parks as an approval request in the Review Queue with the impact laid out (how many live rows, whether the data is recoverable) and waits for a human to decide in the dashboard. The agent’s key can request and poll, never approve. Every applied change also captures a rollback snapshot first, so even approved changes can be undone.',
  },
  {
    q: 'Is this real production infrastructure, or a prototyping tool?',
    a: 'Real infrastructure: an isolated PostgreSQL schema per project, live REST endpoints, auth with per-project secrets, file storage, and realtime streams. Changes are verified against the running backend with real requests before they count as done, and the autonomy loop keeps monitoring and repairing the backend after you ship.',
  },
  {
    q: 'Is Backenly open source? Can I self-host?',
    a: 'Yes. The entire platform is open source under Apache-2.0, including the autonomy engine, and the SDK, CLI, MCP server, and agent skill are MIT. Self-host everything on your own infrastructure, with your own Postgres. Or use Backenly Cloud, where we run the infrastructure and handle backups and upgrades. It is the same codebase either way, so you can move between the two.',
  },
  {
    q: 'How is this different from Supabase or Firebase?',
    a: 'Like Supabase, Backenly is open source, built on real PostgreSQL, and self-hostable. The difference is who operates it. Supabase and Firebase hand you excellent parts and leave the assembly, configuration, and upkeep to you. You are the operator. Backenly does not just generate resources; it manages backend change safely. Every change is planned, applied with approvals and snapshots, and verified against the runtime, and a resident autonomy loop keeps fixing the running backend, with receipts, when no one is at the keyboard.',
  },
  {
    q: 'Am I locked in?',
    a: 'No. The contract is standard REST plus a typed SDK, and the database is standard PostgreSQL. Every plan, including Free, gets direct read-only and read-write connection strings (psql, TablePlus, any BI tool) and pg_dump exports that restore on any Postgres: RDS, Neon, your own server. And because the platform itself is open source, the exit path includes running Backenly on your own servers. Everything leaves with you, anytime.',
  },
  {
    q: 'What does it cost?',
    a: 'Self-hosting is free under Apache-2.0: you bring the servers, and an OpenAI key only if you want the natural-language build tools. The self-healing loop itself runs no model. On Backenly Cloud, the Free plan is genuinely free, with no credit card, and includes a real, permanent backend plus the self-healing loop every minute. Pro is $25/month and raises capacity and how much autonomy may fix per window, not the cadence; Enterprise is custom. Driving the backend from your own coding agent through the typed MCP tools is never metered as AI, and autonomy is included on every Cloud tier.',
  },
  {
    q: 'If my agent does the building, what is the dashboard for?',
    a: 'Oversight. The dashboard is where you inspect every table, user, file, and function; approve or reject destructive requests in the Review Queue; read the change history and autonomy receipts; manage keys, teams, and branches; and roll anything back. Your agent operates; you stay in command.',
  },
]

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqs.map((faq) => ({
    '@type': 'Question',
    name: faq.q,
    acceptedAnswer: { '@type': 'Answer', text: faq.a },
  })),
}

function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0)

  return (
    <section className={SECTION}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <div className={`${CONTAINER} grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16`}>
        <Reveal className="lg:sticky lg:top-28 lg:self-start">
          <h2 className={`max-w-[14ch] text-[32px] text-white [text-wrap:balance] md:text-[46px] ${TITLE}`}>
            Questions before you trust us with production
          </h2>
          <p className="mt-5 max-w-[36ch] text-[15px] leading-[1.7] text-zinc-400">
            Anything else, ask the person who built it.
          </p>
          <div className="mt-7 flex flex-wrap gap-x-6 gap-y-3">
            <Link href={ROUTES.resources} className={TEXT_LINK}>
              Read the docs
              <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
            <a href={ROUTES.founder} target="_blank" rel="noopener noreferrer" className={TEXT_LINK}>
              Book 30 minutes
              <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </a>
          </div>
        </Reveal>

        <Reveal delay={0.08} className="border-t border-white/[0.08]">
          {faqs.map((faq, index) => (
            <FaqItem
              key={faq.q}
              faq={faq}
              open={openIndex === index}
              onToggle={() => setOpenIndex(openIndex === index ? null : index)}
            />
          ))}
        </Reveal>
      </div>
    </section>
  )
}

const TEXT_LINK =
  'group inline-flex items-center gap-1.5 text-[15px] font-medium tracking-[-0.006em] text-zinc-300 transition-colors duration-200 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]'

function FaqItem({
  faq,
  open,
  onToggle,
}: {
  faq: (typeof faqs)[number]
  open: boolean
  onToggle: () => void
}) {
  const panelId = useId()
  const quiet = useSettledReducedMotion()

  return (
    <div className="border-b border-white/[0.08]">
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="group flex w-full items-center justify-between gap-6 py-6 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30 md:py-7"
        >
          <span
            className={`min-w-0 text-[16px] transition-colors duration-200 md:text-[18px] ${HEADING} ${
              open ? 'text-white' : 'text-zinc-300 group-hover:text-white'
            }`}
          >
            {faq.q}
          </span>
          <span
            aria-hidden
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-[transform,border-color,background-color] duration-300 ${
              open
                ? 'rotate-45 border-white/25 bg-white/[0.06]'
                : 'border-white/[0.10] group-hover:border-white/25'
            }`}
          >
            <Plus className="h-3.5 w-3.5 text-zinc-300" />
          </span>
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: quiet ? 0 : 0.32, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <p className={`${MEASURE} pb-7 pr-12 ${BODY} text-zinc-400 [text-wrap:pretty]`}>{faq.a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Closing

   Centred, and the page's last light: a horizon arc rising behind the ask,
   answering the lit edge the hero film sits on.
───────────────────────────────────────────────────────────── */

function ClosingSection() {
  const { isLoggedIn } = useUserSession()

  return (
    <section className="relative overflow-hidden pb-[220px] pt-[112px] md:pb-[280px] md:pt-[176px]">
      {/* The arc's apex sits ~110px under the buttons at every width: the
          container is anchored to the section's bottom edge, and the bottom
          padding above is what keeps the copy clear of it. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[420px] overflow-hidden">
        <div className="absolute left-1/2 top-[140px] h-[1400px] w-[2400px] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgba(139,92,246,0.26),rgba(139,92,246,0.06)_55%,transparent)]" />
        <div className="absolute left-1/2 top-[250px] h-[1400px] w-[1800px] -translate-x-1/2 rounded-[50%] border-t border-violet-200/50 bg-[#08090a] shadow-[0_-40px_140px_-30px_rgba(167,139,250,0.55),inset_0_1px_40px_-10px_rgba(196,181,253,0.25)] md:w-[2200px]" />
      </div>

      <Reveal className={`${CONTAINER} relative text-center`}>
        <h2 className={`mx-auto max-w-[18ch] text-[36px] text-white [text-wrap:balance] md:text-[64px] ${DISPLAY}`}>
          Give your agent a backend it can’t break
        </h2>
        <p className={`mx-auto mt-6 max-w-[52ch] text-[17px] text-zinc-400 [text-wrap:pretty] md:text-[18px] ${LEDE}`}>
          Connect Claude Code or Cursor in one command, ship real infrastructure today, and let
          autonomy keep it healthy tonight.
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href={isLoggedIn ? ROUTES.app : ROUTES.signup} className={PRIMARY_CTA}>
            {isLoggedIn ? 'Go to console' : 'Start free'}
            <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
          <a href={ROUTES.founder} target="_blank" rel="noopener noreferrer" className={SECONDARY_CTA}>
            <Calendar aria-hidden className="h-4 w-4" />
            Talk to the founder
          </a>
        </div>
      </Reveal>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────
   Shared helpers
───────────────────────────────────────────────────────────── */

function Reveal({
  children,
  className = '',
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  const quiet = useSettledReducedMotion()

  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.15, margin: '0px 0px -8% 0px' }}
      variants={rise}
      transition={{ duration: quiet ? 0 : 0.9, delay: quiet ? 0 : delay, ease: EASE_OUT }}
      className={`min-w-0 ${className}`.trim()}
    >
      {children}
    </motion.div>
  )
}

/** Left-aligned, stacked, no eyebrow. The headline names the section itself. */
function SectionHead({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2 className={`max-w-[22ch] text-[32px] text-white [text-wrap:balance] md:text-[48px] ${TITLE}`}>{title}</h2>
      <p className={`mt-5 ${MEASURE} text-[17px] text-zinc-400 [text-wrap:pretty] md:text-[18px] ${LEDE}`}>{body}</p>
    </div>
  )
}
