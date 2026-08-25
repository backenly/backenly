'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from 'framer-motion'
import {
  ArrowRight,
  Calendar,
  ChevronDown,
  Gauge,
  GitBranch,
  Moon,
  Play,
  ShieldCheck,
  Terminal,
  UsersRound,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { AutonomyFilm } from '@/components/site/AutonomyFilm'
import {
  AuthDiagram,
  DatabaseDiagram,
  FunctionsDiagram,
  RealtimeDiagram,
  RestApiDiagram,
  StorageDiagram,
} from '@/components/landing/CapabilityDiagrams'
import { HeroConsole } from '@/components/landing/HeroConsole'
import { ROUTES, SiteShell } from '@/components/site/SiteShell'

/* ─────────────────────────────────────────────────────────────
   Content
───────────────────────────────────────────────────────────── */

const capabilities: Capability[] = [
  {
    title: 'Database',
    body: 'A PostgreSQL schema of your own per project: tables, relations, indexes, constraints, and pgvector columns. Isolation is a Postgres grant, not a WHERE clause.',
    diagram: DatabaseDiagram,
  },
  {
    title: 'REST APIs',
    // Trimmed to the same three lines as its neighbours: it was the one
    // four-line paragraph in the row, and since the diagrams are
    // bottom-aligned, that fourth line spent itself as dead air over the other
    // five drawings.
    body: 'PostgREST serves every table from the catalog, so the API is the schema: filters, ordering, pagination, and embedded resources, plus OpenAPI and typed clients.',
    diagram: RestApiDiagram,
  },
  {
    title: 'Auth',
    body: 'Sign-up, OAuth, magic links, and verification emails for your end users. Every project signs with its own secret, so a token from one backend is worthless in another.',
    diagram: AuthDiagram,
  },
  {
    title: 'Storage',
    body: 'Buckets, uploads, metadata, and expiring signed URLs. Local disk while you build, any S3-compatible provider when you ship. The file API does not change.',
    diagram: StorageDiagram,
  },
  {
    title: 'Realtime',
    body: 'Subscribe to inserts, updates, and deletes as they land, plus presence and broadcast channels. Delivered over SSE, so there is no socket server to run.',
    diagram: RealtimeDiagram,
  },
  {
    title: 'Functions & triggers',
    body: 'Run a function on insert, update, delete, or signup. Or run it on a cron schedule with no event at all. Webhooks and rate limits are part of the same surface.',
    diagram: FunctionsDiagram,
  },
]

const capabilitySummaries = [
  {
    icon: ShieldCheck,
    title: 'Row-level security by description',
    body: 'Say who can read and write what; Backenly writes and enforces the Postgres policies.',
  },
  {
    icon: GitBranch,
    title: 'Branches for risky work',
    body: 'Clone the backend into a branch, let your agent experiment, review the diff, merge what works.',
  },
  {
    icon: UsersRound,
    title: 'Teams and organizations',
    body: 'Invite teammates and clients with roles. Every actor writes to the same change ledger.',
  },
]



const autonomyItems = [
  {
    icon: Moon,
    title: 'Runs without a session',
    body: 'Detection alone is table stakes. Backenly closes the loop: detect, fix safely, verify, document. No prompt, no session, nobody at the keyboard.',
  },
  {
    icon: ShieldCheck,
    title: 'Safe by construction',
    body: 'Only deterministic, reversible fixes are applied on their own, and every fix snapshots first. Anything risky becomes a prepared proposal waiting for one click.',
  },
  {
    icon: Gauge,
    title: 'Included on every plan',
    body: 'Every plan heals every minute, Free included. The loop runs no model, so it never spends your AI credits.',
  },
]

type Capability = {
  title: string
  body: string
  /** Shows the primitive working. See components/landing/CapabilityDiagrams. */
  diagram: () => JSX.Element
}

/* ─────────────────────────────────────────────────────────────
   Motion
───────────────────────────────────────────────────────────── */

const EASE_OUT = [0.16, 1, 0.3, 1] as const

// Scroll-triggered reveals stay on GPU-composited properties only
// (opacity + transform). Animating `filter: blur()` here forces a full-layer
// re-raster every frame exactly as the section scrolls in — the main cause of
// scroll stutter. Blur-in is kept only for the one-time hero entrance.
const revealVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 34,
    scale: 0.985,
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.9,
      ease: EASE_OUT,
    },
  },
}

const heroStaggerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.12,
      delayChildren: 0.05,
    },
  },
}

const heroItemVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 18,
    filter: 'blur(10px)',
  },
  visible: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: {
      duration: 0.9,
      ease: EASE_OUT,
    },
  },
}

const staggerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.105,
      delayChildren: 0.1,
    },
  },
}

const cardVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 24,
    scale: 0.985,
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.72,
      ease: EASE_OUT,
    },
  },
}

export default function LandingPage() {
  return (
    <SiteShell>
      <main className="relative overflow-x-hidden">
        <Hero />
        <CapabilitiesSection />
        <AutonomySection />
        <DemoClipsSection />
        <FaqSection />
        <ClosingCTA />
      </main>
    </SiteShell>
  )
}

/* ─────────────────────────────────────────────────────────────
   Hero
───────────────────────────────────────────────────────────── */

function Hero() {
  const sectionRef = useRef<HTMLElement>(null)
  const reduceMotion = useReducedMotion()

  return (
    <motion.section
      ref={sectionRef}
      // Generous air between the navbar and the headline, like the benchmark —
      // the headline should start after a beat of ground, not under the nav.
      className="relative isolate overflow-hidden px-0 pb-14 pt-16 sm:pt-20 md:pb-20 md:pt-28 xl:pt-32"
      initial={reduceMotion ? false : 'hidden'}
      animate="visible"
      variants={heroStaggerVariants}
    >
      {/* Fade to black that the console panel sits against. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.12),rgba(0,0,0,0.74)_68%,#000_100%)]"
      />
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 -z-10 h-px bg-[linear-gradient(to_right,transparent,rgba(255,255,255,0.22),transparent)]"
      />

      <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-6">
        {/* Wide like the benchmark: the headline runs most of the container
            and the paragraph holds long lines — a narrow column centered in
            an 88rem band read as timid. */}
        {/* The headline names the CATEGORY — "autonomous backend", the locked
            positioning and the one word the agent-cloud competitors cannot
            claim. Deliberately NOT "cloud platform": we do not run your app's
            compute, and borrowing that phrase would read as a clone of the
            two YC heros it came from. The old headline pair moved into the
            subline — it is the explanation, not the claim. */}
        <motion.h1
          variants={heroItemVariants}
          className="max-w-6xl text-[clamp(2.3rem,9vw,3.1rem)] font-semibold leading-[1.06] tracking-tight text-white [text-wrap:balance] sm:text-6xl md:text-[4.4rem] xl:text-[5rem]"
        >
          The autonomous backend
          <span className="block">built for coding agents</span>
        </motion.h1>

        <div className="mt-8 flex flex-col gap-8 md:flex-row md:items-center md:justify-between md:gap-12">
          <div className="max-w-4xl">
            <motion.p
              variants={heroItemVariants}
              className="text-[16px] leading-7 text-zinc-400 [text-wrap:pretty] md:text-[21px] md:leading-9"
            >
              Real Postgres, APIs, auth, storage, and realtime, driven by your
              agent over MCP, with every change governed, verified, and
              reversible.
            </motion.p>
          </div>

          <motion.div
            variants={heroItemVariants}
            className="flex shrink-0 flex-col gap-3 sm:flex-row"
          >
            <Link
              href={ROUTES.signup}
              className="group inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-white px-6 text-sm font-semibold text-black shadow-[0_12px_45px_-14px_rgba(255,255,255,0.4)] transition duration-200 hover:bg-zinc-200 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black md:text-[15px]"
            >
              Start free
              <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/quickstart"
              className="inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-white/14 bg-white/[0.03] px-6 text-sm font-semibold text-white transition duration-200 hover:border-white/25 hover:bg-white/[0.06] active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black md:text-[15px]"
            >
              <Terminal className="h-4 w-4" />
              Connect your agent
            </Link>
          </motion.div>
        </div>

        {/* The dashboard, drawn in DOM — see components/landing/HeroConsole. */}
        <motion.div variants={heroItemVariants} className="mt-12 md:mt-16">
          <HeroConsole />
        </motion.div>
      </div>
    </motion.section>
  )
}

/* ─────────────────────────────────────────────────────────────
   Capabilities — the primitives

   An engineering-drawing band: faint crosshair ground, hairline rules
   between transparent cells, and diagrams drawn as line art on top of it.
   The previous version boxed the grid into its own rounded, bordered slab —
   one more "component" sitting on the page — and boxed every diagram again
   inside it; boxes-inside-boxes is the strongest single tell of template
   output. Flat rules, open left and right edges, one shared ground.
───────────────────────────────────────────────────────────── */

/**
 * Hairlines between cells, never around them. Per-cell borders replace the
 * old gap-px lit-background trick because the cells are transparent now —
 * the crosshair ground has to run through the whole band uninterrupted.
 * Index-mapped for the 1 / md:2 / lg:3 column layouts of six cells.
 */
const CELL_RULES = [
  '',
  'border-t md:border-l md:border-t-0',
  'border-t lg:border-l lg:border-t-0',
  'border-t md:border-l lg:border-l-0',
  'border-t lg:border-l',
  'border-t md:border-l',
]

function CapabilitiesSection() {
  return (
    <section
      id="capabilities"
      className="relative scroll-mt-20 px-5 py-16 sm:px-6 sm:py-20 md:scroll-mt-24 md:py-28"
    >

      <div className="mx-auto max-w-[100rem]">
        <Reveal>
          <SectionHeader
            eyebrow="Platform surface"
            title="The primitives are built in, not bolted on"
            body="Choosing the platform that runs itself doesn’t mean giving anything up. Everything a production backend needs is already here, wired together, governed, and watched."
          />
        </Reveal>

        <Stagger className="mt-14 grid border-y border-white/[0.08] md:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((capability, index) => (
            <CapabilityCard key={capability.title} capability={capability} index={index} />
          ))}
        </Stagger>

        <Stagger className="mt-12 grid gap-8 border-t border-white/[0.06] pt-10 md:grid-cols-3 md:gap-6">
          {capabilitySummaries.map((item) => (
            <IconRow key={item.title} item={item} />
          ))}
        </Stagger>
      </div>
    </section>
  )
}

function CapabilityCard({ capability, index }: { capability: Capability; index: number }) {
  const Diagram = capability.diagram

  return (
    <motion.article
      variants={cardVariants}
      // overflow-hidden is load-bearing: the REST window is cropped by this
      // edge on purpose. Transparent over the crosshair ground; hover only
      // lifts the cell a hair's worth.
      className={`group relative flex flex-col overflow-hidden border-white/[0.08] p-7 transition-colors duration-500 hover:bg-white/[0.015] md:p-8 ${CELL_RULES[index] ?? 'border-t'}`}
    >
      {/* Hover rail: the only thing that marks the active cell, so the grid
          stays quiet until the cursor picks one. White, not brand-colored —
          the band is monochrome. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-[linear-gradient(to_right,transparent,rgba(255,255,255,0.35),transparent)] transition-transform duration-500 ease-out group-hover:scale-x-100 motion-reduce:transition-none"
      />
      <h3 className="text-xl font-semibold tracking-tight text-white">{capability.title}</h3>
      {/* Three-line floor from md up (3 × leading-7). The diagrams are
          bottom-aligned, so the dead air above one is the row's tallest cell
          minus this one; a floor keeps a paragraph that wraps one line further
          from spending that line as space over its neighbours' drawings. */}
      <p className="mt-2.5 max-w-[46ch] text-[15px] leading-7 text-zinc-400 md:min-h-[84px]">
        {capability.body}
      </p>
      <div className="mt-auto">
        <Diagram />
      </div>
    </motion.article>
  )
}

/**
 * The icon-and-paragraph row under both the capabilities grid and the autonomy
 * film. Capabilities used to carry a light-theme twin of this; once the section
 * went dark the two were the same component with different hex values.
 */
function IconRow({ item }: { item: { icon: LucideIcon; title: string; body: string } }) {
  const Icon = item.icon

  return (
    <motion.div variants={cardVariants} className="group flex gap-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] transition-colors duration-300 group-hover:border-white/25 group-hover:bg-white/[0.05]">
        <Icon className="h-4 w-4 text-zinc-400 transition-colors duration-300 group-hover:text-zinc-100" />
      </div>
      <div className="min-w-0">
        <h3 className="text-[17px] font-semibold leading-6 tracking-[-0.01em] text-white">
          {item.title}
        </h3>
        <p className="mt-2 text-[15px] leading-7 text-zinc-400">{item.body}</p>
      </div>
    </motion.div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Autonomy
───────────────────────────────────────────────────────────── */

function AutonomySection() {
  return (
    <section className="relative px-5 py-16 sm:px-6 sm:py-20 md:py-28">
      <div className="mx-auto max-w-[100rem]">
        <Reveal>
          <SectionHeader
            eyebrow="Autonomy"
            title="It fixes problems while you sleep"
            body="A resident loop watches every project: detect, fix safely, verify, document, keep it reversible. No prompt, no session, nobody at the keyboard."
          />
        </Reveal>

        {/* One column for the film and the row beneath it. They used to sit at
            different widths — the film at max-w-7xl inside a 100rem section —
            so the rule above the three points ran wider than the frame it was
            meant to close off. Keep both on this container. */}
        <div className="mx-auto mt-12 w-full max-w-7xl">
          <Reveal delay={0.06}>
            {/* Drawn, not filmed. A screen recording of this exact claim shipped
                and was pulled once already: the product moved and the footage
                showed a dashboard that no longer existed. This renders the same
                instrument the Overview does, so it cannot go stale behind us. */}
            <AutonomyFilm />
          </Reveal>

          <Stagger className="mt-14 grid gap-8 border-t border-white/[0.06] pt-10 md:grid-cols-3 md:gap-8">
            {autonomyItems.map((item) => (
              <IconRow key={item.title} item={item} />
            ))}
          </Stagger>
        </div>
      </div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────
   Open source — REMOVED.

   A two-column "You can take the whole thing" band (self-host vs Cloud) sat
   here, and before that a "No lock-in" band sat above it. Both are gone. The
   open-source claim still lives in the hero subline, the FAQ, and the footer;
   it does not need a full section of its own. Do not reintroduce either band.
───────────────────────────────────────────────────────────── */


/* ─────────────────────────────────────────────────────────────
   Demo clips — stays hidden until the recordings exist in
   public/demos/. The section appears only once at least one
   clip's metadata loads; a card whose video 404s stays hidden.
───────────────────────────────────────────────────────────── */

const demoClips = [
  {
    src: '/demos/build-verified-backend.mp4',
    title: 'Your agent ships a feature',
    body: 'One request over MCP becomes tables, REST APIs, and auth, then gets verified against the live runtime with real HTTP checks.',
  },
  {
    src: '/demos/destructive-change-rollback.mp4',
    title: 'Destructive changes wait for you',
    body: 'The agent asks to drop a table with live rows; the change parks in the Review Queue until a human approves. Any saved version can be restored.',
  },
  {
    src: '/demos/connect-frontend-mcp.mp4',
    title: 'Connect in one command',
    body: 'MCP for Claude Code and Cursor: your agent reads the live schema and builds against a real backend contract.',
  },
  {
    src: '/demos/autonomy-self-heal.mp4',
    title: 'It fixes problems before you wake up',
    body: 'The autonomy loop detects real degradation, applies or proposes a fix, and writes up exactly what it did, reviewable and reversible.',
  },
]

function DemoClipsSection() {
  const [status, setStatus] = useState<Record<string, 'ok' | 'failed'>>({})
  const anyReady = demoClips.some((clip) => status[clip.src] === 'ok')

  return (
    <section className={`px-5 pb-16 sm:px-6 sm:pb-20 md:pb-28 ${anyReady ? '' : 'hidden'}`}>
      <div className="mx-auto max-w-[100rem]">
        <Reveal>
          <SectionHeader
            eyebrow="See it work"
            title="Real recordings, not mockups"
            body="Short clips of the product doing its actual job: what it builds, what it refuses, what it connects to, and what it fixes on its own."
          />
        </Reveal>

        <Stagger className="mt-12 grid gap-5 sm:grid-cols-2">
          {demoClips.map((clip) => (
            <DemoClipCard
              key={clip.src}
              clip={clip}
              ready={status[clip.src] === 'ok'}
              onReady={() =>
                setStatus((prev) =>
                  prev[clip.src] === 'ok' ? prev : { ...prev, [clip.src]: 'ok' }
                )
              }
              onUnavailable={() =>
                setStatus((prev) => ({ ...prev, [clip.src]: 'failed' }))
              }
            />
          ))}
        </Stagger>
      </div>
    </section>
  )
}

function DemoClipCard({
  clip,
  ready,
  onReady,
  onUnavailable,
}: {
  clip: (typeof demoClips)[number]
  ready: boolean
  onReady: () => void
  onUnavailable: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)

  function toggleClip() {
    const video = videoRef.current
    if (!video) return

    if (video.paused) {
      void video.play()
      setPlaying(true)
      return
    }

    video.pause()
    setPlaying(false)
  }

  return (
    <motion.article
      variants={cardVariants}
      className={`overflow-hidden rounded-xl border border-white/[0.1] bg-[#0a0a0c] ${
        ready ? '' : 'hidden'
      }`}
    >
      <button
        type="button"
        aria-label={playing ? `Pause demo: ${clip.title}` : `Play demo: ${clip.title}`}
        onClick={toggleClip}
        className="group relative block aspect-video w-full bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40"
      >
        <video
          ref={videoRef}
          src={clip.src}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedMetadata={onReady}
          onError={onUnavailable}
          onEnded={() => setPlaying(false)}
          className="h-full w-full object-contain"
        />
        <div
          className={`absolute inset-0 flex items-center justify-center bg-black/35 transition-opacity duration-300 ${
            playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
          }`}
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-black/70">
            <Play className="h-5 w-5 text-white" />
          </span>
        </div>
      </button>
      <div className="border-t border-white/10 px-5 py-4">
        <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-white">{clip.title}</h3>
        <p className="mt-1.5 text-[15px] leading-7 text-zinc-400">{clip.body}</p>
      </div>
    </motion.article>
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
    a: 'Self-hosting is free under Apache-2.0: you bring the servers, and an OpenAI key only if you want the natural-language build tools — the self-healing loop itself runs no model. On Backenly Cloud, the Free plan is genuinely free, with no credit card, and includes a real, permanent backend plus the self-healing loop every minute. Pro is $25/month and raises capacity and how much autonomy may fix per window, not the cadence; Enterprise is custom. Driving the backend from your own coding agent through the typed MCP tools is never metered as AI, and autonomy is included on every Cloud tier.',
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

/**
 * Two-column: title stays put on the left while the list scrolls on the
 * right; rows are open hairlines on the page ground, chevron leading the
 * question. The boxed accordion this replaces was one more rounded
 * container on a page that had already shed them.
 */
function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0)

  return (
    <section className="px-5 py-16 sm:px-6 sm:py-20 md:py-28">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <div className="mx-auto grid max-w-[100rem] gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
        <Reveal className="lg:sticky lg:top-28 lg:self-start">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
            Common questions
          </p>
          <h2 className="mt-4 max-w-md bg-[linear-gradient(180deg,#fff_20%,rgba(255,255,255,0.66))] bg-clip-text text-3xl font-semibold leading-tight tracking-tight text-transparent [text-wrap:balance] md:text-5xl">
            What people ask before trusting us with production
          </h2>
          <Link
            href={ROUTES.resources}
            className="group mt-7 inline-flex items-center gap-1.5 text-[15px] font-medium text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            Read the docs
            <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
        </Reveal>

        <Reveal delay={0.08} className="divide-y divide-white/[0.07] border-y border-white/[0.07]">
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

function FaqItem({
  faq,
  open,
  onToggle,
}: {
  faq: (typeof faqs)[number]
  open: boolean
  onToggle: () => void
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group flex w-full items-center gap-4 py-6 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30 md:py-7"
      >
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-zinc-600 transition-all duration-300 group-hover:text-zinc-300 ${
            open ? 'rotate-180 text-zinc-300' : ''
          }`}
        />
        <span className="min-w-0 flex-1 text-[16px] font-semibold leading-6 tracking-[-0.01em] text-white md:text-[17px]">
          {faq.q}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            {/* pl-8 = chevron width + gap, so the answer sits under the question. */}
            <p className="max-w-2xl pb-6 pl-8 text-sm leading-7 text-zinc-400 [text-wrap:pretty] md:pb-7">
              {faq.a}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Closing CTA
───────────────────────────────────────────────────────────── */

/**
 * The finale in the page's own language: the crosshair ground, one static
 * hairline, monochrome type. It used to be the last colored, animated
 * element left — a pulsing emerald-to-violet edge with a violet glow —
 * which made the send-off the least disciplined moment on the page.
 */
function ClosingCTA() {
  return (
    <section className="relative px-5 pb-20 pt-8 sm:px-6 sm:pb-28 sm:pt-12">
      <Reveal className="relative mx-auto max-w-7xl overflow-hidden rounded-lg border border-white/10 bg-[#0a0a0d] px-5 py-12 text-center sm:px-6 sm:py-14 md:px-12 md:py-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(255,255,255,0.28),transparent)]"
        />
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
          One command away
        </p>
        <h2 className="mx-auto mt-4 max-w-3xl bg-[linear-gradient(180deg,#fff_20%,rgba(255,255,255,0.66))] bg-clip-text text-3xl font-semibold leading-tight tracking-tight text-transparent [text-wrap:balance] sm:text-4xl md:text-5xl">
          Give your agent a backend it can’t break
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-zinc-400 [text-wrap:pretty]">
          Start free: connect Claude Code or Cursor in one command, ship real
          infrastructure today, and let autonomy keep it healthy tonight.
          Every change reviewable. Every change reversible. Every line open source.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href={ROUTES.signup}
            className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-white px-5 text-sm font-semibold text-black transition duration-200 hover:bg-zinc-200 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:w-auto whitespace-nowrap"
          >
            Start free
            <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
          <a
            href={ROUTES.founder}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md border border-white/12 px-5 text-sm font-semibold text-white transition duration-200 hover:border-white/25 hover:bg-white/[0.04] active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:w-auto whitespace-nowrap"
          >
            <Calendar className="h-4 w-4" />
            Talk to founder
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
  children: React.ReactNode
  className?: string
  delay?: number
}) {
  const reduceMotion = useReducedMotion()
  const wrapperClassName = `min-w-0 ${className}`.trim()

  if (reduceMotion) {
    return <div className={wrapperClassName}>{children}</div>
  }

  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.12, margin: '0px 0px -8% 0px' }}
      variants={revealVariants}
      transition={{ duration: 0.9, delay, ease: EASE_OUT }}
      className={wrapperClassName}
    >
      {children}
    </motion.div>
  )
}

function Stagger({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  const reduceMotion = useReducedMotion()
  const wrapperClassName = `min-w-0 ${className}`.trim()

  if (reduceMotion) {
    return <div className={wrapperClassName}>{children}</div>
  }

  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.1, margin: '0px 0px -8% 0px' }}
      variants={staggerVariants}
      className={wrapperClassName}
    >
      {children}
    </motion.div>
  )
}

function SectionHeader({
  eyebrow,
  title,
  body,
  align = 'center',
}: {
  eyebrow: string
  title: string
  body: string
  align?: 'left' | 'center'
}) {
  const alignment = align === 'center' ? 'mx-auto text-center' : 'text-left'

  return (
    <div className={`w-full max-w-full sm:max-w-3xl ${alignment}`}>
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
        {eyebrow}
      </p>
      <h2 className="mt-4 bg-[linear-gradient(180deg,#fff_20%,rgba(255,255,255,0.66))] bg-clip-text text-3xl font-semibold leading-tight tracking-tight text-transparent [text-wrap:balance] md:text-5xl">
        {title}
      </h2>
      <p className="mt-5 text-base leading-7 text-zinc-400 [text-wrap:pretty]">{body}</p>
    </div>
  )
}
