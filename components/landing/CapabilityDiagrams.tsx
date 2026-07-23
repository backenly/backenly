'use client'

/**
 * Diagrams for the "Platform surface" cards.
 *
 * Each one shows the primitive doing its actual job, using this platform's real
 * grammar — PostgREST query syntax, the `workspace_{projectId}` schema naming,
 * the real trigger events. A card that only asserts "REST APIs, filters,
 * ordering, pagination" reads as filler no matter how it is styled; showing
 * `?select=*,author(*)` proves the claim in less space than the sentence did.
 *
 * Drawing language:
 *
 *   - line-art (hairline cylinders, dashed rims) where the subject is a store,
 *   - dotted connectors between labelled node chips where the subject is flow,
 *   - dotted-leader tables where the subject is a listing,
 *   - one browser window, cropped by the cell edge, where the subject is a
 *     response. The crop is deliberate: a diagram that runs off the surface
 *     reads as an instrument panel; six diagrams each neatly boxed read as a
 *     template.
 *
 * Strictly monochrome. Emphasis is brightness, never hue: the important token
 * is zinc-100 on a zinc-500 line, the important stroke is white/30 next to
 * white/12. No brand color in this band — an accent sprinkled across six
 * diagrams stops being an accent, and the drawings must read like engineering
 * figures, not decorated cards.
 *
 * Chips and windows sit on solid ink (#0b0b0e) because the section behind them
 * is a transparent crosshair ground — labels must occlude it, never blend.
 *
 * Motion policy. Ambient motion in a six-cell grid is noise, so:
 *
 *   1. Each diagram assembles once when it scrolls into view, in the order the
 *      system actually works (method → token, event → function → result). The
 *      sequence is the explanation; it plays once and then sits still.
 *   2. Continuous looping is allowed for exactly one card — Realtime — because
 *      a change feed that does not change is a picture of the wrong thing.
 *   3. Everything else that moves is hover-driven, so it only ever animates on
 *      the one card the cursor is on.
 *
 * All of it collapses to a static render under `prefers-reduced-motion`.
 *
 * Bottom-aligned with a floor, not a fixed height: `justify-end` keeps every
 * diagram on the same baseline as its neighbours regardless of how long the
 * paragraph above it runs; the min-height keeps a short diagram from letting
 * its row collapse.
 */

import { motion, useReducedMotion, type Variants } from 'framer-motion'

const MONO = 'font-mono text-[11px] leading-none tracking-tight'
const TEXT = 'text-zinc-300'
const MUTED = 'text-zinc-500'
/** Emphasis by brightness, not hue — see the file comment. */
const BRIGHT = 'text-zinc-100'

/** Node chip: mono label on solid ink so the crosshair ground never bleeds
    through a word. Fixed height so connector geometry is deterministic. */
const CHIP =
  'inline-flex h-8 items-center gap-2 rounded-[5px] border border-white/[0.09] bg-[#0b0b0e] px-2.5'
/** The emphasized node reads brighter, not colored. */
const CHIP_BRIGHT =
  'inline-flex h-8 items-center gap-2 rounded-[5px] border border-white/[0.18] bg-[#0b0b0e] px-2.5'
/** The small type label inside a chip — `event`, `cron`, `signing secret`. */
const TAG = 'text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-600'

const EASE_OUT = [0.16, 1, 0.3, 1] as const

/** Plays the assembly once, the first time the card is on screen. */
const sequence: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.09, delayChildren: 0.12 } },
}

const step: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT } },
}

/** For connectors: a line that draws rather than fades. */
const drawX: Variants = {
  hidden: { scaleX: 0 },
  visible: { scaleX: 1, transition: { duration: 0.55, ease: EASE_OUT } },
}

const drawY: Variants = {
  hidden: { scaleY: 0 },
  visible: { scaleY: 1, transition: { duration: 0.4, ease: EASE_OUT } },
}

function Slot({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      className={`relative mt-8 flex min-h-[176px] select-none flex-col justify-end ${className}`.trim()}
      aria-hidden
      initial={reduceMotion ? false : 'hidden'}
      whileInView="visible"
      viewport={{ once: true, amount: 0.4 }}
      variants={sequence}
    >
      {children}
    </motion.div>
  )
}

/* ─── Database ──────────────────────────────────────────────── */

/** Hairline cylinder with the tables inside and the schema name beneath it,
    engineering-figure style. Emphasis between the two tenants is stroke
    brightness only. */
function Cylinder({
  cx,
  bright,
  name,
  tables,
}: {
  cx: number
  bright: boolean
  name: string
  tables: string[]
}) {
  const rx = 70
  const wall = bright ? 'stroke-white/[0.30]' : 'stroke-white/[0.14]'
  const rim = bright ? 'stroke-white/[0.16]' : 'stroke-white/[0.08]'

  return (
    <motion.g variants={step}>
      <ellipse cx={cx} cy={104} rx={rx} ry={12} strokeDasharray="3 4" className={rim} />
      <line x1={cx - rx} y1={18} x2={cx - rx} y2={104} className={wall} />
      <line x1={cx + rx} y1={18} x2={cx + rx} y2={104} className={wall} />
      <ellipse cx={cx} cy={18} rx={rx} ry={12} className={wall} />
      {tables.map((table, i) => (
        <text
          key={table}
          x={cx}
          y={57 + i * 20}
          textAnchor="middle"
          className={`font-mono text-[10px] tracking-tight ${bright ? 'fill-zinc-300' : 'fill-zinc-600'}`}
        >
          {table}
        </text>
      ))}
      <text
        x={cx}
        y={138}
        textAnchor="middle"
        className={`font-mono text-[10px] tracking-tight ${bright ? 'fill-zinc-400' : 'fill-zinc-600'}`}
      >
        {name}
      </text>
    </motion.g>
  )
}

/** Two tenants drawn as separate stores with a dashed wall between them. */
export function DatabaseDiagram() {
  return (
    <Slot>
      <svg
        viewBox="0 0 320 146"
        fill="none"
        strokeWidth={1}
        className="w-full max-w-[380px]"
        aria-hidden
      >
        <Cylinder cx={80} bright name="workspace_a1b2" tables={['posts', 'authors']} />
        <motion.line
          variants={step}
          x1={160}
          y1={10}
          x2={160}
          y2={140}
          strokeDasharray="2 6"
          className="stroke-white/[0.12]"
        />
        <Cylinder cx={240} bright={false} name="workspace_c3d4" tables={['orders', 'customers']} />
      </svg>
      <motion.p variants={step} className={`${MONO} mt-3.5 ${MUTED}`}>
        one schema per project · no shared tables
      </motion.p>
    </Slot>
  )
}

/* ─── REST APIs ─────────────────────────────────────────────── */

/**
 * A browser window with a live query in the bar and the embedded resource in
 * the response body. The window runs off the bottom of the cell — the crop is
 * the point; see the file comment.
 */
export function RestApiDiagram() {
  return (
    <Slot>
      <motion.div
        variants={step}
        className="-mb-14 overflow-hidden rounded-t-lg border border-b-0 border-white/[0.09] bg-[#0a0a0d] md:-mb-16"
      >
        <div className="flex items-center gap-2.5 border-b border-white/[0.06] bg-white/[0.015] px-3 py-2.5">
          <span className="flex gap-1.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-2 w-2 rounded-full border border-white/[0.14]" />
            ))}
          </span>
          <span className={`${MONO} min-w-0 flex-1 truncate ${TEXT}`}>
            <span className={BRIGHT}>GET</span> /posts?select=*,author(*)
          </span>
          <span className={`${MONO} shrink-0 ${MUTED}`}>200</span>
        </div>
        <div className="space-y-2 px-3 pb-4 pt-3">
          <motion.p variants={step} className={`${MONO} ${MUTED}`}>
            &amp;status=eq.published · &amp;order=created_at.desc
          </motion.p>
          {/* Pretty-printed on purpose — a wrapped one-liner reads as an
              accident; an indented second line reads as a response body. */}
          <motion.div variants={step} className={`${MONO} space-y-1.5 ${MUTED}`}>
            <p>[ {'{'} &quot;title&quot;: &quot;…&quot;,</p>
            <p className="pl-4">
              <span className={BRIGHT}>&quot;author&quot;</span>: {'{'} &quot;name&quot;:
              &quot;Ada&quot; {'}'} {'}'} ]
            </p>
          </motion.div>
          {/* The rest of the response, cropped by the cell edge. */}
          <motion.div variants={step} className="space-y-1.5 pt-1">
            <div className="h-1.5 w-3/4 rounded-full bg-white/[0.05]" />
            <div className="h-1.5 w-1/2 rounded-full bg-white/[0.05]" />
            <div className="h-1.5 w-2/3 rounded-full bg-white/[0.05]" />
          </motion.div>
        </div>
      </motion.div>
    </Slot>
  )
}

/* ─── Auth ──────────────────────────────────────────────────── */

/** Three doors converging on one token. Chip heights are fixed (h-8, gap 10px)
    so the connector endpoints in the 117-unit viewBox land on chip centres. */
export function AuthDiagram() {
  const methods = ['password', 'oauth', 'magic link']

  return (
    <Slot>
      <div className="flex items-center">
        <div className="flex shrink-0 flex-col gap-2.5">
          {methods.map((method) => (
            <motion.span key={method} variants={step} className={CHIP}>
              <span className={`${MONO} ${TEXT}`}>{method}</span>
            </motion.span>
          ))}
        </div>
        <motion.div variants={drawX} style={{ originX: 0 }} className="h-[117px] min-w-0 flex-1">
          <svg viewBox="0 0 100 117" preserveAspectRatio="none" className="h-full w-full">
            {[16, 58.5, 101].map((y) => (
              <path
                key={y}
                d={`M2 ${y} L98 58.5`}
                strokeDasharray="2 4"
                vectorEffect="non-scaling-stroke"
                fill="none"
                className="stroke-white/[0.16]"
              />
            ))}
          </svg>
        </motion.div>
        <motion.span variants={step} className={`${CHIP_BRIGHT} shrink-0`}>
          <span className={`${MONO} ${BRIGHT}`}>jwt</span>
          <span className={TAG}>signing secret</span>
        </motion.span>
      </div>
      <motion.p variants={step} className={`${MONO} mt-3 ${MUTED}`}>
        never shared across projects
      </motion.p>
    </Slot>
  )
}

/* ─── Storage ───────────────────────────────────────────────── */

/** A bucket listing with dotted leaders; the signed URL is the point. */
export function StorageDiagram() {
  const rows = [
    { name: 'avatar.png', value: 'signed url', bright: true },
    { name: 'invoice.pdf', value: '2.1 MB', bright: false },
    { name: 'exports/q2.csv', value: '61 MB', bright: false },
  ]

  return (
    <Slot>
      <motion.div
        variants={step}
        className={`${MONO} flex items-center justify-between border-b border-white/[0.08] pb-2.5 ${MUTED}`}
      >
        <span>bucket · uploads</span>
        <span>s3 | local</span>
      </motion.div>
      {rows.map((row) => (
        <motion.div key={row.name} variants={step}>
          <div className="flex items-end gap-2 pt-3">
            <span className={`${MONO} ${TEXT}`}>{row.name}</span>
            <span className="mb-[3px] min-w-0 flex-1 border-b border-dotted border-white/[0.14]" />
            <span className={`${MONO} shrink-0 ${row.bright ? BRIGHT : MUTED}`}>{row.value}</span>
          </div>
          {/* The expiry is the whole claim: the URL is temporary. It only
              ticks while the cursor is on this card, so it is never ambient
              noise. */}
          {row.bright && (
            <div className="mt-2 h-px w-full overflow-hidden bg-white/[0.05]">
              <span className="block h-px w-full origin-left scale-x-0 bg-white/40 transition-transform duration-[2400ms] ease-linear group-hover:scale-x-100 motion-reduce:hidden" />
            </div>
          )}
        </motion.div>
      ))}
    </Slot>
  )
}

/* ─── Realtime ──────────────────────────────────────────────── */

/** One store fanning out to two subscribers, because "table change streams"
    is invisible until you see one land in a client. */
export function RealtimeDiagram() {
  const reduceMotion = useReducedMotion()
  const clients = [
    { op: 'INSERT', bright: true },
    { op: 'UPDATE', bright: false },
  ]

  return (
    <Slot>
      <motion.svg
        variants={step}
        viewBox="0 0 160 62"
        fill="none"
        strokeWidth={1}
        className="mx-auto block w-[160px]"
      >
        <ellipse cx={80} cy={50} rx={68} ry={10} strokeDasharray="3 4" className="stroke-white/[0.08]" />
        <line x1={12} y1={12} x2={12} y2={50} className="stroke-white/[0.18]" />
        <line x1={148} y1={12} x2={148} y2={50} className="stroke-white/[0.18]" />
        <ellipse cx={80} cy={12} rx={68} ry={10} className="stroke-white/[0.18]" />
        <text
          x={80}
          y={38}
          textAnchor="middle"
          className="fill-zinc-300 font-mono text-[10px] tracking-tight"
        >
          posts
        </text>
      </motion.svg>
      <motion.div variants={drawY} style={{ originY: 0 }} className="mx-auto h-7 w-[70%]">
        <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-full w-full">
          <path
            d="M50 1 L15 27"
            strokeDasharray="2 4"
            vectorEffect="non-scaling-stroke"
            fill="none"
            className="stroke-white/[0.22]"
          />
          <path
            d="M50 1 L85 27"
            strokeDasharray="2 4"
            vectorEffect="non-scaling-stroke"
            fill="none"
            className="stroke-white/[0.14]"
          />
        </svg>
      </motion.div>
      <div className="flex w-full justify-around">
        {clients.map((client, i) => (
          <motion.span key={client.op} variants={step} className={CHIP}>
            {/* The one looping element in the grid. A feed that never moves is
                a picture of the wrong thing. */}
            <motion.span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                client.bright ? 'bg-zinc-200' : 'bg-white/25'
              }`}
              animate={reduceMotion ? undefined : { opacity: [1, 0.25, 1] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut', delay: i * 0.8 }}
            />
            <span className={`${MONO} ${TEXT}`}>{client.op}</span>
            <span className={`${MONO} ${MUTED}`}>posts</span>
          </motion.span>
        ))}
      </div>
      <motion.div variants={step} className="mt-3.5 flex items-center gap-2">
        <div className="flex -space-x-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-4 w-4 rounded-full border border-white/10 bg-[#101014]" />
          ))}
        </div>
        <span className={`${MONO} ${MUTED}`}>3 present · no socket server</span>
      </motion.div>
    </Slot>
  )
}

/* ─── Functions & triggers ──────────────────────────────────── */

/** Two parallel flows: an event that has a trigger, and a cron that needs
    no event at all — which is exactly the claim in the paragraph above it. */
export function FunctionsDiagram() {
  const flows = [
    { source: 'posts.insert', tag: 'event', fn: 'sendWelcome', meta: '42ms' },
    { source: '0 6 * * 1', tag: 'cron', fn: 'weeklyDigest', meta: '187ms' },
  ]

  return (
    <Slot>
      <div className="space-y-2.5">
        {flows.map((flow) => (
          <div key={flow.fn} className="flex items-center gap-2.5">
            <motion.span variants={step} className={`${CHIP} shrink-0`}>
              <span className={`${MONO} ${TEXT}`}>{flow.source}</span>
              <span className={TAG}>{flow.tag}</span>
            </motion.span>
            <motion.span
              variants={drawX}
              style={{ originX: 0 }}
              className="min-w-0 flex-1 border-t border-dotted border-white/[0.16]"
            />
            <motion.span variants={step} className={`${CHIP_BRIGHT} shrink-0`}>
              <span className={`${MONO} ${BRIGHT}`}>{flow.fn}</span>
              <span className={`${MONO} ${MUTED}`}>{flow.meta}</span>
            </motion.span>
          </div>
        ))}
      </div>
      <motion.p variants={step} className={`${MONO} mt-3 ${MUTED}`}>
        webhooks · rate limits · same surface
      </motion.p>
    </Slot>
  )
}
