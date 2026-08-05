'use client'

/**
 * AutonomyFilm — the proof under "It fixes problems while you sleep".
 *
 * This slot used to hold a screen recording. A recording of a running product
 * goes stale the moment the product moves: the clip shipped in 1e1ef151 showed
 * a dashboard that no longer existed eight commits later and had to be pulled.
 * So this is drawn, not filmed — the same instrument the Overview renders
 * (five phases on a rail, a return arc closing the circuit, mono readings under
 * each node), driven by a fixed script instead of live project data.
 *
 * The story is one real failure mode: row-level security goes missing on a
 * table, the resident loop finds it, snapshots, repairs it, and proves the
 * repair with a live request — at 03:14, with nobody at the keyboard. Every
 * step depicted is a step the loop actually performs; only the timings are
 * compressed, and the caption under the frame says so.
 *
 * Motion runs only while the frame is on screen and is replaced by the final
 * resolved state under prefers-reduced-motion.
 *
 * Layout: three bands — chrome, instrument, ledger — divided by hairlines, one
 * frame, one padding rhythm. Do not put the frame back on a 16:9 aspect ratio.
 * It carried `md:aspect-video` from the recording it replaced, and a drawing
 * that stands about 440px tall does not fill 720px: `justify-between` spent the
 * difference as two black voids, which read as a panel that failed to load.
 * Height comes from the content now.
 */

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion'
import { Check } from 'lucide-react'

/* ── Script ──────────────────────────────────────────────────────────────
   Six beats, ~16s a lap. Held long enough that each line is readable at a
   glance while scrolling past, not so long that the frame reads as frozen. */

type Beat = 'watch' | 'detect' | 'propose' | 'apply' | 'verify' | 'clear'

const SCRIPT: { beat: Beat; ms: number; clock: string }[] = [
  { beat: 'watch', ms: 3000, clock: '03:12' },
  { beat: 'detect', ms: 2800, clock: '03:14' },
  { beat: 'propose', ms: 2400, clock: '03:14' },
  { beat: 'apply', ms: 2600, clock: '03:15' },
  { beat: 'verify', ms: 2600, clock: '03:15' },
  { beat: 'clear', ms: 3600, clock: '03:15' },
]

const LAST = SCRIPT.length - 1

const STAGES = [
  { key: 'observe', label: 'Observe' },
  { key: 'detect', label: 'Detect' },
  { key: 'propose', label: 'Propose' },
  { key: 'apply', label: 'Apply' },
  { key: 'verify', label: 'Verify' },
] as const

/** Which node carries the signal on each beat. Clear returns it to Observe. */
const ACTIVE_NODE: Record<Beat, number> = {
  watch: 0, detect: 1, propose: 2, apply: 3, verify: 4, clear: 0,
}

/**
 * The incident ledger, written a line per beat — the "document" step, visible.
 *
 * Each line carries a phone-width variant. Truncating these with an ellipsis is
 * not a graceful degradation: the sentences ARE the proof, and "invoices ·
 * missing_rls — anonymous rea…" proves nothing.
 */
const LEDGER: { from: number; at: string; tag: string; text: string; short: string }[] = [
  {
    from: 1, at: '03:14', tag: 'Detected',
    text: 'invoices · missing_rls · anonymous reads reach every row',
    short: 'invoices · missing_rls',
  },
  {
    from: 2, at: '03:14', tag: 'Snapshot',
    text: 'Restore point captured before anything is written',
    short: 'Restore point captured',
  },
  {
    from: 3, at: '03:15', tag: 'Applied',
    text: 'Policy invoices_owner_select · a row is readable by its owner',
    short: 'Policy invoices_owner_select',
  },
  {
    from: 4, at: '03:15', tag: 'Verified',
    text: 'Live request as anonymous → denied · as owner → 200',
    short: 'Anonymous denied · owner 200',
  },
]

/**
 * Headline of the incident card, and the status word beside it.
 *
 * The marker tone tracks the hole in the backend, not the loop's mood: rose
 * while `invoices` is actually unprotected, violet once the fix is being
 * written, a check when it is verified. The status word carries its own tone —
 * alarm red on "safe to apply" would say the opposite of the sentence.
 */
function headline(beat: Beat): {
  tone: 'idle' | 'bad' | 'work' | 'good'
  title: string
  /** Phone-width variant — see the note on LEDGER. */
  short: string
  status: string
  statusTone: 'idle' | 'bad' | 'good'
} {
  switch (beat) {
    case 'watch':
      return { tone: 'idle', title: 'Watching schema, APIs, auth and storage', short: 'Watching your backend', status: 'no findings', statusTone: 'idle' }
    case 'detect':
      return { tone: 'bad', title: 'Row-level security missing on invoices', short: 'RLS missing on invoices', status: 'unprotected', statusTone: 'bad' }
    case 'propose':
      return { tone: 'bad', title: 'Deterministic and reversible, safe to apply alone', short: 'Safe to apply alone', status: 'nothing held', statusTone: 'idle' }
    case 'apply':
      return { tone: 'work', title: 'Writing the policy inside one governed change', short: 'Writing the policy', status: 'applying', statusTone: 'idle' }
    case 'verify':
      return { tone: 'work', title: 'Proving the fix against the running backend', short: 'Proving the fix', status: 'verifying', statusTone: 'idle' }
    case 'clear':
      return { tone: 'good', title: 'Backenly fixed this while you were asleep', short: 'Fixed while you slept', status: 'reversible', statusTone: 'good' }
  }
}

export function AutonomyFilm() {
  const reduced = useReducedMotion()
  const frameRef = useRef<HTMLDivElement>(null)
  // Motion is expensive and invisible off screen; the script only advances
  // while the frame is actually in front of someone.
  const inView = useInView(frameRef, { amount: 0.3 })

  const [i, setI] = useState(0)

  useEffect(() => {
    if (reduced || !inView) return
    const t = setTimeout(() => setI(v => (v + 1) % SCRIPT.length), SCRIPT[i].ms)
    return () => clearTimeout(t)
  }, [i, inView, reduced])

  // Reduced motion gets the resolved end state: the fix landed, verified, and
  // the ledger complete. No timers, no comets, no pulse.
  const step = reduced ? LAST : i
  const { beat, clock } = SCRIPT[step]
  const live = !reduced && inView
  const activeNode = ACTIVE_NODE[beat]
  const healing = !reduced && beat === 'apply'
  const card = headline(beat)

  // Readings under each node. Detect climbs to 1 and falls back once the fix
  // verifies; Propose never moves, because this fix was safe enough to land
  // without a human — the whole point of the section.
  const open = step >= 1 && step <= 3 ? '1' : '0'
  const fixed = step >= 3 ? '13' : '12'
  // Units are the dashboard's, word for word (`readings` in WorkspaceHome, and
  // LOOP in HeroConsole). This is the third depiction of the same instrument on
  // the site; a visitor who watches this film, reads the hero, then signs up
  // must not be shown three different vocabularies for one loop.
  // `short` is the phone variant, for the same reason LEDGER carries one: five
  // columns across 360px leaves ~62px each, and the full units wrapped to three
  // ragged lines that pushed every column to a different height. The short form
  // is always a subset of the full phrase — never a second vocabulary for the
  // same reading.
  const readings: { value: string; unit: string; short: string; tone?: 'bad' }[] = [
    { value: '13', unit: 'guarantees · every minute', short: 'guarantees' },
    { value: open, unit: 'broken guarantees', short: 'broken', ...(open === '1' ? { tone: 'bad' as const } : {}) },
    { value: '0', unit: 'waiting on you', short: 'waiting' },
    { value: fixed, unit: 'fixed on its own · 30d', short: 'fixed alone' },
    { value: '100%', unit: 'proven fixed · 30d', short: 'proven' },
  ]

  return (
    // Width and top margin belong to the page, not to this component: the film
    // and the three-column row under it have to share an edge, and only the
    // section knows where that edge is. See AutonomySection.
    <div className="w-full">
      <div
        ref={frameRef}
        className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-[#0a0a0c]"
        role="img"
        aria-label="The resident loop detecting missing row-level security on the invoices table at 03:14, capturing a restore point, applying the policy, and verifying it with a live request, with nobody at the keyboard."
      >
        {/* One edge-light along the top. The violet radial that used to wash
            the top-right corner is gone: at this size it read as a smudge on
            the panel, not as light. */}
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(167,139,250,0.45),transparent)]"
        />

        {/* ── Chrome ───────────────────────────────────────────────────── */}
        <Header clock={clock} live={live} />

        {/* ── The instrument ───────────────────────────────────────────── */}
        <div className="px-5 py-10 sm:px-8 sm:py-14">
          <Rail
            live={live}
            healing={healing}
            activeNode={activeNode}
            readings={readings}
            healKey={step}
          />
          <ReturnArc live={live} />
        </div>

        {/* ── The incident, as it is written ───────────────────────────── */}
        {/* A band of this frame, not a card inside it: the ledger is the same
            instrument's output, and boxing it made two nested panels. */}
        <div className="border-t border-white/[0.06] bg-white/[0.015]">
          <IncidentHeader card={card} beat={beat} reduced={!!reduced} />
          <Ledger step={step} reduced={!!reduced} />
        </div>
      </div>

      {/* The clip this replaced was real footage; this is drawn. Say so. */}
      <p className="mt-3.5 text-center text-[11px] leading-5 text-zinc-500">
        One pass of the resident loop, drawn to scale of the real instrument. Timings compressed.
      </p>
    </div>
  )
}

/* ── Header ─────────────────────────────────────────────────────────────── */

/**
 * A title bar, not a floating line of text. Ruled off from the instrument so
 * the frame reads as one panel with a top strip — the same chrome the
 * dashboard puts over its own surfaces.
 */
function Header({ clock, live }: { clock: string; live: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-white/[0.06] px-5 py-3 sm:px-8">
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-[5px] w-[5px]">
          {live && (
            <motion.span
              animate={{ opacity: [0.2, 0.85, 0.2], scale: [1, 1.9, 1] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute inset-0 rounded-full bg-violet-300/50"
            />
          )}
          <span className="relative h-[5px] w-[5px] rounded-full bg-violet-300" />
        </span>
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
          Self-healing loop
        </span>
      </div>

      <div className="flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
        <span className="tabular-nums text-zinc-500">{clock} AM</span>
        <span aria-hidden className="h-2.5 w-px bg-white/[0.09]" />
        <span>no session open</span>
      </div>
    </div>
  )
}

/* ── Rail + phase nodes ─────────────────────────────────────────────────── */

function Rail({
  live, healing, activeNode, readings, healKey,
}: {
  live: boolean
  healing: boolean
  activeNode: number
  readings: { value: string; unit: string; short: string; tone?: 'bad' }[]
  healKey: number
}) {
  return (
    <div className="relative">
      {/* One hairline through the node centers (top = node height / 2). */}
      <div className="absolute left-[10%] right-[10%] top-[14px] h-px bg-white/[0.08]" />

      {/* The signal: comets on the rail, clipped so they enter and leave at
          the first and last node rather than at the frame edge. */}
      {live && (
        <div className="pointer-events-none absolute left-[10%] right-[10%] top-[13px] h-[3px] overflow-hidden">
          <motion.span
            className="absolute top-[1px] h-px w-28 bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.85),transparent)]"
            animate={{ left: ['-18%', '104%'] }}
            transition={{ duration: 5.6, repeat: Infinity, ease: 'linear' }}
          />
          <motion.span
            className="absolute top-[1px] h-px w-16 bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.4),transparent)]"
            animate={{ left: ['-18%', '104%'] }}
            transition={{ duration: 5.6, repeat: Infinity, ease: 'linear', delay: 2.8 }}
          />
        </div>
      )}

      {/* The fix itself, driven down the rail on the Apply beat. */}
      {healing && (
        <div className="pointer-events-none absolute left-[10%] right-[10%] top-[13px] h-[3px] overflow-hidden">
          <motion.span
            key={healKey}
            className="absolute top-[1px] h-[1.5px] w-24 rounded-full bg-[linear-gradient(to_right,transparent,rgba(196,181,253,1),transparent)]"
            initial={{ left: '4%', opacity: 0 }}
            animate={{ left: '96%', opacity: [0, 1, 1, 0.6] }}
            transition={{ duration: 2.2, ease: 'easeInOut' }}
          />
        </div>
      )}

      {/* Five columns, not justify-between: node centers then land on exactly
          10/30/50/70/90%, which is what the rail and the return arc anchor to
          at every viewport width. */}
      <div className="relative grid grid-cols-5">
        {STAGES.map((s, idx) => {
          const active = idx === activeNode
          const r = readings[idx]
          return (
            <div key={s.key} className="flex min-w-0 flex-col items-center">
              <span
                className={`relative flex h-[28px] w-[28px] items-center justify-center rounded-full border bg-[#0a0a0c] transition-colors duration-300 ${
                  active ? 'border-violet-400/45' : 'border-white/[0.09]'
                }`}
              >
                {active && live && (
                  <motion.span
                    animate={{ opacity: [0.15, 0.5, 0.15], scale: [1, 1.5, 1] }}
                    transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
                    className="absolute inset-0 rounded-full bg-violet-400/25"
                  />
                )}
                {active && live && (
                  <motion.span
                    key={`ripple-${healKey}`}
                    initial={{ opacity: 0.6, scale: 1 }}
                    animate={{ opacity: 0, scale: 2.3 }}
                    transition={{ duration: 0.8, ease: 'easeOut' }}
                    className="absolute inset-0 rounded-full bg-violet-400/45"
                  />
                )}
                <span
                  className={`relative h-[6px] w-[6px] rounded-full transition-colors duration-300 ${
                    active ? 'bg-violet-300' : 'bg-zinc-600'
                  }`}
                />
              </span>

              <span
                className={`mt-3 text-[9.5px] font-semibold uppercase tracking-[0.16em] transition-colors duration-300 sm:text-[10px] ${
                  active ? 'text-violet-200' : 'text-zinc-500'
                }`}
              >
                {s.label}
              </span>

              {/* Numeral over unit, so the five readings form one scannable row
                  instead of five value+unit clumps of differing width. */}
              <Reading value={r.value} tone={r.tone} active={active} />

              {/* zinc-500, not 600: at 10px on #0a0a0c the dimmer step fell
                  under the contrast floor and the row lost its labels. */}
              <span className="mt-2 max-w-[136px] px-1 text-center text-[10px] leading-[1.4] text-zinc-500">
                <span className="sm:hidden">{r.short}</span>
                <span className="hidden sm:inline">{r.unit}</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Reading({ value, tone, active }: { value: string; tone?: 'bad'; active: boolean }) {
  const reduced = useReducedMotion()
  const cls = `font-mono text-[19px] font-medium tabular-nums leading-none tracking-[-0.01em] transition-colors duration-300 sm:text-[24px] ${
    tone === 'bad' ? 'text-rose-300' : active ? 'text-white' : 'text-zinc-300'
  }`

  if (reduced) {
    return (
      <span className="mt-2.5 flex h-[24px] items-center">
        <span className={cls}>{value}</span>
      </span>
    )
  }

  return (
    <span className="mt-2.5 flex h-[24px] items-center">
      <span className="relative inline-flex leading-none">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={value}
            initial={{ y: 6, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -6, opacity: 0, position: 'absolute' }}
            transition={{ duration: 0.26, ease: 'easeOut' }}
            className={cls}
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  )
}

/* ── Return arc ─────────────────────────────────────────────────────────── */

const ARC_H = 34
const ARC_R = 10
const crisp = (n: number) => Math.round(n) + 0.5

/**
 * Verify → Observe, drawn as a U beneath the rail so the five phases visibly
 * close into a circuit instead of reading as a pipeline.
 *
 * Measured rather than expressed in percentages: a percentage viewBox needs
 * preserveAspectRatio="none", which stretches the corner radii into ellipses
 * at wide viewports. Coordinates are snapped to the half-pixel grid so a 1px
 * stroke lands on one pixel column instead of antialiasing across two.
 */
function ReturnArc({ live }: { live: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width ?? 0
      if (next > 0) setW(next)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const x1 = crisp(w * 0.1)
  const x5 = crisp(w * 0.9)
  const yb = ARC_H - 0.5
  const d = w > 0
    ? `M ${x5} 0 V ${yb - ARC_R} A ${ARC_R} ${ARC_R} 0 0 1 ${x5 - ARC_R} ${yb} H ${x1 + ARC_R} A ${ARC_R} ${ARC_R} 0 0 1 ${x1} ${yb - ARC_R} V 0`
    : ''

  return (
    <div ref={ref} className="relative mt-5" style={{ height: ARC_H }}>
      {w > 0 && (
        <svg width={w} height={ARC_H} viewBox={`0 0 ${w} ${ARC_H}`} fill="none" className="absolute inset-0" aria-hidden="true">
          <path d={d} stroke="rgba(255,255,255,0.13)" strokeWidth={1} />
          {/* Arrowhead at the Observe end — the loop has a direction. */}
          <path
            d={`M ${x1 - 3.5} 7 L ${x1} 1.5 L ${x1 + 3.5} 7`}
            stroke="rgba(196,181,253,0.55)"
            strokeWidth={1.25}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {live && (
            <motion.path
              d={d}
              pathLength={100}
              strokeDasharray="16 84"
              stroke="rgba(196,181,253,0.8)"
              strokeWidth={1.25}
              strokeLinecap="round"
              animate={{ strokeDashoffset: [0, -100] }}
              transition={{ duration: 5.6, repeat: Infinity, ease: 'linear' }}
            />
          )}
        </svg>
      )}

      <span className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 whitespace-nowrap bg-[#0a0a0c] px-3 text-[10px] leading-none text-zinc-500">
        Verify feeds the next Observe
        <span className="hidden sm:inline">. No human at the top of the loop</span>
      </span>
    </div>
  )
}

/* ── Incident card + ledger ─────────────────────────────────────────────── */

function IncidentHeader({
  card, beat, reduced,
}: {
  card: ReturnType<typeof headline>
  beat: Beat
  reduced: boolean
}) {
  const dot =
    card.tone === 'bad' ? 'bg-rose-400/90'
      : card.tone === 'work' || card.tone === 'good' ? 'bg-violet-300'
      : 'bg-zinc-600'

  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/[0.05] px-5 py-3 sm:px-8">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {card.tone === 'good' ? (
            <Check className="h-3.5 w-3.5 text-violet-300" strokeWidth={2.5} />
          ) : (
            <span className={`h-[6px] w-[6px] rounded-full ${dot}`} />
          )}
        </span>
        <Swap k={beat} reduced={reduced} className="truncate text-[12px] font-medium text-zinc-200 sm:text-[13px]">
          <span className="sm:hidden">{card.short}</span>
          <span className="hidden sm:inline">{card.title}</span>
        </Swap>
      </div>
      <Swap
        k={card.status}
        reduced={reduced}
        className={`shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] ${
          card.statusTone === 'good' ? 'text-violet-300/80'
            : card.statusTone === 'bad' ? 'text-rose-300/70'
            : 'text-zinc-600'
        }`}
      >
        {card.status}
      </Swap>
    </div>
  )
}

/** One line swapped for another in place, without shifting its neighbours. */
function Swap({
  k, children, className = '', reduced,
}: {
  k: string
  children: React.ReactNode
  className?: string
  reduced: boolean
}) {
  if (reduced) return <span className={className}>{children}</span>
  return (
    <span className="relative inline-flex min-w-0">
      <AnimatePresence initial={false} mode="wait">
        <motion.span
          key={k}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          className={className}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

/**
 * The ledger writes a line per beat and holds all four through the closing
 * beat — the receipt is the point, so it is never cleared on screen.
 *
 * Unwritten lines are drawn, not hidden. Reserving their height and leaving it
 * blank gave the card a dead region for the first three seconds of every lap —
 * which is the exact "empty box where the proof should be" this whole frame
 * exists to remove. Drawn as an unwritten log line (`--:--`, dimmed tag, a rule
 * where the text will go), the same reserved height reads as a pass about to
 * run, and the card never changes size mid-loop.
 */
function Ledger({ step, reduced }: { step: number; reduced: boolean }) {
  return (
    <ul className="px-5 py-3 sm:px-8 sm:py-3.5">
      {LEDGER.map(row => {
        const written = reduced || step >= row.from
        return (
          <li key={row.tag} className="flex items-baseline gap-2.5 py-[3.5px] sm:gap-3.5">
            <span
              className={`shrink-0 font-mono text-[9.5px] tabular-nums transition-colors duration-500 ${
                written ? 'text-zinc-500' : 'text-zinc-700'
              }`}
            >
              {written ? row.at : '--:--'}
            </span>
            <span
              className={`w-[52px] shrink-0 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] transition-colors duration-500 sm:w-[58px] ${
                !written ? 'text-zinc-700'
                  : row.tag === 'Verified' ? 'text-violet-300/80'
                  : 'text-zinc-500'
              }`}
            >
              {row.tag}
            </span>
            {written ? (
              <span className="truncate text-[11px] leading-5 text-zinc-400 sm:text-[11.5px]">
                <span className="sm:hidden">{row.short}</span>
                <span className="hidden sm:inline">{row.text}</span>
              </span>
            ) : (
              <span aria-hidden className="h-px w-[34%] max-w-[210px] self-center bg-white/[0.05]" />
            )}
          </li>
        )
      })}
    </ul>
  )
}
