'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AlertTriangle, AppWindow, Check, Clock, Code2, Database, FlaskConical, Lock, Receipt, RefreshCw, ShieldCheck, Undo2, type LucideIcon } from 'lucide-react'
import { AGENT_MARKS, AgentGlyph } from '@/components/landing/AgentMarks'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { BentoCell } from './shared'
import { IllustrativeNote, PlayPause } from './scene-ui'
import { createTimeline, type Timeline } from './art/timeline'
import type { Art, Sign, SignIcon } from './art/types'

/* ─────────────────────────────────────────────────────────────
   The card around a landing illustration (./art): a BentoCell whose top is
   the artwork, edge to edge, and whose foot is the hero's chapter rail
   (./HeroV7), one tab per step, each naming itself and saying what happens.
   It replaced the grey three.js scenes of the self-healing and
   restructuring sections (founders, 2026-10-27/28: "use colors rather than
   pencil work ... use icons and symbols", after InsForge's flowcharts).

   The art is vector, drawn once as markup (on the server too) in its story
   told state, and animated by Web Animations on one clock (./art/timeline),
   so nothing runs JavaScript per frame. Chips are upright HTML pinned to
   points in the art, each leading with a symbol, an agent's mark or a
   status; below 640px they hide and the rail's sentence carries the words.

   It plays once 35% of it is on screen, from its first beat, and stops when
   it leaves; a visitor's own pause is never overridden by scrolling back.
   Reduced motion rests on the story told, and a step shows that step's
   moment; the play control still plays it on request (WCAG 2.2.2: motion
   longer than five seconds can be paused). The art is decorative to a
   screen reader; the stage carries a description of what it shows.
───────────────────────────────────────────────────────────── */

const ICONS: Record<SignIcon, LucideIcon> = {
  clock: Clock,
  alert: AlertTriangle,
  check: Check,
  lock: Lock,
  shield: ShieldCheck,
  database: Database,
  receipt: Receipt,
  app: AppWindow,
  code: Code2,
  sync: RefreshCw,
  flask: FlaskConical,
  undo: Undo2,
}

const VIEW = { w: 1200, h: 560 }
const pct = (x: number, y: number) => ({ left: `${(x / VIEW.w) * 100}%`, top: `${(y / VIEW.h) * 100}%` })
const PLACE: Record<Sign['side'], string> = {
  above: '-translate-x-1/2 -translate-y-full',
  below: '-translate-x-1/2',
  left: '-translate-x-full -translate-y-1/2',
  right: '-translate-y-1/2',
}

function Chip({ sign }: { sign: Sign }) {
  const Icon = sign.icon ? ICONS[sign.icon] : null
  const marks = (sign.marks ?? []).map((id) => AGENT_MARKS.find((m) => m.id === id)).filter((m): m is (typeof AGENT_MARKS)[number] => !!m)
  return (
    <div aria-hidden className={`pointer-events-none absolute hidden sm:block ${PLACE[sign.side]}`} style={pct(...sign.at)}>
      <div
        data-a={sign.key}
        className="inline-flex h-[30px] items-center gap-[7px] whitespace-nowrap rounded-full border border-transparent bg-[#0c0c0f]/95 pl-[9px] pr-[12px] text-[12.5px] font-medium tracking-[-0.01em] text-zinc-100 shadow-[0_0_0_1px_rgba(255,255,255,0.13),0_1px_2px_rgba(0,0,0,0.5),0_10px_24px_-8px_rgba(0,0,0,0.75)]"
      >
        {sign.badge && (
          <span className="rounded-[5px] px-[6px] py-[2px] text-[11px] font-semibold leading-none" style={{ color: sign.tone, background: `${sign.tone}26` }}>
            {sign.badge}
          </span>
        )}
        {marks.length > 0 && (
          <span className="flex -space-x-[5px]">
            {marks.map((m) => (
              <span key={m.id} className="inline-flex h-[20px] w-[20px] items-center justify-center rounded-full border border-white/[0.14] bg-[#1d1f2a]">
                <AgentGlyph mark={m} className={`h-[11px] w-[11px] ${m.id === 'claude' ? 'text-[#d97757]' : 'text-zinc-100'}`} />
              </span>
            ))}
          </span>
        )}
        {Icon && <Icon aria-hidden strokeWidth={2.1} className="h-[14px] w-[14px] shrink-0" style={{ color: sign.tone }} />}
        {sign.label}
      </div>
    </div>
  )
}

function chapterAt(art: Art, t: number) {
  let index = 0
  art.chapters.forEach((c, i) => {
    if (t >= c.at) index = i
  })
  return index
}

export function FeatureArt({ make, note }: { make: (ns: string) => Art; note: string }) {
  const rawId = useId()
  const ns = rawId.replace(/[^a-zA-Z0-9]/g, '') + 'x'
  const art = useMemo(() => make(ns), [make, ns])
  const quiet = useSettledReducedMotion()
  /** The visitor's own play or pause; null until they use the control. */
  const [userPlay, setUserPlay] = useState<boolean | null>(null)
  const [chapter, setChapter] = useState(art.chapters.length - 1)
  const [manual, setManual] = useState(false)

  const autoplay = userPlay ?? !quiet
  const n = art.chapters.length
  const lit = chapter

  const stageRef = useRef<HTMLDivElement | null>(null)
  const timeline = useRef<Timeline | null>(null)
  const fillRef = useRef<HTMLSpanElement | null>(null)
  const fillAnim = useRef<Animation | null>(null)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const litRef = useRef(lit)
  const autoplayRef = useRef(autoplay)
  const quietRef = useRef(quiet)
  const visible = useRef(false)
  const shown = useRef(false)
  const boundary = useRef(0)
  /** The latest tick, for the timer that wakes it at the next step. */
  const tickRef = useRef<() => void>(() => {})

  /**
   * The lit hairline: its length now and, while the art plays, a linear run to the end of the step. At rest
   * under reduced motion it is drawn whole, as the hero's is; a visitor's own pause keeps it where it stopped.
   */
  const syncFill = useCallback(() => {
    const el = fillRef.current
    if (!el) return
    fillAnim.current?.cancel()
    fillAnim.current = null
    const tl = timeline.current
    const i = litRef.current
    const c = art.chapters[i]
    const end = art.chapters[i + 1]?.at ?? art.cycle
    const playing = !!tl?.playing()
    const t = tl ? tl.time() : art.still
    const f = !playing && (!tl || quietRef.current) ? 1 : Math.min(1, Math.max(0, (t - c.at) / (end - c.at)))
    el.style.transform = `scaleX(${f.toFixed(4)})`
    if (!playing || typeof el.animate !== 'function') return
    const ms = (end - t) * 1000
    if (ms > 16) fillAnim.current = el.animate([{ transform: `scaleX(${f.toFixed(4)})` }, { transform: 'scaleX(1)' }], { duration: ms, easing: 'linear', fill: 'forwards' })
  }, [art])

  /** Read the step from the art's clock, and wake again at the next step's start. */
  const tick = useCallback(() => {
    const tl = timeline.current
    window.clearTimeout(boundary.current)
    if (!tl) return
    const t = tl.time()
    const i = chapterAt(art, t)
    litRef.current = i
    setChapter(i)
    syncFill()
    if (tl.playing()) {
      const next = art.chapters[i + 1]?.at ?? art.cycle
      boundary.current = window.setTimeout(() => tickRef.current(), Math.max(30, (next - t) * 1000 + 30))
    }
  }, [art, syncFill])

  useEffect(() => {
    tickRef.current = tick
  }, [tick])

  const play = useCallback(() => {
    const tl = timeline.current
    if (!tl || tl.playing()) return
    if (!shown.current) {
      shown.current = true
      tl.seek(0)
    }
    tl.play()
    tick()
  }, [tick])

  const pause = useCallback(() => {
    const tl = timeline.current
    if (!tl) return
    tl.pause()
    window.clearTimeout(boundary.current)
    syncFill()
  }, [syncFill])

  useEffect(() => {
    litRef.current = lit
    syncFill()
  }, [lit, syncFill])

  // The clock, built once the stage is in the page.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const tl = createTimeline(stage, art.tracks, art.cycle)
    timeline.current = tl
    if (tl) tl.seek(art.still)

    const io = new IntersectionObserver(
      ([e]) => {
        visible.current = e.isIntersecting && e.intersectionRatio >= 0.34
        if (visible.current && autoplayRef.current && !document.hidden) play()
        else if (!visible.current) pause()
      },
      { threshold: [0, 0.35] },
    )
    io.observe(stage)
    const onVisibility = () => {
      if (document.hidden) pause()
      else if (visible.current && autoplayRef.current) play()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearTimeout(boundary.current)
      fillAnim.current?.cancel()
      tl?.dispose()
      timeline.current = null
    }
  }, [art, play, pause])

  // Autoplay on or off: the visitor's choice, or the motion preference.
  useEffect(() => {
    quietRef.current = quiet
    autoplayRef.current = autoplay
    if (!autoplay) pause()
    else if (visible.current && !document.hidden) play()
  }, [autoplay, quiet, play, pause])

  const choose = (i: number, focus = false) => {
    const c = art.chapters[i]
    const tl = timeline.current
    if (!c) return
    setManual(true)
    litRef.current = i
    setChapter(i)
    shown.current = true
    if (tl) {
      // Playing, the art carries on from the step's start; paused, it rests on the step's own moment.
      tl.seek(tl.playing() ? c.at : c.rest)
      tick()
    }
    if (focus) tabs.current[i]?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight') choose((lit + 1) % n, true)
    else if (e.key === 'ArrowLeft') choose((lit - 1 + n) % n, true)
    else if (e.key === 'Home') choose(0, true)
    else if (e.key === 'End') choose(n - 1, true)
    else return
    e.preventDefault()
  }

  const step = art.chapters[lit]
  const id = `${ns}-art`

  return (
    <BentoCell bare>
      <div role="tabpanel" id={`${id}-stage`} aria-labelledby={`${id}-step-${step.id}`}>
        <div ref={stageRef} className="relative aspect-[15/7] w-full select-none overflow-hidden">
          <svg aria-hidden viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} className="absolute inset-0 h-full w-full" dangerouslySetInnerHTML={{ __html: art.svg }} />
          {/* The chips' leaders, in the art's own units so they meet the points they name. */}
          <svg aria-hidden viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} className="pointer-events-none absolute inset-0 hidden h-full w-full sm:block">
            {art.signs.filter((s) => s.to).map((s) => (
              <g key={s.key} data-a={s.key}>
                <line x1={s.at[0]} y1={s.at[1]} x2={s.to![0]} y2={s.to![1]} stroke={s.tone} strokeOpacity={0.6} strokeWidth={1.3} />
                <circle cx={s.to![0]} cy={s.to![1]} r={3.6} fill={s.tone} stroke="#0c0c0f" strokeWidth={2} />
              </g>
            ))}
          </svg>
          {art.signs.map((s) => (
            <Chip key={s.key} sign={s} />
          ))}
          <div className="absolute right-3 top-3 sm:right-4 sm:top-4">
            <PlayPause
              paused={!autoplay}
              onToggle={() => {
                setManual(true)
                setUserPlay(!autoplay)
              }}
              className="!border-white/[0.14] !bg-[#0b0b0e]/80 !text-zinc-200 shadow-[0_1px_2px_rgba(0,0,0,0.5)]"
            />
          </div>
        </div>
        <p className="sr-only">{art.description}</p>
      </div>

      {/* The hero's chapter rail, one tab per step. */}
      <div className="px-6 pb-6 pt-5 md:px-8 md:pb-7 md:pt-6">
        <div role="tablist" aria-label={art.railLabel} className="grid grid-cols-5 gap-x-[6px] sm:gap-x-[16px] md:gap-x-[28px]">
          {art.chapters.map((c, i) => {
            const on = i === lit
            const played = i < lit
            return (
              <button
                key={c.id}
                id={`${id}-step-${c.id}`}
                ref={(el) => {
                  tabs.current[i] = el
                }}
                type="button"
                role="tab"
                aria-label={c.label}
                aria-describedby={`${id}-step-${c.id}-caption`}
                aria-selected={on}
                aria-controls={`${id}-stage`}
                tabIndex={on ? 0 : -1}
                onClick={() => choose(i)}
                onKeyDown={onKey}
                className="group relative flex min-w-0 flex-col justify-start rounded-[4px] pt-[18px] text-left [-webkit-tap-highlight-color:transparent] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-[6px] focus-visible:ring-offset-[#0b0c0e]"
              >
                {/* As the hero's rail (#571): one timeline, steps already played stay filled, the lit one fills while it plays. */}
                <span
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-px overflow-hidden bg-white/[0.1] transition-colors duration-200 [@media(hover:hover)_and_(pointer:fine)]:group-hover:bg-white/[0.2]"
                >
                  {played && <span className="block h-full bg-white/[0.32]" />}
                  {on && (
                    <span
                      ref={(el) => {
                        fillRef.current = el
                      }}
                      className="block h-full origin-left bg-white"
                      style={{ transform: 'scaleX(1)' }}
                    />
                  )}
                </span>
                <span
                  className={`block truncate text-[12px] font-medium tracking-[-0.011em] transition-colors duration-200 sm:text-[14px] md:text-[15px] ${
                    on ? 'text-white' : 'text-zinc-400/80 [@media(hover:hover)_and_(pointer:fine)]:group-hover:text-zinc-200'
                  }`}
                >
                  {c.label}
                </span>
                <span
                  id={`${id}-step-${c.id}-caption`}
                  className={`mt-[8px] hidden max-w-[34ch] text-[14px] leading-[1.5] tracking-[-0.006em] transition-colors duration-200 [text-wrap:pretty] lg:block ${
                    on ? 'text-zinc-300' : 'text-zinc-400/80 [@media(hover:hover)_and_(pointer:fine)]:group-hover:text-zinc-300'
                  }`}
                >
                  {c.caption}
                </span>
              </button>
            )
          })}
        </div>

        {/* Below lg the five names fit but five sentences do not: the lit step's sentence sits under them. */}
        <p
          aria-live={manual ? 'polite' : 'off'}
          className="mt-[14px] min-h-[44px] text-[14px] leading-[1.55] tracking-[-0.006em] text-zinc-300 lg:hidden"
        >
          {step.caption}
        </p>
        <IllustrativeNote className="mt-[14px] block !leading-[1.5] lg:mt-[22px]">{note}</IllustrativeNote>
      </div>
    </BentoCell>
  )
}
