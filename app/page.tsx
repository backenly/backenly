'use client'

import { useId, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AnimatePresence,
  motion,
  type Variants,
} from 'framer-motion'
import {
  ArrowRight,
  Calendar,
  ChevronDown,
  Gauge,
  Moon,
  Play,
  ShieldCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { AutonomyFilm } from '@/components/site/AutonomyFilm'
import { CodeBlock } from '@/components/site/CodeBlock'
import {
  AuthDiagram,
  DatabaseDiagram,
  FunctionsDiagram,
  RealtimeDiagram,
  RestApiDiagram,
  StorageDiagram,
} from '@/components/landing/CapabilityDiagrams'
import { HeroFilm } from '@/components/landing/HeroFilm'
import { ROUTES, SiteShell } from '@/components/site/SiteShell'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { useUserSession } from '@/lib/hooks/useUserSession'

/* ─────────────────────────────────────────────────────────────
   Design tokens

   Added 2026-09-18. An audit of this file found 14 distinct font sizes,
   9 hairline alphas and 11 body measures, with exactly 2 tracking values
   spread flat across all of it. Individually none of that is visible.
   Together it is the whole difference between a page that looks clean and
   one that looks expensive, because a reader feels inconsistency long
   before they can name it.

   Everything below is a token. Reach for one; do not write a new
   `text-[17px]` or a tenth shade of white.
───────────────────────────────────────────────────────────── */

/**
 * Type scale.
 *
 * The part that was missing is that **tracking scales inversely with size**.
 * One flat `tracking-tight` (-0.025em) ran from 20px card headings up to the
 * 80px hero, so the display type sat loose and the small type sat cramped.
 * Reference points from the benchmark set: Linear runs about -3.75% at 80px,
 * -3.2% at 56px, -2.5% at 40px and -2.1% at 28px. These follow that curve.
 *
 * SIZES ARE `px` HERE, AND THAT IS DELIBERATE. A first pass at this block
 * converted them to `rem` on the usual reasoning above. It was wrong for this
 * codebase: app/globals.css sets `--font-body: 13px` on `html`, so **1rem is
 * 13px here, not 16px**, and the conversion silently shrank every body size by
 * about 19% (15px copy rendered at 12px, 21px hero subline at 17px). The
 * accessibility argument does not apply either, because a hardcoded root
 * font-size has already overridden the reader's browser setting before any of
 * these tokens are read. Making `rem` correct here is a globals.css change,
 * not a landing-page one. Until then: px.
 *
 * The heading steps below are the exception and are still `rem` (`1.875rem`,
 * `2.75rem`, `3.25rem`). Those are the values the page always shipped, so they
 * render exactly as before; only the sizes this file had as px were affected.
 *
 * LINE HEIGHT, READ THIS BEFORE EDITING: every Tailwind font-size utility
 * ships its own line-height, and a bare `leading-*` only wins where no LATER
 * breakpoint reintroduces a size. So each token restates `leading-*` at every
 * breakpoint where it sets a size. Dropping one is how the closing headline
 * ended up with a 42px font on a 32px line, with the two lines overlapping.
 */
const DISPLAY =
  'font-semibold leading-[1.03] tracking-[-0.042em] sm:leading-[1.02] md:leading-[1.01] xl:leading-[1.0]'
const TITLE = 'font-semibold leading-[1.1] tracking-[-0.032em] md:leading-[1.06]'
const HEADING = 'font-semibold leading-[1.35] tracking-[-0.018em]'
const LEDE = 'leading-[1.65] tracking-[-0.012em] md:leading-[1.55]'
const BODY = 'text-[15px] leading-[1.75] tracking-[-0.004em]'

/**
 * Hairlines. Three jobs, three tokens, replacing nine ad-hoc alphas
 * (0.06 / 0.07 / 0.08 / 0.1 / 0.12 / 0.14 / 10 / 20 / 25).
 */
const RULE = 'border-white/[0.07]' // divides items inside one group
const RULE_LEAD = 'border-white/[0.14]' // opens a section, or closes it
const EDGE = 'border-white/[0.10]' // the outline of an actual object

/** Measure. Prose gets one comfortable column; captions get a narrow one. */
const MEASURE = 'max-w-[60ch]'
const MEASURE_TIGHT = 'max-w-[44ch]'

/**
 * Rhythm. One vertical scale for the whole page.
 *
 * Sections used to carry `py-16 sm:py-20 md:py-28` on BOTH edges, so every
 * boundary stacked two full paddings into roughly 224px of empty black, and a
 * centered header then floated in the middle of it with nothing to align to.
 */
const SECTION = 'px-5 py-14 sm:px-6 md:py-20'
const CONTAINER = 'mx-auto w-full max-w-[100rem]'

/** One recipe, so the hero CTA and the finale CTA cannot drift apart. */
const PRIMARY_CTA =
  'group inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-white px-6 text-[14px] font-semibold tracking-[-0.006em] text-black shadow-[0_12px_45px_-14px_rgba(255,255,255,0.4)] transition duration-200 hover:bg-zinc-200 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black md:text-[15px]'

const SECONDARY_CTA =
  `inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-md border ${EDGE} px-6 text-[14px] font-semibold tracking-[-0.006em] text-white transition duration-200 hover:border-white/25 hover:bg-white/[0.04] active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black md:text-[15px]`

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

/**
 * The three things the grid above does not draw. Deliberately typographic:
 * the autonomy band below owns the icon-and-paragraph treatment, and running
 * it here too made the page repeat one layout family twice in four screens.
 */
const capabilitySummaries = [
  {
    title: 'Row-level security by description',
    body: 'Say who can read and write what; Backenly writes and enforces the Postgres policies.',
  },
  {
    title: 'Branches for risky work',
    body: 'Clone the backend into a branch, let your agent experiment, review the diff, merge what works.',
  },
  {
    title: 'Teams and organizations',
    body: 'Invite teammates and clients with roles. Every actor writes to the same change ledger.',
  },
]

/**
 * The real command the dashboard mints, with the project id and key stood in
 * for. Source of truth: components/connect/AgentInstallGuide.tsx. If that
 * builder changes shape, change this with it.
 *
 * The backslash is a genuine shell line continuation, not decoration: on one
 * line this runs past the column and the block shows a command sawn off
 * mid-flag, which is worse than a wrap. Pasting either form works.
 */
const CONNECT_COMMAND = `claude mcp add backenly -- \\
  npx -y @backenly/mcp-server --project <project-id> --key <api-key>`

const connectChannels = [
  {
    title: 'MCP server',
    body: 'Typed tools for schema, data, auth, storage, and functions, in Claude Code, Cursor, Codex, Cline, or any MCP host. Driving the backend this way is never metered as AI.',
  },
  {
    title: 'CLI',
    body: 'npx @backenly/cli for schema, generated types, CI diffs, logs, and read-only SQL: the part of the workflow that belongs in a pipeline rather than in a chat.',
  },
  {
    title: 'Agent skill',
    body: 'A canonical skill at backenly.com/skill.md, so an agent learns how the platform expects to be driven before it touches anything.',
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

   One element type in every branch. `useReducedMotion()` is read during
   render and the server has no media query, so letting it choose the element
   type (or the `initial` prop) made the server and the first client render
   disagree: React #425 / #418 / #423, after which the root gave up and
   re-rendered the whole landing page on the client for every reduced-motion
   visitor.

   So the reduced branch is gated behind `useQuietMotion`, which reads the
   media query through `useSyncExternalStore`. Server and first client render
   are identical by construction; the pass after hydration then gives
   reduced-motion visitors duration 0, so the tree snaps to its resting state
   instead of animating into it.
───────────────────────────────────────────────────────────── */

const EASE_OUT = [0.16, 1, 0.3, 1] as const

/** See lib/hooks/useSettledReducedMotion for why this is not framer's hook. */
const useQuietMotion = useSettledReducedMotion

// Scroll-triggered reveals stay on GPU-composited properties only
// (opacity + transform). Animating `filter: blur()` here forces a full-layer
// re-raster every frame exactly as the section scrolls in — the main cause of
// scroll stutter. Blur-in is kept only for the one-time hero entrance.
const revealVariants: Variants = {
  hidden: { opacity: 0, y: 34, scale: 0.985 },
  visible: { opacity: 1, y: 0, scale: 1 },
}

const heroItemVariants: Variants = {
  hidden: { opacity: 0, y: 18, filter: 'blur(10px)' },
  visible: { opacity: 1, y: 0, filter: 'blur(0px)' },
}

/**
 * The hero film's entrance: the same rise, without the blur. Framer leaves
 * `filter: blur(0px)` inline once the entrance ends, and a filter on an
 * ancestor can keep a playing video off the browser's cheap overlay path for
 * as long as the page is open. The text around it pays for the blur once; a
 * 60fps film would pay for it on every frame.
 */
const heroFilmVariants: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0 },
}

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 24, scale: 0.985 },
  visible: { opacity: 1, y: 0, scale: 1 },
}

const heroStagger = (quiet: boolean): Variants => ({
  hidden: {},
  visible: {
    transition: {
      staggerChildren: quiet ? 0 : 0.12,
      delayChildren: quiet ? 0 : 0.05,
    },
  },
})

const listStagger = (quiet: boolean): Variants => ({
  hidden: {},
  visible: {
    transition: {
      staggerChildren: quiet ? 0 : 0.105,
      delayChildren: quiet ? 0 : 0.1,
    },
  },
})

export default function LandingPage() {
  return (
    <SiteShell>
      {/* Matches the shell's skip link, so it still resolves without JS. */}
      <main id="main-content" className="relative overflow-x-hidden">
        <Hero />
        <CapabilitiesSection />
        <ConnectSection />
        <AutonomySection />
        <DemoClipsSection />
        <FaqSection />
        <ClosingCTA />
      </main>
    </SiteShell>
  )
}

/* ─────────────────────────────────────────────────────────────
   Launch chip  ·  TEMPORARY, comes out after the Product Hunt launch

   Announces the launch above the hero headline. Flip SHOW_LAUNCH_PILL to
   false to pull it in one edit. To remove it for good, delete this block,
   its call site in `Hero`, `ROUTES.productHunt`, and the `.launch-sweep`
   rules in app/globals.css.

   TOMBSTONE, do not "improve" it back: a version that replaced the NEW
   badge with Product Hunt's own brand mark and a hard date
   (`[PH mark] Launching on Product Hunt | Sep 30 ->`) was built and
   REJECTED by the founder, who preferred this one. If a date is ever
   wanted, add it to the message; do not bring back the mark.

   WHAT EACH PART IS, AND WHY IT IS NOT SOMETHING ELSE:

   - THE BADGE IS WHITE ON BLACK, and that is the most on-system choice
     available, not a fallback. `bg-white text-black` is this platform's
     primary surface recipe: `KitButton primary` in components/inspector/kit.tsx
     is exactly `bg-white text-black`, and `PRIMARY_CTA` below this chip is
     the same. So the badge is a miniature of the page's own primary
     surface, which is why it reads as a stamp rather than as decoration.
     Contrast is 21:1.

     A violet-tinted badge (the `Most popular` recipe from
     app/pricing/page.tsx) was shipped first and the founder asked for
     white instead. If a tinted badge is ever wanted again, that pricing
     recipe is the one to copy: a TINT, never a violet FILL, because tags
     are inside the neutral-first accent budget but filled accent surfaces
     are not. Never Product Hunt orange, which would be a third colour.
     Violet still carries the chip via the top hairline, the sweep and the
     glow, so the brand is present without competing with the badge.
   - THE VIOLET TOP HAIRLINE is `RuntimeStatusBar`'s in
     components/inspector/kit.tsx, whose own comment calls it the
     signature: "One violet hairline along the top edge." It sweeps, so
     the edge reads imminent. The sweep is a CSS keyframe, NOT
     framer-motion: nested in the hero's variant tree, a `motion.span`
     with `repeat: Infinity` had the parent's `visible` label override its
     own `animate`, so it ran once and froze at its end position. That is
     invisible in a screenshot; it was caught by sampling the computed
     transform over time. See app/globals.css.
   - THE INTERNAL HAIRLINE splits the message from the action. Border plus
     text plus arrow on one uniform gap is the most templated component on
     the web. A hairline dividing content is this page's own device: see
     the `border-t` over every summary column and over the closing CTA.
   - RADIUS IS `rounded-md`, the same as `PRIMARY_CTA` below it. This
     page's whole radius vocabulary is three `rounded-md` plus one
     decorative circle, so a `rounded-full` chip read as imported from
     another site. An earlier draft was exactly that and was rejected.
   - NO BARE STATUS DOT. A violet dot reporting no state is the dot that
     was deliberately deleted from the shared `Eyebrow` in kit.tsx. The
     badge carries the colour instead, and it carries a word.

   Two rules it already satisfied and still must:

   - It is NOT an eyebrow. The 2026-09-18 redesign stripped every mono,
     uppercase, wide-tracked label off this page, and the invariant is
     checked by grepping this file for that class recipe and expecting
     zero hits. Do NOT spell the recipe out here: the check is a plain
     text search, so writing it even inside a comment trips it (this
     paragraph did, on the first draft). The badge is a micro-label INSIDE
     a chip, not a section opener, and its tracking is nowhere near the
     banned value. `text-[11px]` is the one size here the page did not
     already ship; a micro-label is a type role the page had no token for.
   - It is NOT a second CTA. An external link, not an auth button. The
     hero's second button was removed on purpose; `Start free` stays the
     only signup CTA. It also holds the hero to four text elements, which
     is the cap: chip, headline, subline, CTA.
───────────────────────────────────────────────────────────── */

const SHOW_LAUNCH_PILL = true

function LaunchPill({ quiet }: { quiet: boolean }) {
  return (
    <motion.div
      variants={heroItemVariants}
      transition={{ duration: quiet ? 0 : 0.9, ease: EASE_OUT }}
      className="mb-7"
    >
      <Link
        href={ROUTES.productHunt}
        target="_blank"
        rel="noopener noreferrer"
        // Without this the badge word leads the accessible name ("New
        // Launching soon...") and the new tab is unannounced.
        aria-label="Launching soon on Product Hunt. Opens in a new tab."
        className={`group relative inline-flex items-stretch overflow-hidden rounded-md border ${EDGE} bg-white/[0.03] text-[14px] font-medium text-zinc-300 shadow-[0_16px_50px_-24px_rgba(139,92,246,0.55)] transition duration-200 hover:border-violet-400/30 hover:bg-white/[0.06] hover:text-white hover:shadow-[0_18px_60px_-22px_rgba(139,92,246,0.8)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black`}
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

        <span
          aria-hidden
          className="w-px shrink-0 bg-white/[0.10] transition-colors duration-200 group-hover:bg-white/25"
        />
        <span className="flex items-center px-2.5">
          <ArrowRight
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition duration-200 group-hover:translate-x-0.5 group-hover:text-zinc-300"
          />
        </span>
      </Link>
    </motion.div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Hero

   Copy is locked; see project-two-door-positioning. The headline names the
   category and the subline explains it. Only the rhythm and the type moved.
───────────────────────────────────────────────────────────── */

function Hero() {
  const sectionRef = useRef<HTMLElement>(null)
  const quiet = useQuietMotion()
  const { isLoggedIn } = useUserSession()

  return (
    <motion.section
      ref={sectionRef}
      // Generous air between the navbar and the headline, like the benchmark —
      // the headline should start after a beat of ground, not under the nav.
      className="relative isolate overflow-hidden px-0 pb-12 pt-12 sm:pt-14 md:pb-16 md:pt-20 xl:pt-24"
      initial="hidden"
      animate="visible"
      variants={heroStagger(quiet)}
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

      <div className={`${CONTAINER} px-5 sm:px-6`}>
        {SHOW_LAUNCH_PILL && <LaunchPill quiet={quiet} />}

        <motion.h1
          variants={heroItemVariants}
          transition={{ duration: quiet ? 0 : 0.9, ease: EASE_OUT }}
          className={`max-w-[22ch] text-[clamp(2.3rem,9vw,3.1rem)] text-white [text-wrap:balance] sm:text-6xl md:text-[4.4rem] xl:text-[5rem] ${DISPLAY}`}
        >
          The autonomous backend
          <span className="block">built for coding agents</span>
        </motion.h1>

        <div className="mt-8 flex flex-col gap-8 md:flex-row md:items-center md:justify-between md:gap-12">
          <motion.p
            variants={heroItemVariants}
            transition={{ duration: quiet ? 0 : 0.9, ease: EASE_OUT }}
            className={`max-w-[52ch] text-[17px] text-zinc-400 [text-wrap:pretty] md:text-[21px] ${LEDE}`}
          >
            Real Postgres, APIs, auth, storage, and realtime, driven by your
            agent over MCP, with every change governed, verified, and
            reversible.
          </motion.p>

          <motion.div
            variants={heroItemVariants}
            transition={{ duration: quiet ? 0 : 0.9, ease: EASE_OUT }}
            className="flex shrink-0 flex-col gap-3 sm:flex-row"
          >
            <Link href={isLoggedIn ? ROUTES.app : ROUTES.signup} className={PRIMARY_CTA}>
              {isLoggedIn ? 'Go to console' : 'Start free'}
              <ArrowRight
                aria-hidden
                className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
              />
            </Link>
          </motion.div>
        </div>

        {/* The product film — see components/landing/HeroFilm for why it
            replaced the drawn console, and what keeps it from going stale. */}
        <motion.div
          variants={heroFilmVariants}
          transition={{ duration: quiet ? 0 : 1.1, ease: EASE_OUT }}
          className="mt-12 md:mt-16"
        >
          <HeroFilm />
        </motion.div>
      </div>
    </motion.section>
  )
}

/* ─────────────────────────────────────────────────────────────
   Capabilities — the primitives

   An engineering-drawing band: hairline rules between transparent cells, with
   the diagrams drawn as line art on the page's own ground. An earlier version
   boxed the grid into a rounded, bordered slab — one more "component" sitting
   on the page — and boxed every diagram again inside it. Boxes inside boxes is
   the strongest single tell of template output. Flat rules, open left and
   right edges, one shared ground.
───────────────────────────────────────────────────────────── */

/**
 * Hairlines between cells, never around them. Per-cell borders replace the
 * old gap-px lit-background trick because the cells are transparent now —
 * the ground has to run through the whole band uninterrupted.
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
    <section id="capabilities" className={`relative scroll-mt-20 md:scroll-mt-24 ${SECTION}`}>
      <div className={CONTAINER}>
        <Reveal>
          <SectionHead
            title="The primitives are built in, not bolted on"
            body="Everything a production backend needs, wired together from the first table: Postgres, REST, auth, storage, realtime, and functions. Governed and watched the whole time."
          />
        </Reveal>

        <Stagger
          className={`mt-10 grid border-y ${RULE} md:mt-12 md:grid-cols-2 lg:grid-cols-3`}
        >
          {capabilities.map((capability, index) => (
            <CapabilityCard key={capability.title} capability={capability} index={index} />
          ))}
        </Stagger>

        <Stagger className="mt-10 grid gap-x-10 gap-y-8 lg:grid-cols-3">
          {capabilitySummaries.map((item) => (
            <SummaryColumn key={item.title} item={item} />
          ))}
        </Stagger>
      </div>
    </section>
  )
}

function CapabilityCard({ capability, index }: { capability: Capability; index: number }) {
  const Diagram = capability.diagram
  const quiet = useQuietMotion()

  return (
    <motion.article
      variants={cardVariants}
      transition={{ duration: quiet ? 0 : 0.72, ease: EASE_OUT }}
      // overflow-hidden is load-bearing: the REST window is cropped by this
      // edge on purpose. Transparent over the page ground; hover only lifts
      // the cell a hair's worth.
      className={`group relative flex flex-col overflow-hidden ${RULE} p-7 transition-colors duration-500 hover:bg-white/[0.015] md:p-8 ${CELL_RULES[index] ?? 'border-t'}`}
    >
      {/* Hover rail: the only thing that marks the active cell, so the grid
          stays quiet until the cursor picks one. White, not brand-colored —
          the band is monochrome. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-[linear-gradient(to_right,transparent,rgba(255,255,255,0.35),transparent)] transition-transform duration-500 ease-out group-hover:scale-x-100 motion-reduce:transition-none"
      />
      <h3 className={`text-[1.25rem] text-white ${HEADING}`}>{capability.title}</h3>
      {/* Three-line floor from md up. The diagrams are bottom-aligned, so the
          dead air above one is the row's tallest cell minus this one; a floor
          keeps a paragraph that wraps one line further from spending that line
          as space over its neighbours' drawings. */}
      <p className={`mt-3 ${MEASURE_TIGHT} ${BODY} text-zinc-400 md:min-h-[84px]`}>
        {capability.body}
      </p>
      <div className="mt-auto">
        <Diagram />
      </div>
    </motion.article>
  )
}

/**
 * Typographic three-up: a hairline over each column, no icon chrome. The
 * autonomy band owns the icon-and-paragraph treatment, so this one is
 * deliberately the quieter sibling and the two never read as one row pasted
 * twice.
 */
function SummaryColumn({ item }: { item: { title: string; body: string } }) {
  const quiet = useQuietMotion()

  return (
    <motion.div
      variants={cardVariants}
      transition={{ duration: quiet ? 0 : 0.72, ease: EASE_OUT }}
      className={`border-t ${RULE_LEAD} pt-5`}
    >
      <h3 className={`text-[17px] text-white ${HEADING}`}>{item.title}</h3>
      <p className={`mt-2 ${MEASURE_TIGHT} ${BODY} text-zinc-400`}>{item.body}</p>
    </motion.div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Connect

   The beat the page was missing. A reader who has just seen the primitives
   asks "how do I point my agent at it", and the answer used to live only in
   the FAQ, eight screens down. The command is the real one the dashboard
   mints, and the block is the site's syntax-highlighted CodeBlock rather than
   a drawn-on terminal.
───────────────────────────────────────────────────────────── */

function ConnectSection() {
  return (
    <section className={`relative ${SECTION}`}>
      <div className={CONTAINER}>
        <Reveal>
          <SectionHead
            title="Point your agent at it, and it reads the real schema"
            body="One command registers Backenly with your coding agent. The key is scoped to a single project and revocable from the dashboard, and it can request a destructive change but never approve one."
          />
        </Reveal>

        <div className="mt-10 grid gap-10 md:mt-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:gap-14">
          <Reveal>
            <CodeBlock code={CONNECT_COMMAND} language="bash" label="Claude Code" />
            <p className={`mt-4 ${MEASURE} ${BODY} text-zinc-500`}>
              MCP servers connect when the host process starts, so the tools
              appear after a restart. Cursor, Codex and Cline take the same
              server through their own install command.
            </p>
          </Reveal>

          <Stagger className={`divide-y divide-white/[0.07] border-y ${RULE}`}>
            {connectChannels.map((channel) => (
              <ChannelRow key={channel.title} channel={channel} />
            ))}
          </Stagger>
        </div>
      </div>
    </section>
  )
}

function ChannelRow({ channel }: { channel: { title: string; body: string } }) {
  const quiet = useQuietMotion()

  return (
    <motion.div
      variants={cardVariants}
      transition={{ duration: quiet ? 0 : 0.72, ease: EASE_OUT }}
      className="py-5"
    >
      <h3 className={`text-[17px] text-white ${HEADING}`}>{channel.title}</h3>
      {/* Capped: this column is ~620px at desktop, which ran these sentences
          out to about 95 characters. Anything past ~70 costs the reader the
          line return. */}
      <p className={`mt-2 ${MEASURE} ${BODY} text-zinc-400`}>{channel.body}</p>
    </motion.div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Autonomy
───────────────────────────────────────────────────────────── */

function AutonomySection() {
  return (
    <section className={`relative ${SECTION}`}>
      <div className={CONTAINER}>
        <Reveal>
          <SectionHead
            title="It fixes problems while you sleep"
            body="A resident loop watches every project: detect, fix safely, verify, document, keep it reversible. No prompt, no session, nobody at the keyboard."
          />
        </Reveal>

        {/* One column for the film and the row beneath it. They used to sit at
            different widths — the film at max-w-7xl inside a 100rem section —
            so the rule above the three points ran wider than the frame it was
            meant to close off. Keep both on this container. */}
        <div className="mx-auto mt-10 w-full max-w-7xl md:mt-12">
          <Reveal delay={0.06}>
            {/* Drawn, not filmed. A screen recording of this exact claim shipped
                and was pulled once already: the product moved and the footage
                showed a dashboard that no longer existed. This renders the same
                instrument the Overview does, so it cannot go stale behind us. */}
            <AutonomyFilm />
          </Reveal>

          <Stagger
            className={`mt-12 grid gap-8 border-t ${RULE} pt-10 md:grid-cols-3 md:gap-8`}
          >
            {autonomyItems.map((item) => (
              <IconRow key={item.title} item={item} />
            ))}
          </Stagger>
        </div>
      </div>
    </section>
  )
}

/**
 * The icon-and-paragraph row under the autonomy film. This treatment belongs
 * to this band alone; see SummaryColumn for why the capabilities three-up no
 * longer borrows it.
 */
function IconRow({ item }: { item: { icon: LucideIcon; title: string; body: string } }) {
  const Icon = item.icon
  const quiet = useQuietMotion()

  return (
    <motion.div
      variants={cardVariants}
      transition={{ duration: quiet ? 0 : 0.72, ease: EASE_OUT }}
      className="group flex gap-4"
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${EDGE} bg-white/[0.03] transition-colors duration-300 group-hover:border-white/25 group-hover:bg-white/[0.05]`}
      >
        <Icon
          aria-hidden
          className="h-4 w-4 text-zinc-400 transition-colors duration-300 group-hover:text-zinc-100"
        />
      </div>
      <div className="min-w-0">
        <h3 className={`text-[17px] text-white ${HEADING}`}>{item.title}</h3>
        <p className={`mt-2 ${BODY} text-zinc-400`}>{item.body}</p>
      </div>
    </motion.div>
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
    <section className={`${SECTION} ${anyReady ? '' : 'hidden'}`}>
      <div className={CONTAINER}>
        <Reveal>
          <SectionHead
            title="Real recordings, not mockups"
            body="Short clips of the product doing its actual job: what it builds, what it refuses, what it connects to, and what it fixes on its own."
          />
        </Reveal>

        <Stagger className="mt-10 grid gap-5 sm:grid-cols-2 md:mt-12">
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
  const quiet = useQuietMotion()

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
      transition={{ duration: quiet ? 0 : 0.72, ease: EASE_OUT }}
      className={`overflow-hidden rounded-xl border ${EDGE} bg-[#0a0a0c] ${
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
          <span className={`flex h-12 w-12 items-center justify-center rounded-full border ${EDGE} bg-black/70`}>
            <Play aria-hidden className="h-5 w-5 text-white" />
          </span>
        </div>
      </button>
      <div className={`border-t ${RULE} px-5 py-4`}>
        <h3 className={`text-[16px] text-white ${HEADING}`}>{clip.title}</h3>
        <p className={`mt-1.5 ${BODY} text-zinc-400`}>{clip.body}</p>
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

/**
 * Two-column: the title stays put on the left while the list scrolls on the
 * right; rows are open hairlines on the page ground, chevron leading the
 * question. The boxed accordion this replaced was one more rounded container
 * on a page that had already shed them.
 */
function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0)

  return (
    <section className={SECTION}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <div
        className={`${CONTAINER} grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16`}
      >
        <Reveal className="lg:sticky lg:top-28 lg:self-start">
          {/* Matches SectionHead's scale: this is a section head too, it just
              sits in the sticky column instead of above the content. */}
          <h2
            className={`max-w-[16ch] text-[1.875rem] text-white [text-wrap:balance] md:text-[2.75rem] ${TITLE}`}
          >
            What people ask before trusting us with production
          </h2>
          <Link
            href={ROUTES.resources}
            className="group mt-7 inline-flex items-center gap-1.5 text-[15px] font-medium tracking-[-0.006em] text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            Read the docs
            <ArrowRight
              aria-hidden
              className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </Link>
        </Reveal>

        <Reveal delay={0.08} className={`divide-y divide-white/[0.07] border-y ${RULE}`}>
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
  // Ties the button to the panel it controls, so a screen reader announces
  // what expanded rather than only that something did.
  const panelId = useId()
  const quiet = useQuietMotion()

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="group flex w-full items-center gap-4 py-6 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30 md:py-7"
      >
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 shrink-0 text-zinc-600 transition-[color,transform] duration-300 group-hover:text-zinc-300 ${
            open ? 'rotate-180 text-zinc-300' : ''
          }`}
        />
        <span className={`min-w-0 flex-1 text-[16px] text-white md:text-[17px] ${HEADING}`}>
          {faq.q}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: quiet ? 0 : 0.3, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            {/* pl-8 = chevron width + gap, so the answer sits under the question. */}
            <p className={`${MEASURE} pb-6 pl-8 ${BODY} text-zinc-400 [text-wrap:pretty] md:pb-7`}>
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

   Bookends the hero on purpose: the same left-aligned headline with the
   actions held out to the right at desktop. It used to be a centered,
   bordered slab floating in its own well of black, which made the send-off
   the one boxed component on a page that had shed every other box.
───────────────────────────────────────────────────────────── */

function ClosingCTA() {
  const { isLoggedIn } = useUserSession()

  return (
    <section className="relative px-5 pb-20 pt-6 sm:px-6 sm:pb-24">
      <Reveal className={CONTAINER}>
        <div className={`border-t ${RULE_LEAD} pt-12 md:pt-16`}>
          <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between lg:gap-16">
            <div>
              {/* Size and leading are pinned per breakpoint. A bare `leading-*`
                  loses to the line-height baked into a responsive font-size
                  utility, and `sm:text-4xl` once left this headline at a 42px
                  font on a 32px line: the two lines literally overlapped. */}
              <h2
                className={`max-w-[18ch] text-[1.875rem] text-white [text-wrap:balance] sm:text-[2.25rem] md:text-[3.25rem] ${TITLE}`}
              >
                Give your agent a backend it can’t break
              </h2>
              <p className={`mt-5 ${MEASURE} text-[17px] text-zinc-400 [text-wrap:pretty] ${LEDE}`}>
                Connect Claude Code or Cursor in one command, ship real
                infrastructure today, and let autonomy keep it healthy tonight.
                Every change reviewable, every change reversible, every line
                open source.
              </p>
            </div>

            <div className="flex shrink-0 flex-col gap-3 sm:flex-row lg:pb-1">
              <Link href={isLoggedIn ? ROUTES.app : ROUTES.signup} className={PRIMARY_CTA}>
                {isLoggedIn ? 'Go to console' : 'Start free'}
                <ArrowRight
                  aria-hidden
                  className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
                />
              </Link>
              <a
                href={ROUTES.founder}
                target="_blank"
                rel="noopener noreferrer"
                className={SECONDARY_CTA}
              >
                <Calendar aria-hidden className="h-4 w-4" />
                Talk to founder
              </a>
            </div>
          </div>
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
  const quiet = useQuietMotion()

  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.12, margin: '0px 0px -8% 0px' }}
      variants={revealVariants}
      transition={{
        duration: quiet ? 0 : 0.9,
        delay: quiet ? 0 : delay,
        ease: EASE_OUT,
      }}
      className={`min-w-0 ${className}`.trim()}
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
  const quiet = useQuietMotion()

  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.1, margin: '0px 0px -8% 0px' }}
      variants={listStagger(quiet)}
      className={`min-w-0 ${className}`.trim()}
    >
      {children}
    </motion.div>
  )
}

/**
 * Left-aligned, stacked, no eyebrow.
 *
 * Every section used to open with the same centered mono-caps label over the
 * same gradient-clipped headline over the same centered paragraph. Five
 * identical openers is the templated rhythm that makes a page read as
 * generated, and centering them left each one floating in the middle of a
 * field of black with nothing to align to. The headline names the section on
 * its own; the label was never carrying information.
 */
function SectionHead({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2
        className={`max-w-[20ch] text-[1.875rem] text-white [text-wrap:balance] md:text-[2.75rem] ${TITLE}`}
      >
        {title}
      </h2>
      <p className={`mt-4 ${MEASURE} text-[17px] text-zinc-400 [text-wrap:pretty] md:mt-5 ${LEDE}`}>
        {body}
      </p>
    </div>
  )
}
