'use client'

/**
 * ChangePath: a day on production, drawn as a timeline that assembles itself.
 *
 * History: this replaced ChangePlayer (a tab list beside mocked dashboard
 * cards), which read as generated. The first ChangePath was a static line of
 * chips; the founder asked for the drawing to BUILD itself on load, in the
 * manner of InsForge's branch timeline. This is that, in Backenly's own terms.
 *
 * THE SCENE. Production runs left to right. Three agents propose changes off
 * it, and each branch ends the way that kind of change really ends here:
 *
 *   - Claude Code adds comments. Planned into typed actions, verified against
 *     the running backend, applied, and merged back into production. Green.
 *   - Cursor renames a column. A check fails, so it never reaches
 *     production: the restore point puts things back. Red.
 *   - Codex wants to drop a column with live rows. That is destructive, so it
 *     parks in the Review Queue and waits for a person. Amber, and it keeps
 *     pulsing, because it is still waiting.
 *
 * Everything named is a real product noun (typed actions, the Review Queue,
 * verification, restore points). Times and names are illustrative; the
 * section says so under the drawing.
 *
 * HOW IT DRAWS. One SVG in a fixed 1260x470 coordinate space, scaled to the
 * container, shown from xl up (below that the text would scale under 10px, so
 * smaller screens get the same story as cards and an upright list). Lines draw
 * with framer's pathLength; dashed lines are drawn through a mask, because
 * pathLength works by rewriting stroke-dasharray and would erase the dashes.
 * The sequence starts the first time the figure is 35% on screen. Reduced
 * motion gets the finished drawing with no sequence and no pulses.
 */

import { useId, useRef } from 'react'
import { motion, useInView, type Variants } from 'framer-motion'
import { AGENT_MARKS } from '@/components/landing/AgentMarks'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'

const W = 1260
const H = 470
const TRACK_Y = 240

const GREEN = '#4ade80'
const RED = '#f87171'
const AMBER = '#fbbf24'
const VIOLET = '#a78bfa'

const mark = (id: string) => AGENT_MARKS.find((m) => m.id === id)!

/* ── Motion factories ────────────────────────────────────────────────────── */

type T = (delay: number, duration?: number) => Variants

function makeMotion(quiet: boolean) {
  const d = (delay: number) => (quiet ? 0 : delay)
  const dur = (duration: number) => (quiet ? 0 : duration)

  const draw: T = (delay, duration = 0.5) => ({
    hidden: { pathLength: 0, opacity: 0 },
    visible: {
      pathLength: 1,
      opacity: 1,
      transition: {
        pathLength: { delay: d(delay), duration: dur(duration), ease: [0.65, 0, 0.35, 1] },
        opacity: { delay: d(delay), duration: 0.01 },
      },
    },
  })

  const pop: T = (delay, duration = 0.45) => ({
    hidden: { opacity: 0, scale: 0.4 },
    visible: {
      opacity: 1,
      scale: 1,
      transition: { delay: d(delay), duration: dur(duration), ease: [0.34, 1.56, 0.64, 1] },
    },
  })

  const rise: T = (delay, duration = 0.5) => ({
    hidden: { opacity: 0, y: 8 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { delay: d(delay), duration: dur(duration), ease: [0.16, 1, 0.3, 1] },
    },
  })

  const fade: T = (delay, duration = 0.4) => ({
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { delay: d(delay), duration: dur(duration) } },
  })

  return { draw, pop, rise, fade }
}

type Kit = ReturnType<typeof makeMotion>

/** Scale and pop around the element's own centre, not the SVG origin. */
const CENTRED = { transformBox: 'fill-box', transformOrigin: 'center' } as const

/* ── Primitives ──────────────────────────────────────────────────────────── */

function Line({ d, stroke, delay, duration, kit }: {
  d: string; stroke: string; delay: number; duration?: number; kit: Kit
}) {
  return (
    <motion.path d={d} stroke={stroke} strokeWidth={1.5} fill="none" strokeLinecap="round" variants={kit.draw(delay, duration)} />
  )
}

/** A dashed line that still draws: the dashes are revealed through a mask. */
function Dashed({ d, delay, duration, kit, stroke = 'rgba(255,255,255,0.32)', className }: {
  d: string; delay: number; duration?: number; kit: Kit; stroke?: string; className?: string
}) {
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <>
      <mask id={id} maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
        <motion.path d={d} stroke="#fff" strokeWidth={6} fill="none" variants={kit.draw(delay, duration)} />
      </mask>
      <path d={d} stroke={stroke} strokeWidth={1.25} strokeDasharray="3 5" fill="none" mask={`url(#${id})`} className={className} />
    </>
  )
}

/** An event on the production line: a ring with a lit core. */
function EventNode({ x, color, delay, kit }: { x: number; color: string; delay: number; kit: Kit }) {
  return (
    <motion.g variants={kit.pop(delay)} style={CENTRED}>
      <circle cx={x} cy={TRACK_Y} r={8} fill="#08090a" stroke={color} strokeOpacity={0.55} strokeWidth={1.25} />
      <circle cx={x} cy={TRACK_Y} r={3.5} fill={color} />
    </motion.g>
  )
}

function Time({ x, above, children, delay, kit }: {
  x: number; above?: boolean; children: string; delay: number; kit: Kit
}) {
  return (
    <motion.text
      x={x}
      y={above ? TRACK_Y - 20 : TRACK_Y + 30}
      textAnchor="middle"
      className="fill-zinc-500 font-mono"
      fontSize={12}
      variants={kit.fade(delay)}
    >
      {children}
    </motion.text>
  )
}

/**
 * Who asked for the change, and what. Mono throughout, so the pill's width can
 * be computed from its characters (Geist Mono runs 0.6em per character).
 */
function AgentPill({ cx, cy, agent, action, delay, kit }: {
  cx: number; cy: number; agent: string; action: string; delay: number; kit: Kit
}) {
  const m = mark(agent)
  const cw = 7.2 // 12px mono
  const nameW = m.name.length * cw
  const actionW = action.length * cw
  const w = 16 + 16 + 8 + nameW + 10 + actionW + 16
  const x = cx - w / 2
  const y = cy - 18
  return (
    <motion.g variants={kit.rise(delay)}>
      <rect x={x} y={y} width={w} height={36} rx={18} fill="#0c0d10" stroke="rgba(255,255,255,0.14)" />
      <svg x={x + 16} y={cy - 8} width={16} height={16} viewBox="0 0 24 24">
        <path d={m.path} fill={agent === 'claude' ? '#d97757' : '#e4e4e7'} />
      </svg>
      <text x={x + 40} y={cy + 4} fontSize={12} className="fill-zinc-500 font-mono">
        {m.name}
      </text>
      <text x={x + 40 + nameW + 10} y={cy + 4} fontSize={12} className="fill-zinc-100 font-mono">
        {action}
      </text>
    </motion.g>
  )
}

/** Width of a stage card, from its badge and label (both mono). */
function stageWidth(badge: string, label: string) {
  return 8 + (badge.length * 6.6 + 16) + 10 + label.length * 7.8 + 14
}

/** A stage of the change: light card, dark badge. */
function StageCard({ x, cy, badge, label, badgeFill = '#09090b', badgeText = '#fafafa', delay, kit }: {
  x: number; cy: number; badge: string; label: string; badgeFill?: string; badgeText?: string; delay: number; kit: Kit
}) {
  const bw = badge.length * 6.6 + 16
  const w = stageWidth(badge, label)
  return (
    <motion.g variants={kit.rise(delay)}>
      <rect x={x} y={cy - 20} width={w} height={40} rx={8} fill="#f4f4f5" />
      <rect x={x + 8} y={cy - 12} width={bw} height={24} rx={4} fill={badgeFill} />
      <text x={x + 8 + bw / 2} y={cy + 4} textAnchor="middle" fontSize={11} letterSpacing="0.06em" fill={badgeText} className="font-mono">
        {badge}
      </text>
      <text x={x + 8 + bw + 10} y={cy + 5} fontSize={13} fill="#09090b" className="font-mono">
        {label}
      </text>
    </motion.g>
  )
}

type Glyph = 'check' | 'up' | 'x' | 'restore'

const GLYPHS: Record<Glyph, string> = {
  check: 'M-5 0.5 L-1.5 4 L5.5 -3.5',
  up: 'M0 5.5 V-5.5 M-4.5 -1 L0 -5.5 L4.5 -1',
  x: 'M-4.5 -4.5 L4.5 4.5 M4.5 -4.5 L-4.5 4.5',
  restore: 'M-5 -1 A5.2 5.2 0 1 1 -2.6 4.4 M-5.4 -5.2 V-0.8 H-1',
}

function Outcome({ cx, cy, glyph, color, label, below, delay, kit }: {
  cx: number; cy: number; glyph: Glyph; color: string; label: string; below?: boolean; delay: number; kit: Kit
}) {
  return (
    <>
      <motion.g variants={kit.pop(delay)} style={CENTRED}>
        <circle cx={cx} cy={cy} r={18} fill="#08090a" stroke={color} strokeWidth={1.5} />
        <path d={GLYPHS[glyph]} transform={`translate(${cx} ${cy})`} stroke={color} strokeWidth={1.75} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </motion.g>
      <motion.text
        x={cx}
        y={below ? cy + 40 : cy - 30}
        textAnchor="middle"
        fontSize={13}
        className="fill-zinc-400"
        variants={kit.fade(delay + 0.1)}
      >
        {label}
      </motion.text>
    </>
  )
}

/* ── The scene ───────────────────────────────────────────────────────────── */

function Scene({ kit, quiet }: { kit: Kit; quiet: boolean }) {
  const ticks: number[] = []
  for (let x = 230; x < W - 20; x += 70) ticks.push(x)
  const events = [300, 440, 830, 1000]

  // Branch geometry. A and C rise above the line, B drops below it.
  const A = { x: 300, card: 360, cy: 76 }
  const aCardEnd = A.card + stageWidth('PLAN', '4 typed actions')
  const B = { x: 440, card: 500, cy: 404 }
  const bCardEnd = B.card + stageWidth('PLAN', 'rename posts.title')
  const C = { x: 1000, card: 1040, cy: 76 }
  const cCardEnd = C.card + stageWidth('REVIEW', 'waiting on you')

  return (
    <>
      <defs>
        {/* userSpaceOnUse: a horizontal line has a zero-height bounding box, and
            a bounding-box gradient on one renders nothing at all. */}
        <linearGradient id="cp-track" gradientUnits="userSpaceOnUse" x1={168} x2={W} y1={0} y2={0}>
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.9" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="cp-red-fade" gradientUnits="userSpaceOnUse" x1={888} x2={950} y1={0} y2={0}>
          <stop offset="0" stopColor={RED} />
          <stop offset="1" stopColor={RED} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Production, and the line it runs along. */}
      <motion.g variants={kit.rise(0)}>
        <rect x={0} y={TRACK_Y - 20} width={168} height={40} rx={8} fill="#f4f4f5" />
        <rect x={8} y={TRACK_Y - 12} width={44} height={24} rx={4} fill="#16a34a" />
        <text x={30} y={TRACK_Y + 4} textAnchor="middle" fontSize={11} letterSpacing="0.06em" fill="#f0fdf4" className="font-mono">
          LIVE
        </text>
        <text x={62} y={TRACK_Y + 5} fontSize={14} fontWeight={500} fill="#09090b">
          Production
        </text>
      </motion.g>
      <motion.path d={`M168 ${TRACK_Y} H${W}`} stroke="url(#cp-track)" strokeWidth={1.25} fill="none" variants={kit.draw(0.15, 1.6)} />
      {ticks
        .filter((x) => !events.includes(x))
        .map((x) => (
          <motion.circle
            key={x}
            cx={x}
            cy={TRACK_Y}
            r={2.5}
            fill="rgba(255,255,255,0.28)"
            variants={kit.pop(0.15 + ((x - 168) / (W - 168)) * 1.6, 0.3)}
            style={CENTRED}
          />
        ))}

      {/* A · Claude Code adds comments: planned, verified, applied, merged. */}
      <EventNode x={A.x} color={VIOLET} delay={0.45} kit={kit} />
      <Time x={A.x} delay={0.5} kit={kit}>09:45</Time>
      <Dashed d={`M${A.x} ${TRACK_Y - 8} V188`} delay={0.6} duration={0.3} kit={kit} />
      <AgentPill cx={A.x} cy={170} agent="claude" action="add comments" delay={0.8} kit={kit} />
      <Dashed d={`M${A.x} 152 V100 A24 24 0 0 1 ${A.x + 24} ${A.cy} H${A.card}`} delay={1.0} duration={0.45} kit={kit} />
      <StageCard x={A.card} cy={A.cy} badge="PLAN" label="4 typed actions" delay={1.35} kit={kit} />
      <Line d={`M${aCardEnd} ${A.cy} H632`} stroke={GREEN} delay={1.6} duration={0.3} kit={kit} />
      <Outcome cx={650} cy={A.cy} glyph="check" color={GREEN} label="Verified 5/5" delay={1.85} kit={kit} />
      <Line d={`M668 ${A.cy} H722`} stroke={GREEN} delay={2.0} duration={0.25} kit={kit} />
      <Outcome cx={740} cy={A.cy} glyph="up" color={GREEN} label="Applied" delay={2.2} kit={kit} />
      <Line d={`M758 ${A.cy} H800 A30 30 0 0 1 830 106 V${TRACK_Y - 8}`} stroke={GREEN} delay={2.35} duration={0.55} kit={kit} />
      <EventNode x={830} color={GREEN} delay={2.85} kit={kit} />
      <Time x={830} delay={2.9} kit={kit}>14:20</Time>

      {/* B · Cursor renames a column: a check fails, the restore point wins. */}
      <EventNode x={B.x} color={VIOLET} delay={0.75} kit={kit} />
      <Time x={B.x} above delay={0.8} kit={kit}>11:45</Time>
      <Dashed d={`M${B.x} ${TRACK_Y + 8} V292`} delay={1.1} duration={0.3} kit={kit} />
      <AgentPill cx={B.x} cy={310} agent="cursor" action="rename title" delay={1.3} kit={kit} />
      <Dashed d={`M${B.x} 328 V380 A24 24 0 0 0 ${B.x + 24} ${B.cy} H${B.card}`} delay={1.5} duration={0.45} kit={kit} />
      <StageCard x={B.card} cy={B.cy} badge="PLAN" label="rename posts.title" delay={1.85} kit={kit} />
      <Line d={`M${bCardEnd} ${B.cy} H762`} stroke={RED} delay={2.1} duration={0.3} kit={kit} />
      <Outcome cx={780} cy={B.cy} glyph="x" color={RED} label="Check failed" below delay={2.35} kit={kit} />
      <Line d={`M798 ${B.cy} H852`} stroke={RED} delay={2.5} duration={0.25} kit={kit} />
      <Outcome cx={870} cy={B.cy} glyph="restore" color={RED} label="Restored" below delay={2.7} kit={kit} />
      <Line d={`M888 ${B.cy} H950`} stroke="url(#cp-red-fade)" delay={2.85} duration={0.35} kit={kit} />

      {/* C · Codex wants to drop a column with live rows: it waits for you. */}
      <EventNode x={C.x} color={VIOLET} delay={1.3} kit={kit} />
      <Time x={C.x} delay={1.35} kit={kit}>16:05</Time>
      <Dashed d={`M${C.x} ${TRACK_Y - 8} V188`} delay={1.6} duration={0.3} kit={kit} />
      <AgentPill cx={C.x} cy={170} agent="codex" action="drop legacy_slug" delay={1.8} kit={kit} />
      <Dashed d={`M${C.x} 152 V100 A24 24 0 0 1 ${C.x + 24} ${C.cy} H${C.card}`} delay={2.0} duration={0.4} kit={kit} />
      <StageCard
        x={C.card}
        cy={C.cy}
        badge="REVIEW"
        label="waiting on you"
        badgeFill={AMBER}
        badgeText="#1c1407"
        delay={2.35}
        kit={kit}
      />
      <Dashed
        d={`M${cCardEnd} ${C.cy} H${W}`}
        stroke={AMBER}
        delay={2.6}
        duration={0.2}
        kit={kit}
        className={quiet ? undefined : 'path-wait'}
      />
      {/* Still waiting: the one thing in the scene that never settles. */}
      {!quiet && (
        <motion.g variants={kit.fade(2.8)}>
          <circle
            cx={C.card + 8 + (6 * 6.6 + 16) / 2}
            cy={C.cy}
            r={16}
            fill="none"
            stroke={AMBER}
            className="path-wait-ring"
            style={CENTRED}
          />
        </motion.g>
      )}
    </>
  )
}

/* ── Captions and the small-screen version ───────────────────────────────── */

type Stage = { title: string; body: string }

const STAGES: Stage[] = [
  { title: 'Plan', body: 'Your agent writes ordinary SQL. Backenly turns it into typed actions and says what each one touches.' },
  { title: 'Review', body: 'Additive work passes. Anything destructive leaves the line and waits for a person. The agent can ask, never approve.' },
  { title: 'Apply', body: 'A restore point is captured before the first write, then the plan commits atomically. All of it or none of it.' },
  { title: 'Verify', body: 'Real requests hit the running backend as a stranger and as a user. Done means it behaves, not that it ran.' },
  { title: 'Record', body: 'Every change lands in one ledger, with its actor, its diff and a one-click way back.' },
]

const OUTCOMES = [
  { agent: 'claude', action: 'add comments', result: 'Verified 5/5, applied, merged', color: GREEN },
  { agent: 'cursor', action: 'rename title', result: 'Check failed, restored', color: RED },
  { agent: 'codex', action: 'drop legacy_slug', result: 'Waiting on you in the Review Queue', color: AMBER },
]

export function ChangePath() {
  const quiet = useSettledReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.35 })
  const kit = makeMotion(quiet)

  return (
    <figure>
      <div ref={ref} className="hidden xl:block">
        <motion.svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full select-none overflow-visible"
          role="img"
          aria-label="A day on production. Claude Code adds comments: planned, verified 5 of 5, applied and merged. Cursor renames a column: a check fails and the restore point puts it back. Codex asks to drop a column with live rows: it waits in the Review Queue for a person."
          initial="hidden"
          animate={inView || quiet ? 'visible' : 'hidden'}
        >
          <Scene kit={kit} quiet={quiet} />
        </motion.svg>
        <p className="mt-2 text-right text-[13px] text-zinc-600">
          One day on one project, drawn from the real flow. Names and times are illustrative.
        </p>
      </div>

      <figcaption className="mt-14 hidden gap-x-8 xl:grid xl:grid-cols-5">
        {STAGES.map((stage) => (
          <div key={stage.title} className="border-t border-white/[0.08] pt-5">
            <h3 className="text-[17px] font-semibold tracking-[-0.018em] text-white">{stage.title}</h3>
            <p className="mt-2 max-w-[30ch] text-[14.5px] leading-[1.65] tracking-[-0.004em] text-zinc-400">
              {stage.body}
            </p>
          </div>
        ))}
      </figcaption>

      {/* Below xl the drawing's type would scale under 10px, so the same day
          is told as three outcomes and the five stages, upright. */}
      <div className="xl:hidden">
        <ul className="grid gap-3 sm:grid-cols-3">
          {OUTCOMES.map((o) => {
            const m = mark(o.agent)
            return (
              <li key={o.agent} className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <div className="flex items-center gap-2 font-mono text-[12px]">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" aria-hidden>
                    <path d={m.path} fill={o.agent === 'claude' ? '#d97757' : '#e4e4e7'} />
                  </svg>
                  <span className="text-zinc-500">{m.name}</span>
                  <span className="truncate text-zinc-100">{o.action}</span>
                </div>
                <p className="mt-3 flex items-center gap-2 text-[14px] text-zinc-300">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: o.color }} />
                  {o.result}
                </p>
              </li>
            )
          })}
        </ul>
        <ol className="relative mt-12">
          <span aria-hidden className="absolute bottom-3 left-[5px] top-3 w-px bg-white/[0.14]" />
          {STAGES.map((stage) => (
            <li key={stage.title} className="relative pb-9 pl-8 last:pb-0">
              <span aria-hidden className="absolute left-0 top-[7px] h-[11px] w-[11px] rounded-full border border-white/30 bg-[#08090a]" />
              <h3 className="text-[17px] font-semibold tracking-[-0.018em] text-white">{stage.title}</h3>
              <p className="mt-1.5 max-w-[52ch] text-[15px] leading-[1.65] text-zinc-400">{stage.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </figure>
  )
}
