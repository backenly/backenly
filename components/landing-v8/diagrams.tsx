'use client'

/**
 * Landing v8 copy of components/landing/CapabilityDiagrams (the /features
 * pages keep the original). Polished 2026-11-14: tags are lowercase mono in
 * the console's faint grey instead of 9px all caps at about 2.5:1, and the
 * dim labels lift to pass 4.5:1.
 *
 * Diagrams for the "Platform surface" cards.
 *
 * 2026-11-28, from three designers' review (every value checked in the code):
 * every figure is the page's one example project, movie reviews, in Backenly's
 * real shapes (createdAt, Prefer: count=exact and its 206, lowercase realtime
 * event types, on_signup / on_insert triggers with snake_case names, a private
 * bucket); sizes are px, since the root font size is 13px and Tailwind's rem
 * steps other than 1/2/3/4/6/8/12 land between pixels; one dash texture for
 * every leader (LEADER_LINE); Realtime is drawn 300 wide so it is 1:1 from md.
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
 *   2. Realtime's three events light once, in order, as the card arrives (no
 *      endless blinking: anything moving past five seconds needs a pause).
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
import { MotionConfig, motion, type Variants } from 'motion/react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'

const MONO = 'font-mono text-[12px] leading-none tracking-tight'
const TEXT = 'text-zinc-300'
const MUTED = 'text-faint'
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
const FILL_DIM = 'fill-[#8b8b94]'
const FIG_LABEL = 'font-mono text-[12px] tracking-tight'

/** Applied to every stroked shape. See rule 1 in the file comment. */
const CRISP = { vectorEffect: 'non-scaling-stroke' } as const

/** Node chip: mono label on solid ink so nothing bleeds through a word. Fixed
    height so connector geometry is deterministic. */
const CHIP =
  'inline-flex h-8 items-center gap-2 rounded-[6px] border border-white/[0.09] bg-[#0b0b0e] px-[10px]'
/** The emphasized node reads brighter, not colored. */
const CHIP_BRIGHT =
  'inline-flex h-8 items-center gap-2 rounded-[6px] border border-white/[0.18] bg-[#0b0b0e] px-[10px]'
/** The small type label inside a chip — `event`, `cron`, `signing secret`. */
const TAG = 'font-mono text-[12px] tracking-[-0.01em] text-faint [font-variant-ligatures:none]'

const EASE_OUT = [0.16, 1, 0.3, 1] as const

/**
 * The HTML leaders, drawn with the same dash as the SVG ones (2 on, 4 off, white/24) rather than a CSS dotted border,
 * which is a second texture beside them.
 */
const LEADER_LINE = 'h-px bg-[linear-gradient(90deg,rgb(255_255_255/0.24)_2px,transparent_0)] bg-[length:6px_1px] bg-repeat-x'

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

/**
 * The server cannot know the reduced-motion preference, so the first render
 * must be the same for everyone: `initial="hidden"` always. Letting framer's
 * `useReducedMotion()` pick `initial={false}` during render made the server
 * HTML (opacity 0) disagree with the client for every reduced-motion visitor,
 * a hydration mismatch React does not patch up. `useSettledReducedMotion`
 * reads the preference after hydration; those visitors then get the figure
 * immediately, with transforms disabled, instead of on scroll.
 */
function Slot({ children, className = '', floor = true }: { children: React.ReactNode; className?: string; floor?: boolean }) {
  const reduceMotion = useSettledReducedMotion()

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'never'}>
      <motion.div
        className={`relative mt-8 flex ${floor ? 'min-h-[184px]' : ''} select-none flex-col justify-end ${className}`.trim()}
        aria-hidden
        initial="hidden"
        animate={reduceMotion ? 'visible' : undefined}
        whileInView={reduceMotion ? undefined : 'visible'}
        viewport={{ once: true, amount: 0.4 }}
        variants={sequence}
      >
        {children}
      </motion.div>
    </MotionConfig>
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
  anchor = 'middle',
  children,
}: {
  x: number
  y: number
  bright?: boolean
  anchor?: 'middle' | 'end'
  children: React.ReactNode
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      className={`${FIG_LABEL} ${bright ? FILL_KEY : FILL_DIM}`}
    >
      {children}
    </text>
  )
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <motion.p variants={step} className={`${MONO} mt-[14px] ${MUTED}`}>
      {children}
    </motion.p>
  )
}

/* ─── Database ──────────────────────────────────────────────── */

/**
 * Two tenants drawn as separate stores with a dashed wall between them, and an
 * fk bracket inside the near one — "relations" is in the paragraph and was in
 * nothing on the card. The near project is the page's example, movie reviews
 * (reviews.movie_id → movies.id); the far one is another project's, dim. Both
 * names end at one x, so the bracket keeps the same gap from each. Schema names
 * are workspace_ plus the project's id (lib/security/workspace-schema.ts).
 */
export function DatabaseDiagram() {
  return (
    <Slot>
      <motion.div variants={step}>
        <Fig w={360} h={192}>
          <Store cx={90.5} top={22} body={126} rx={78} bright />
          <FigLabel x={96.5} y={78} anchor="end" bright>
            movies
          </FigLabel>
          <FigLabel x={96.5} y={100} anchor="end" bright>
            reviews
          </FigLabel>
          {/* reviews.movie_id → movies.id, drawn as a bracket rather than a
              label, so it reads as a constraint and not as more prose. */}
          <path d="M102.5 74.5 H120.5 V96.5 H102.5" className={DIM} {...CRISP} />
          <text x={126} y={88.5} className={`${FIG_LABEL} ${FILL_DIM}`}>
            fk
          </text>
          <FigLabel x={90.5} y={178} bright>
            workspace_8f2a…
          </FigLabel>

          {/* The grant boundary, in the leaders' dash. Nothing crosses it, which is the whole claim. */}
          <line x1={180.5} y1={8} x2={180.5} y2={184} strokeDasharray="2 4" className={LEADER} {...CRISP} />

          <Store cx={270.5} top={22} body={126} rx={78} bright={false} />
          <FigLabel x={270.5} y={78}>
            orders
          </FigLabel>
          <FigLabel x={270.5} y={100}>
            customers
          </FigLabel>
          <FigLabel x={270.5} y={178}>
            workspace_c3d4…
          </FigLabel>
        </Fig>
      </motion.div>
      <Caption>one schema per project · no shared tables</Caption>
    </Slot>
  )
}

/* ─── REST APIs ─────────────────────────────────────────────── */

/**
 * The request a client really makes for one page of the example's reviews: the
 * PostgREST grammar at /api/v2 (server/routes/v2.ts), an embedded movie, a
 * filter, the createdAt column every table gets (lib/mcp/migration-parser.ts),
 * and Prefer: count=exact, without which the total is "*"
 * (lib/postgrest/translate.ts). A counted partial page answers 206, with its
 * content-range. The window runs off the bottom of the cell — the crop is the
 * point. No window dots (it is not a browser) and no skeleton bars (they read
 * as loading): the response body itself runs into the crop. On hover the embed
 * in the request lights up with the key it returns.
 */
export function RestApiDiagram() {
  return (
    <Slot>
      <motion.div
        variants={step}
        className="-mb-[64px] h-[248px] overflow-hidden rounded-t-[8px] border border-b-0 border-white/[0.09] bg-[#0a0a0d]"
      >
        <div className="flex items-center gap-[10px] border-b border-white/[0.06] bg-white/[0.015] px-[12px] py-[10px]">
          <span className={`${MONO} min-w-0 flex-1 truncate ${TEXT}`}>
            <span className={BRIGHT}>GET</span> /api/v2/…/reviews
          </span>
          <span className={`${MONO} shrink-0 ${MUTED}`}>206</span>
        </div>
        <div className="space-y-[8px] px-[12px] pb-[16px] pt-[12px]">
          <motion.p variants={step} className={`${MONO} ${MUTED}`}>
            ?select=*,
            <span className="transition-colors duration-150 [@media(hover:hover)_and_(pointer:fine)]:group-hover:text-zinc-100">movies(title)</span>
            &amp;limit=25
          </motion.p>
          <motion.p variants={step} className={`${MONO} ${MUTED}`}>
            &amp;rating=gte.4&amp;order=createdAt.desc
          </motion.p>
          <motion.p variants={step} className={`${MONO} ${MUTED}`}>
            prefer: <span className={TEXT}>count=exact</span>
          </motion.p>
          {/* Pagination is a claim in the paragraph; this is the header that answers it. */}
          <motion.p variants={step} className={`${MONO} ${MUTED}`}>
            content-range: <span className={TEXT}>0-24/6107</span>
          </motion.p>
          {/* Pretty-printed on purpose: indented lines read as a response body. The array runs on past the crop. */}
          <motion.div variants={step} className={`${MONO} space-y-[6px] pt-[2px] ${MUTED}`}>
            <p>[ {'{'} &quot;rating&quot;: 5, &quot;body&quot;: &quot;…&quot;,</p>
            <p className="pl-4">
              <span className={BRIGHT}>&quot;movies&quot;</span>: {'{'} &quot;title&quot;: &quot;Metropolis&quot; {'}'} {'}'},
            </p>
            <p className="pl-2">{'{'} &quot;rating&quot;: 4, &quot;body&quot;: &quot;…&quot;,</p>
            <p className="pl-4">
              &quot;movies&quot;: {'{'} &quot;title&quot;: &quot;Sunrise&quot; {'}'} {'}'},
            </p>
            <p className="pl-2">{'{'} &quot;rating&quot;: 5, &quot;body&quot;: &quot;…&quot;,</p>
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
 * The token is what a project's runtime issues: a JWT signed HS256 with the
 * project's own secret, for 7 days, carrying the user's id (a UUID) and role
 * (server/routes/auth.ts). OAuth is named by two of its providers.
 *
 * Chip pitch is h-8 (32px) with a 10px gap, so route centres land on 16 / 58 /
 * 100 of a 116-unit block and the junction sits at its exact middle (a
 * `gap-2.5` here was 8.125px at the 13px root, 1.5px off).
 */
export function AuthDiagram() {
  const methods = ['password', 'google · github', 'magic link']

  return (
    <Slot>
      <div className="flex items-center">
        {/* items-stretch: every route leaves the column at the same x, so the
            three stubs are the same length. */}
        <div className="flex shrink-0 flex-col items-stretch gap-[10px]">
          {methods.map((method) => (
            <motion.span key={method} variants={step} className={CHIP}>
              <span className={`${MONO} ${TEXT}`}>{method}</span>
            </motion.span>
          ))}
        </div>
        {/* The block stops at the junction, not past it; ending the SVG on the
            dot makes the dot the transition to the HTML leader. */}
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
        <motion.span variants={drawX} style={{ originX: 0 }} className={`min-w-0 flex-1 ${LEADER_LINE}`} />
        <motion.span variants={step} className={`${CHIP_BRIGHT} shrink-0`}>
          <span className={`${MONO} ${BRIGHT}`}>JWT</span>
          <span className={TAG}>HS256</span>
        </motion.span>
      </div>
      {/* What the token actually carries — the claims RLS then reads. */}
      <motion.p variants={step} className={`${MONO} mt-4 ${MUTED}`}>
        {'{'} &quot;userId&quot;: &quot;3f9c61e2-…&quot;, &quot;role&quot;:{' '}
        <span className={TEXT}>&quot;user&quot;</span> {'}'}
      </motion.p>
      <Caption>expires in 7 days · secret per project</Caption>
    </Slot>
  )
}

/* ─── Storage ───────────────────────────────────────────────── */

/**
 * The example project's posters bucket (public-domain films), as create_bucket
 * makes it: private, with uploads from the project's server only
 * (lib/mcp/domains.ts). The expiring signed link is the point, so it is the one
 * row with a drawn lifetime: at rest part-run; on hover it drains in real linear
 * time (tailwind.config.ts remaps `ease-linear` to an ease-out, so the timing is
 * written out) and ends in the 401 an expired link gets. Under reduced motion
 * the same states change without animating. (The hover classes are written out
 * in full: Tailwind only generates classes it finds whole in the source.)
 */
export function StorageDiagram() {
  const rows = [
    { name: 'metropolis.jpg', size: '388 KB', signed: true },
    { name: 'the-general.jpg', size: '341 KB', signed: false },
    { name: 'sunrise.jpg', size: '296 KB', signed: false },
    { name: 'the-kid.jpg', size: '412 KB', signed: false },
  ]

  return (
    <Slot>
      <motion.div
        variants={step}
        className={`${MONO} flex items-center justify-between border-b border-white/[0.10] pb-[10px] ${MUTED}`}
      >
        <span>bucket · posters</span>
        <span>S3</span>
      </motion.div>
      {rows.map((row) => (
        <motion.div key={row.name} variants={step}>
          <div className="flex items-end gap-2 pt-4">
            <span className={`${MONO} ${row.signed ? TEXT : MUTED}`}>{row.name}</span>
            <span className={`mb-[3px] min-w-0 flex-1 ${LEADER_LINE}`} />
            <span className={`${MONO} shrink-0 ${row.signed ? TEXT : MUTED}`}>{row.size}</span>
          </div>
          {row.signed && (
            <div className="mt-[10px] flex items-center gap-[8px]">
              {/* The track has to read, or the part-run fill is just a stray dash under the filename. */}
              <div className="h-[2px] w-[96px] shrink-0 overflow-hidden rounded-full bg-white/[0.17]">
                <span
                  className={`block h-full w-full origin-left scale-x-[0.58] rounded-full bg-white/60 transition-transform duration-200 ease-[linear] motion-reduce:transition-none [@media(hover:hover)_and_(pointer:fine)]:group-hover:scale-x-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:duration-[2400ms]`}
                />
              </div>
              <span className="grid [&>*]:[grid-area:1/1]">
                <span className={`${MONO} ${BRIGHT} transition-opacity duration-150 motion-reduce:transition-none [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:delay-[2400ms]`}>
                  signed url · expires 3600s
                </span>
                <span
                  aria-hidden
                  className={`${MONO} ${TEXT} opacity-0 transition-opacity duration-150 motion-reduce:transition-none [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-hover:delay-[2400ms]`}
                >
                  expired · 401
                </span>
              </span>
            </div>
          )}
        </motion.div>
      ))}
      <Caption>private bucket · server_only uploads</Caption>
    </Slot>
  )
}

/* ─── Realtime ──────────────────────────────────────────────── */

/**
 * One store fanning out to the three row events, because "table change
 * streams" is invisible until you see one land in a client. Three columns, so
 * the fan endpoints are the column centres by construction, and the store is
 * the Database store scaled down — same object, same shape.
 *
 * Drawn 300 wide so it maps 1:1 to its column from md up (the cells are 302 to
 * 355px wide; at 360 it shrank and its label fell under 12px). The events are
 * written as they go over the wire, lowercase (lib/realtime/channel-sql.ts),
 * and the caption is the stream a client opens (server/routes/realtime.ts).
 */
export function RealtimeDiagram() {
  const reduceMotion = useSettledReducedMotion()
  const ops = ['insert', 'update', 'delete']
  /** Column centres of a 3-column grid across the 300-unit figure. */
  const columns = [50.5, 150.5, 250.5]

  return (
    <Slot>
      <div className="w-full max-w-[300px]">
        <motion.div variants={step}>
          <Fig w={300} h={124}>
            <Store cx={150.5} top={12} body={71} rx={44} bright />
            <FigLabel x={150.5} y={52} bright>
              reviews
            </FigLabel>
            {/* Origin is just under the floor's lowest point, so the fan leaves
                the store rather than appearing to start inside it. */}
            {columns.map((x) => (
              <path
                key={x}
                d={`M150.5 92 L${x} 123`}
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
              {/* The events light once, in order, as the card arrives. */}
              <motion.span
                className={`h-[6px] w-[6px] shrink-0 rounded-full ${i === 0 ? 'bg-zinc-200' : 'bg-white/25'}`}
                initial={false}
                whileInView={reduceMotion ? undefined : { opacity: [0.25, 1, 0.25, 1] }}
                viewport={{ once: true, amount: 0.6 }}
                transition={{ duration: 1.6, ease: 'easeInOut', delay: 0.5 + i * 0.6 }}
              />
              <span className={`${MONO} ${TEXT}`}>{op}</span>
            </motion.span>
          ))}
        </div>
      </div>
      <Caption>/api/v1/…/realtime?table=reviews · SSE</Caption>
    </Slot>
  )
}

/* ─── Functions & triggers ──────────────────────────────────── */

/**
 * Three parallel flows, one per way a function starts, in the product's own
 * words (lib/ai/brain/tools.ts): a sign-up (on_signup), a row event on a table
 * (on_insert, on reviews) and a five-field cron, each into a snake_case
 * function (lib/services/ai-functions/names.ts) with its run time.
 *
 * A grid, not flex rows: every source chip shares one column width and every
 * function chip another, so the leaders run in one clean channel. Columns are
 * `minmax(0,max-content)` so a narrow cell truncates instead of overflowing.
 * No floor: in its row the figure sits beside "Also built in", whose own
 * height sets the row.
 */
export function FunctionsDiagram() {
  const flows = [
    { source: 'on_signup', tag: '', fn: 'send_welcome', meta: '42ms', bright: true },
    { source: 'on_insert', tag: 'reviews', fn: 'update_rating', meta: '61ms', bright: false },
    { source: '0 6 * * 1', tag: 'cron', fn: 'weekly_digest', meta: '187ms', bright: false },
  ]

  return (
    <Slot floor={false}>
      <div className="grid grid-cols-[minmax(0,max-content)_minmax(16px,1fr)_minmax(0,max-content)] items-center gap-x-2 gap-y-[10px] sm:gap-x-[10px]">
        {flows.map((flow) => (
          <Fragment key={flow.fn}>
            <motion.span variants={step} className={`${CHIP} min-w-0 justify-between`}>
              <span className={`${MONO} truncate ${TEXT}`}>{flow.source}</span>
              {flow.tag && <span className={`${TAG} shrink-0`}>{flow.tag}</span>}
            </motion.span>
            <motion.span variants={drawX} style={{ originX: 0 }} className={LEADER_LINE} />
            <motion.span variants={step} className={`${flow.bright ? CHIP_BRIGHT : CHIP} min-w-0 justify-between`}>
              <span className={`${MONO} truncate ${flow.bright ? BRIGHT : TEXT}`}>{flow.fn}</span>
              <span className={`${MONO} shrink-0 ${MUTED}`}>{flow.meta}</span>
            </motion.span>
          </Fragment>
        ))}
      </div>
      <Caption>every run logged</Caption>
    </Slot>
  )
}
