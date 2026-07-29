'use client'

/**
 * Diagrams for the "Platform surface" cards.
 *
 * Each one shows the primitive doing its actual job, using this platform's real
 * grammar — PostgREST query syntax and response headers, the
 * `workspace_{projectId}` schema naming, the real trigger events and webhook
 * paths. A card that only asserts "REST APIs, filters, ordering, pagination"
 * reads as filler no matter how it is styled; showing `?select=*,author(*)`
 * with a `content-range` beside it proves the claim in less space than the
 * sentence did.
 *
 * Drawing language:
 *
 *   - line-art (hairline cylinders, solid near edges, dashed hidden edges)
 *     where the subject is a store,
 *   - dotted leaders between labelled node chips, meeting at a filled junction,
 *     where the subject is flow,
 *   - dotted-leader tables where the subject is a listing,
 *   - one browser window, cropped by the cell edge, where the subject is a
 *     response. The crop is deliberate: a diagram that runs off the surface
 *     reads as an instrument panel; six diagrams each neatly boxed read as a
 *     template.
 *
 * Two rules keep it reading as drafted rather than decorated:
 *
 *   1. Hairlines are hairlines. Every stroke carries
 *      `vectorEffect="non-scaling-stroke"` and every figure is laid out in
 *      units that map 1:1 to CSS pixels at full width (see `Fig`), so a 1px
 *      line is one pixel instead of 1.19 of one smeared across two. Straight
 *      strokes sit on half-unit coordinates for the same reason. Soft grey
 *      hairlines were the single biggest reason this band read as approximate.
 *   2. The same object is never drawn at two different shapes. Database and
 *      Realtime both draw a store through `Store`, at the same
 *      radius : body : rim proportion, one just scaled down.
 *
 * Strictly monochrome. Emphasis is brightness, never hue: the important token
 * is zinc-200 on a zinc-500 line, the important stroke is white/38 next to
 * white/17. No brand color in this band — an accent sprinkled across six
 * diagrams stops being an accent, and the drawings must read like engineering
 * figures, not decorated cards.
 *
 * Chips and windows sit on solid ink (#0b0b0e) so a label always occludes
 * whatever it crosses rather than blending into it.
 *
 * Motion policy. Ambient motion in a six-cell grid is noise, so:
 *
 *   1. Each diagram assembles once when it scrolls into view, in the order the
 *      system actually works (method → token, event → function → result). The
 *      sequence is the explanation; it plays once and then sits still.
 *   2. Continuous looping is allowed for exactly one card — Realtime — because
 *      a change feed that does not change is a picture of the wrong thing.
 *   3. Everything else that moves is hover-driven, so it only ever animates on
 *      the one card the cursor is on, and every hover-driven element also has a
 *      resting state that reads on its own.
 *
 * All of it collapses to a static render under `prefers-reduced-motion`.
 *
 * Bottom-aligned with a floor, not a fixed height: `justify-end` keeps every
 * diagram on the same baseline as its neighbours regardless of how long the
 * paragraph above it runs. The six figures are drawn to within ~30px of the
 * same height on purpose — the dead air between a paragraph and its drawing is
 * the row's tallest cell minus this one, so unequal figures read as six
 * drawings that fell to the bottom of their cells.
 */

import { Fragment } from 'react'
import { motion, useReducedMotion, type Variants } from 'framer-motion'

const MONO = 'font-mono text-[11px] leading-none tracking-tight'
const TEXT = 'text-zinc-300'
const MUTED = 'text-zinc-500'
/** Emphasis by brightness, not hue — see the file comment. */
const BRIGHT = 'text-zinc-100'

/**
 * Stroke ladder. Three steps and nothing between them: the subject, the thing
 * beside the subject, and the edge you are not meant to look at. A 1px line at
 * white/14 on pure black is at the threshold of visibility, which reads as
 * unfinished rather than delicate — hence the floor at white/17.
 */
const KEY = 'stroke-white/[0.38]'
const DIM = 'stroke-white/[0.17]'
const GROUND = 'stroke-white/[0.10]'
/** Connectors sit one step above DIM so flow survives on a dim display. */
const LEADER = 'stroke-white/[0.24]'
/** Diagonals only. A dotted diagonal spreads each dash over two pixel columns,
    so it lands visibly fainter than the same value run straight; this is the
    one place the ladder is compensated rather than followed. */
const LEADER_DIAGONAL = 'stroke-white/[0.30]'

const FILL_KEY = 'fill-zinc-200'
const FILL_DIM = 'fill-zinc-500'
const FIG_LABEL = 'font-mono text-[10px] tracking-tight'

/** Applied to every stroked shape. See rule 1 in the file comment. */
const CRISP = { vectorEffect: 'non-scaling-stroke' } as const

/** Node chip: mono label on solid ink so nothing bleeds through a word. Fixed
    height so connector geometry is deterministic. */
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

function Slot({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      className={`relative mt-8 flex min-h-[200px] select-none flex-col justify-end ${className}`.trim()}
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

/**
 * Figure frame. `maxWidth: w` with `w-full` means the viewBox maps 1:1 to CSS
 * pixels on any column wide enough to hold the drawing, which is what makes the
 * hairlines land on the pixel grid instead of between it. Narrower than that it
 * scales down proportionally and `non-scaling-stroke` keeps the lines honest.
 */
function Fig({ w, h, children }: { w: number; h: number; children: React.ReactNode }) {
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ maxWidth: w }}
      fill="none"
      strokeWidth={1}
      aria-hidden
      className="block h-auto w-full"
    >
      {children}
    </svg>
  )
}

/**
 * One store, drafted properly: the top rim is fully visible, the near edge of
 * the floor is solid and continuous with the walls, and only the far edge —
 * the one behind the body — is dashed. Drawing the whole floor dashed, as this
 * used to, detaches it into a saucer sitting under a tube.
 *
 * Callers pass the same proportion (rx ≈ 0.62 × body, ry = 0.154 × rx) so the
 * store in Realtime is this store scaled, not a different object.
 */
function Store({
  cx,
  top,
  body,
  rx,
  bright,
}: {
  cx: number
  top: number
  body: number
  rx: number
  bright: boolean
}) {
  const ry = Math.round(rx * 0.154 * 2) / 2
  const bottom = top + body
  const wall = bright ? KEY : DIM

  return (
    <>
      {/* Far edge of the floor: hidden behind the body, so dashed and faint. */}
      <path
        d={`M${cx - rx} ${bottom} A${rx} ${ry} 0 0 1 ${cx + rx} ${bottom}`}
        strokeDasharray="2 4"
        className={GROUND}
        {...CRISP}
      />
      <path
        d={`M${cx - rx} ${bottom} A${rx} ${ry} 0 0 0 ${cx + rx} ${bottom}`}
        className={wall}
        {...CRISP}
      />
      <line x1={cx - rx} y1={top} x2={cx - rx} y2={bottom} className={wall} {...CRISP} />
      <line x1={cx + rx} y1={top} x2={cx + rx} y2={bottom} className={wall} {...CRISP} />
      <ellipse cx={cx} cy={top} rx={rx} ry={ry} className={wall} {...CRISP} />
    </>
  )
}

function FigLabel({
  x,
  y,
  bright,
  children,
}: {
  x: number
  y: number
  bright?: boolean
  children: React.ReactNode
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      className={`${FIG_LABEL} ${bright ? FILL_KEY : FILL_DIM}`}
    >
      {children}
    </text>
  )
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <motion.p variants={step} className={`${MONO} mt-3.5 ${MUTED}`}>
      {children}
    </motion.p>
  )
}

/* ─── Database ──────────────────────────────────────────────── */

/**
 * Two tenants drawn as separate stores with a dashed wall between them, and an
 * fk bracket inside the near one — "relations" is in the paragraph and was in
 * nothing on the card.
 */
export function DatabaseDiagram() {
  return (
    <Slot>
      <motion.div variants={step}>
        <Fig w={360} h={192}>
          <Store cx={90.5} top={22} body={126} rx={78} bright />
          <FigLabel x={90.5} y={78} bright>
            posts
          </FigLabel>
          <FigLabel x={90.5} y={100} bright>
            authors
          </FigLabel>
          {/* posts.author_id → authors.id, drawn as a bracket rather than a
              label, so it reads as a constraint and not as more prose. */}
          <path d="M116.5 74.5 H134.5 V96.5 H116.5" className={DIM} {...CRISP} />
          <text x={140} y={88.5} className={`${FIG_LABEL} ${FILL_DIM}`}>
            fk
          </text>
          <FigLabel x={90.5} y={178} bright>
            workspace_a1b2
          </FigLabel>

          {/* The grant boundary. Nothing crosses it, which is the whole claim. */}
          <line
            x1={180.5}
            y1={8}
            x2={180.5}
            y2={184}
            strokeDasharray="2 6"
            className={DIM}
            {...CRISP}
          />

          <Store cx={270.5} top={22} body={126} rx={78} bright={false} />
          <FigLabel x={270.5} y={78}>
            orders
          </FigLabel>
          <FigLabel x={270.5} y={100}>
            customers
          </FigLabel>
          <FigLabel x={270.5} y={178}>
            workspace_c3d4
          </FigLabel>
        </Fig>
      </motion.div>
      <Caption>one schema per project · no shared tables</Caption>
    </Slot>
  )
}

/* ─── REST APIs ─────────────────────────────────────────────── */

/**
 * A browser window with a live query in the bar, the real `content-range`
 * header PostgREST answers with, and the embedded resource in the body. The
 * window runs off the bottom of the cell — the crop is the point, and it is
 * sized so the visible part fills the slot like the other five figures rather
 * than floating at the bottom of it.
 */
export function RestApiDiagram() {
  return (
    <Slot>
      <motion.div
        variants={step}
        className="-mb-16 overflow-hidden rounded-t-lg border border-b-0 border-white/[0.09] bg-[#0a0a0d]"
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
          {/* Pagination is a claim in the paragraph; this is the header that
              answers it. */}
          <motion.p variants={step} className={`${MONO} ${MUTED}`}>
            content-range: <span className={TEXT}>0-24/1042</span>
          </motion.p>
          {/* Pretty-printed on purpose — a wrapped one-liner reads as an
              accident; indented lines read as a response body. The last row is
              left open because the array continues past the crop. */}
          <motion.div variants={step} className={`${MONO} space-y-1.5 pt-0.5 ${MUTED}`}>
            <p>[ {'{'} &quot;title&quot;: &quot;…&quot;,</p>
            <p className="pl-4">&quot;status&quot;: &quot;published&quot;,</p>
            <p className="pl-4">
              <span className={BRIGHT}>&quot;author&quot;</span>: {'{'} &quot;name&quot;:
              &quot;Ada&quot; {'}'} {'}'},
            </p>
            <p className="pl-2">{'{'} &quot;title&quot;: &quot;…&quot;,</p>
          </motion.div>
          {/* The other 1017 rows, cropped by the cell edge. */}
          <motion.div variants={step} className="space-y-1.5 pt-1">
            {[74, 52, 66, 58, 43, 34].map((pct) => (
              <div
                key={pct}
                className="h-1.5 rounded-full bg-white/[0.05]"
                style={{ width: `${pct}%` }}
              />
            ))}
          </motion.div>
        </div>
      </motion.div>
    </Slot>
  )
}

/* ─── Auth ──────────────────────────────────────────────────── */

/**
 * Three sign-in routes onto one bus, one junction, one token — drafted as a
 * bus rather than as three raw diagonals converging on empty space, which read
 * as a stray chevron. The elbow block is fixed-width so its corners stay
 * square; only the leader after the junction stretches.
 *
 * Chip pitch is h-8 with a 10px gap, so route centres land on 16 / 58 / 100 of
 * a 116-unit block and the junction sits at its exact middle.
 */
export function AuthDiagram() {
  const methods = ['password', 'oauth', 'magic link']

  return (
    <Slot>
      <div className="flex items-center">
        {/* items-stretch: every route leaves the column at the same x, so the
            three stubs are the same length. */}
        <div className="flex shrink-0 flex-col items-stretch gap-2.5">
          {methods.map((method) => (
            <motion.span key={method} variants={step} className={CHIP}>
              <span className={`${MONO} ${TEXT}`}>{method}</span>
            </motion.span>
          ))}
        </div>
        {/* The block stops at the junction, not past it. An SVG dash pattern
            and a CSS dotted border are different textures, so a line that
            changes from one to the other mid-run reads as two lines spliced
            together; ending the SVG on the dot makes the dot the transition. */}
        <motion.div variants={step} className="shrink-0">
          <svg viewBox="0 0 30 116" width={30} height={116} fill="none" strokeWidth={1} aria-hidden>
            {/* One path per route so the dashes run continuously around the
                corner instead of leaving it open. */}
            <path d="M0 16.5 H26.5 V58.5" strokeDasharray="2 4" className={LEADER} {...CRISP} />
            <path d="M0 100.5 H26.5 V58.5" strokeDasharray="2 4" className={LEADER} {...CRISP} />
            <path d="M0 58.5 H26.5" strokeDasharray="2 4" className={LEADER} {...CRISP} />
            <circle cx={26.5} cy={58.5} r={2} className="fill-white/45" stroke="none" />
          </svg>
        </motion.div>
        <motion.span
          variants={drawX}
          style={{ originX: 0 }}
          className="min-w-0 flex-1 border-t border-dotted border-white/[0.24]"
        />
        <motion.span variants={step} className={`${CHIP_BRIGHT} shrink-0`}>
          <span className={`${MONO} ${BRIGHT}`}>jwt</span>
          <span className={TAG}>signing secret</span>
        </motion.span>
      </div>
      {/* What the token actually carries — the claims RLS then reads. */}
      <motion.p variants={step} className={`${MONO} mt-4 ${MUTED}`}>
        {'{'} &quot;sub&quot;: &quot;usr_8f2a&quot;, &quot;role&quot;:{' '}
        <span className={TEXT}>&quot;authenticated&quot;</span> {'}'}
      </motion.p>
      <Caption>hs256 · never shared across projects</Caption>
    </Slot>
  )
}

/* ─── Storage ───────────────────────────────────────────────── */

/** A bucket listing with dotted leaders; the expiring signed URL is the point,
    so it is the one row with a drawn lifetime under it. */
export function StorageDiagram() {
  const rows = [
    { name: 'avatar.png', value: 'signed url', bright: true },
    { name: 'invoice.pdf', value: '2.1 MB', bright: false },
    { name: 'exports/q2.csv', value: '61 MB', bright: false },
    { name: 'logo.svg', value: '12 KB', bright: false },
  ]

  return (
    <Slot>
      <motion.div
        variants={step}
        className={`${MONO} flex items-center justify-between border-b border-white/[0.10] pb-2.5 ${MUTED}`}
      >
        <span>bucket · uploads</span>
        <span>s3 | local</span>
      </motion.div>
      {rows.map((row) => (
        <motion.div key={row.name} variants={step}>
          <div className="flex items-end gap-2 pt-4">
            <span className={`${MONO} ${row.bright ? TEXT : MUTED}`}>{row.name}</span>
            <span className="mb-[3px] min-w-0 flex-1 border-b border-dotted border-white/[0.16]" />
            <span className={`${MONO} shrink-0 ${row.bright ? BRIGHT : MUTED}`}>{row.value}</span>
          </div>
          {/* The expiry is the whole claim: the URL is temporary. It rests
              part-run so it reads without a cursor, and only finishes ticking
              while the cursor is on this card, so it is never ambient noise. */}
          {row.bright && (
            <div className="mt-2.5 flex items-center gap-2">
              {/* The track has to read, or the part-run fill is just a stray
                  dash under the filename instead of a meter. */}
              <div className="h-0.5 w-24 overflow-hidden rounded-full bg-white/[0.13]">
                <span className="block h-full w-full origin-left scale-x-[0.42] rounded-full bg-white/50 transition-transform duration-[2400ms] ease-linear group-hover:scale-x-100 motion-reduce:transition-none" />
              </div>
              <span className={`${MONO} ${MUTED}`}>expires 3600s</span>
            </div>
          )}
        </motion.div>
      ))}
      <motion.div
        variants={step}
        className={`${MONO} mt-4 flex items-center justify-between border-t border-white/[0.10] pt-3.5 ${MUTED}`}
      >
        <span>4 objects</span>
        <span>private bucket · no public read</span>
      </motion.div>
    </Slot>
  )
}

/* ─── Realtime ──────────────────────────────────────────────── */

/**
 * One store fanning out to the three row events, because "table change
 * streams" is invisible until you see one land in a client. Three columns, so
 * the fan endpoints are the column centres by construction rather than by
 * hand-tuned numbers, and the store is the Database store scaled down — same
 * object, same shape.
 */
export function RealtimeDiagram() {
  const reduceMotion = useReducedMotion()
  const ops = ['INSERT', 'UPDATE', 'DELETE']
  /** Column centres of a 3-column grid across the 360-unit figure. */
  const columns = [60.5, 180.5, 300.5]

  return (
    <Slot>
      <div className="w-full max-w-[360px]">
        <motion.div variants={step}>
          <Fig w={360} h={142}>
            <Store cx={180.5} top={14} body={88} rx={54} bright />
            <FigLabel x={180.5} y={62} bright>
              posts
            </FigLabel>
            {/* Origin is the floor's lowest point, so the fan leaves the store
                rather than appearing to start inside it. */}
            {columns.map((x) => (
              <path
                key={x}
                d={`M180.5 112 L${x} 141`}
                strokeDasharray="2 4"
                className={LEADER_DIAGONAL}
                {...CRISP}
              />
            ))}
          </Fig>
        </motion.div>
        <div className="grid grid-cols-3">
          {ops.map((op, i) => (
            <motion.span key={op} variants={step} className={`${CHIP} justify-self-center`}>
              {/* The one looping element in the grid. A feed that never moves is
                  a picture of the wrong thing. */}
              <motion.span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  i === 0 ? 'bg-zinc-200' : 'bg-white/25'
                }`}
                animate={reduceMotion ? undefined : { opacity: [1, 0.25, 1] }}
                transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut', delay: i * 0.8 }}
              />
              <span className={`${MONO} ${TEXT}`}>{op}</span>
            </motion.span>
          ))}
        </div>
      </div>
      <motion.div variants={step} className="mt-4 flex items-center gap-2">
        <div className="flex -space-x-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-4 w-4 rounded-full border border-white/[0.14] bg-[#0b0b0e]" />
          ))}
        </div>
        <span className={`${MONO} ${MUTED}`}>3 present · sse · no socket server</span>
      </motion.div>
    </Slot>
  )
}

/* ─── Functions & triggers ──────────────────────────────────── */

/**
 * Four parallel flows, one per way a function starts: a row event, a second
 * row event, a cron with no event at all, and an inbound webhook. The
 * paragraph claims all four; the card used to draw two.
 */
export function FunctionsDiagram() {
  const flows = [
    { source: 'users.signup', tag: 'event', fn: 'sendWelcome', meta: '42ms', bright: true },
    { source: 'posts.insert', tag: 'event', fn: 'embedPost', meta: '61ms', bright: false },
    { source: '0 6 * * 1', tag: 'cron', fn: 'weeklyDigest', meta: '187ms', bright: false },
    { source: 'hooks/stripe', tag: 'webhook', fn: 'onPayment', meta: '63ms', bright: false },
  ]

  return (
    <Slot>
      {/* A grid, not four flex rows: every source chip shares one column width
          and every function chip shares another, so the leaders run in a single
          clean channel. Four independent flex rows left both inner edges ragged,
          which is the difference between a figure and a list. */}
      <div className="grid grid-cols-[max-content_minmax(24px,1fr)_max-content] items-center gap-x-2.5 gap-y-2.5">
        {flows.map((flow) => (
          <Fragment key={flow.fn}>
            <motion.span variants={step} className={`${CHIP} justify-between`}>
              <span className={`${MONO} ${TEXT}`}>{flow.source}</span>
              <span className={TAG}>{flow.tag}</span>
            </motion.span>
            <motion.span
              variants={drawX}
              style={{ originX: 0 }}
              className="border-t border-dotted border-white/[0.24]"
            />
            <motion.span
              variants={step}
              className={`${flow.bright ? CHIP_BRIGHT : CHIP} justify-between`}
            >
              <span className={`${MONO} ${flow.bright ? BRIGHT : TEXT}`}>{flow.fn}</span>
              <span className={`${MONO} ${MUTED}`}>{flow.meta}</span>
            </motion.span>
          </Fragment>
        ))}
      </div>
      <Caption>rate limits · every run logged</Caption>
    </Slot>
  )
}
