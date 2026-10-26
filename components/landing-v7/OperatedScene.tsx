'use client'

import { useEffect, useRef, useState } from 'react'
import { Database } from 'lucide-react'
import { AGENT_MARKS, AgentGlyph } from '@/components/landing/AgentMarks'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { BentoCell, CellBody, CellTitle, frameGate, whenIdle } from './shared'
import { Callout, ChipNote, ChipValue, EASE, IllustrativeNote, PlayPause } from './scene-ui'
import { BEATS, CYCLE, HOLD, beatAt, type Engine, type Mode } from './operated-engine'

/* ─────────────────────────────────────────────────────────────
   The card around the three.js scene in ./operated-engine, in the bento's
   system: a BentoCell whose CellTitle names the scene and whose CellBody is
   the narration, a segmented control for the comparison, chips pinned into
   the canvas (./scene-ui, shared with the restructuring and regions cards),
   and a caption under it. three.js loads only when the card nears the
   viewport, renders only while it is on screen, and rests on a still frame
   when motion is reduced.

   2026-10-26 polish, against the installed design skills: the two icon-only
   buttons became a segmented control that says what each side is, with a
   thumb that slides to the choice; autoplay can be paused (WCAG 2.2.2); the
   story starts from its first beat the first time the card is seen; the
   narration settles in and is announced only after a control is used; chip
   notes and the caption are words in the text face, not tracked uppercase
   tags or mono labels.
───────────────────────────────────────────────────────────── */

/** No favourite: the agent is any MCP host, shown as three of them in one tone. */
const AGENTS = ['claude', 'cursor', 'codex']
  .map((id) => AGENT_MARKS.find((m) => m.id === id))
  .filter((m): m is (typeof AGENT_MARKS)[number] => m !== undefined)

/**
 * The Backenly mark from /backenly-icon-hd.svg without its app-icon tile, so
 * it sits in a toggle at the size of the icon beside it instead of as a dark
 * square inside the button.
 */
function BackenlyGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="6 6 20 20" aria-hidden className={className}>
      <rect x="8" y="20" width="16" height="3" rx="1" fill="#8B5CF6" />
      <rect x="8" y="14.5" width="16" height="3" rx="1" fill="#A78BFA" />
      <rect x="8" y="9" width="16" height="3" rx="1" fill="#fff" fillOpacity="0.9" />
      <path d="M12 12v2.5M16 12v2.5M20 12v2.5M12 17.5V20M16 17.5V20M20 17.5V20" stroke="#8B5CF6" strokeOpacity="0.6" />
    </svg>
  )
}

export function OperatedScene() {
  const quiet = useSettledReducedMotion()
  const [mode, setMode] = useState<Mode>('backenly')
  const [beat, setBeat] = useState(0)
  const [paused, setPaused] = useState(false)
  /** Narration is announced only once the visitor has used a control, so the loop never talks over the page. */
  const [announce, setAnnounce] = useState(false)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const progressRef = useRef<HTMLSpanElement | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const quietRef = useRef(false)
  const lineRef = useRef<HTMLSpanElement | null>(null)
  /** Set by the effect below; the toggle, the pause control and the motion preference talk to the scene through it. */
  const actions = useRef<{ choose: (m: Mode) => void; setPaused: (p: boolean) => void; setQuiet: (q: boolean) => void } | null>(null)

  useEffect(() => {
    quietRef.current = quiet
    actions.current?.setQuiet(quiet)
  }, [quiet])

  // The narration settles in rather than snapping, unless motion is reduced.
  useEffect(() => {
    if (quietRef.current) return
    lineRef.current?.animate?.([{ opacity: 0.2 }, { opacity: 1 }], { duration: 320, easing: EASE.out })
  }, [beat, mode])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const chips = new Map<string, HTMLElement>()
    wrap.querySelectorAll<HTMLElement>('[data-chip]').forEach((el) => chips.set(el.dataset.chip ?? '', el))

    const engineRef: { current: Engine | null } = { current: null }
    const modeRef: { current: Mode } = { current: 'backenly' }
    const autoRef = { current: true }
    const startRef = { current: 0 }
    const beatRef = { current: 0 }
    const pausedRef = { current: false }

    let disposed = false
    /** The story starts from its first beat the first time the card is on screen, not wherever the clock got to. */
    let shown = false
    let booting = false
    let visible = false
    let raf = 0
    let pausedAt = 0

    const still = (m: Mode) => engineRef.current?.render(m, HOLD[m], performance.now(), true)

    const gate = frameGate()
    const loop = (now: number) => {
      raf = 0
      const engine = engineRef.current
      if (!engine || !visible || quietRef.current || pausedRef.current || disposed) return
      if (!gate(now)) {
        raf = requestAnimationFrame(loop)
        return
      }
      let t = (now - startRef.current) / 1000
      if (t >= CYCLE[modeRef.current]) {
        const next: Mode = autoRef.current ? (modeRef.current === 'backenly' ? 'typical' : 'backenly') : modeRef.current
        modeRef.current = next
        startRef.current = now
        t = 0
        setMode(next)
      }
      engine.render(modeRef.current, t, now)
      const b = beatAt(modeRef.current, t)
      if (b !== beatRef.current) {
        beatRef.current = b
        setBeat(b)
      }
      raf = requestAnimationFrame(loop)
    }

    const start = () => {
      if (raf || !engineRef.current || !visible || quietRef.current || pausedRef.current || document.hidden) return
      if (!shown) {
        shown = true
        startRef.current = performance.now()
        pausedAt = 0
      }
      if (pausedAt) {
        startRef.current += performance.now() - pausedAt
        pausedAt = 0
      }
      raf = requestAnimationFrame(loop)
    }
    const stop = () => {
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
        pausedAt = performance.now()
      }
    }
    actions.current = {
      choose(m) {
        autoRef.current = false
        modeRef.current = m
        startRef.current = performance.now()
        beatRef.current = quietRef.current ? BEATS[m].length - 1 : 0
        setBeat(beatRef.current)
        setMode(m)
        if (quietRef.current) still(m)
        else if (pausedRef.current) engineRef.current?.render(m, 0, performance.now())
      },
      setPaused(p) {
        pausedRef.current = p
        if (p) stop()
        else start()
      },
      setQuiet(q) {
        if (!engineRef.current) return
        if (q) {
          stop()
          beatRef.current = BEATS[modeRef.current].length - 1
          setBeat(beatRef.current)
          still(modeRef.current)
        } else {
          startRef.current = performance.now()
          start()
        }
      },
    }

    async function boot() {
      booting = true
      try {
        const { createEngine } = await import('./operated-engine')
        const engine = await createEngine(canvas as HTMLCanvasElement, wrap as HTMLElement, {
          chip: (key) => chips.get(key) ?? null,
          progress: () => progressRef.current,
          pointer: () => pointer.current,
        })
        if (disposed) {
          engine.dispose()
          return
        }
        engineRef.current = engine
        startRef.current = performance.now()
        if (quietRef.current) {
          beatRef.current = BEATS[modeRef.current].length - 1
          setBeat(beatRef.current)
          engine.render(modeRef.current, HOLD[modeRef.current], performance.now(), true)
        } else {
          engine.render(modeRef.current, 0, performance.now())
          start()
        }
        setReady(true)
      } catch {
        setFailed(true)
      }
    }

    // Boot while the visitor reads the hero, so three.js never loads mid-scroll;
    // the observer below still boots it if someone gets here first.
    const cancelIdle = whenIdle(() => {
      if (!engineRef.current && !booting && !disposed) void boot()
    })

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting
        if (visible && !engineRef.current && !booting) void boot()
        if (visible) start()
        else stop()
      },
      // Draw only while the canvas is actually on screen.
      { rootMargin: '0px' },
    )
    io.observe(wrap)
    // If someone scrolls here before the idle boot ran, start loading early.
    const near = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !engineRef.current && !booting && !disposed) void boot()
      },
      { rootMargin: '600px 0px' },
    )
    near.observe(wrap)

    const ro = new ResizeObserver(() => {
      const engine = engineRef.current
      if (!engine) return
      engine.resize()
      if (quietRef.current) engine.render(modeRef.current, HOLD[modeRef.current], performance.now(), true)
    })
    ro.observe(wrap)

    const onVisibility = () => (document.hidden ? stop() : start())
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      stop()
      cancelIdle()
      io.disconnect()
      near.disconnect()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      actions.current = null
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [])

  const beats = BEATS[mode]
  const line = beats[Math.min(beat, beats.length - 1)]?.text ?? ''

  return (
    <BentoCell bare>
      <div className="flex flex-col gap-5 p-6 md:flex-row md:items-start md:justify-between md:gap-10 md:p-8">
        <div className="min-w-0">
          <CellTitle>Same problems, two backends</CellTitle>
          <CellBody className="min-h-[51px]">
            <span ref={lineRef} aria-live={announce ? 'polite' : 'off'} className="inline-block">
              {line}
            </span>
          </CellBody>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* A segmented control with words, not two unlabelled icons: the comparison is the card's point. */}
          <div
            role="group"
            aria-label="Play the same problems on"
            className="relative grid h-[34px] grid-cols-2 rounded-[9px] border border-white/[0.08] bg-white/[0.03] p-[3px]"
          >
            <span
              aria-hidden
              className="absolute inset-y-[3px] left-[3px] w-[calc(50%-3px)] rounded-[6px] border border-transparent bg-white/[0.09] shadow-[0_0_0_1px_rgba(255,255,255,0.10),0_1px_2px_rgba(0,0,0,0.45)] transition-transform duration-300 motion-reduce:transition-none"
              style={{ transform: mode === 'backenly' ? 'translateX(100%)' : 'translateX(0)', transitionTimingFunction: EASE.out }}
            />
            {(
              [
                ['typical', 'Typical backend'],
                ['backenly', 'Backenly'],
              ] as const
            ).map(([m, label]) => {
              const on = mode === m
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setAnnounce(true)
                    actions.current?.choose(m)
                  }}
                  className={`relative z-10 inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[6px] px-3 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-150 [-webkit-tap-highlight-color:transparent] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${
                    on ? 'text-zinc-50' : 'text-zinc-400 [@media(hover:hover)_and_(pointer:fine)]:hover:text-zinc-200'
                  }`}
                >
                  {m === 'backenly' ? (
                    <BackenlyGlyph className={`h-[15px] w-[15px] transition-[filter,opacity] duration-150 ${on ? '' : 'opacity-60 grayscale'}`} />
                  ) : (
                    <Database aria-hidden className="h-[14px] w-[14px]" strokeWidth={2} />
                  )}
                  {label}
                </button>
              )
            })}
          </div>
          {!quiet && (
            <PlayPause
              paused={paused}
              onToggle={() => {
                setAnnounce(true)
                setPaused(!paused)
                actions.current?.setPaused(!paused)
              }}
            />
          )}
        </div>
      </div>

      <div
        ref={wrapRef}
        className="relative h-[320px] select-none sm:h-[420px] md:h-[480px] lg:h-[520px]"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          pointer.current = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: ((e.clientY - r.top) / r.height) * 2 - 1 }
        }}
        onPointerLeave={() => {
          pointer.current = { x: 0, y: 0 }
        }}
      >
        <canvas
          ref={canvasRef}
          aria-hidden
          className={`absolute inset-0 h-full w-full transition-opacity duration-700 ${ready ? 'opacity-100' : 'opacity-0'}`}
        />

        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <Callout name="scan" accent>
            <ChipValue>check</ChipValue>
            <ChipNote>every minute</ChipNote>
          </Callout>
          <Callout name="latency" align="start">
            <ChipValue>orders</ChipValue>
            <ChipValue bright>1,840 ms</ChipValue>
            <ChipNote>average</ChipNote>
          </Callout>
          <Callout name="detected" align="end" accent>
            <ChipValue>slow_query_missing_index</ChipValue>
            <ChipNote>found</ChipNote>
          </Callout>
          <Callout name="flagged" align="end">
            <ChipValue>slow query</ChipValue>
            <ChipNote>flagged, waiting</ChipNote>
          </Callout>
          <Callout name="fix" align="start" accent>
            <ChipValue bright>idx_orders_customer_id</ChipValue>
            <ChipNote>added on its own</ChipNote>
          </Callout>
          <Callout name="verified" align="start" accent>
            <ChipValue>re-checked</ChipValue>
            <ChipNote>confirmed</ChipNote>
          </Callout>
          <Callout name="agent" align="end">
            <span className="flex -space-x-[4px]">
              {AGENTS.map((m) => (
                <span key={m.id} className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-white/[0.12] bg-[#141518]">
                  <AgentGlyph mark={m} className="h-[9px] w-[9px] text-zinc-300" />
                </span>
              ))}
            </span>
            <ChipValue>your agent</ChipValue>
            <ChipNote className="hidden sm:inline">any MCP host</ChipNote>
          </Callout>
          <Callout name="packet" align="start">
            <ChipValue bright>DROP TABLE carts;</ChipValue>
          </Callout>
          <Callout name="waits" align="start" accent>
            <ChipValue bright>waits for you</ChipValue>
            <ChipNote className="hidden sm:inline">1,284 rows kept</ChipNote>
          </Callout>
          <Callout name="dropped">
            <ChipValue>carts dropped</ChipValue>
            <ChipNote className="hidden sm:inline">1,284 rows gone</ChipNote>
          </Callout>
        </div>
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center p-[24px] text-center text-[14px] text-zinc-500">
            This animation needs WebGL. The line above tells the same story.
          </div>
        )}
      </div>

      <div className="relative flex items-center justify-between gap-4 border-t border-white/[0.06] px-6 py-3.5 md:px-8">
        <IllustrativeNote>
          {mode === 'backenly' ? 'Backenly checks every minute' : 'A typical backend flags it, then waits'}
        </IllustrativeNote>
        <IllustrativeNote className="hidden sm:inline">Illustrative example, 5 tables</IllustrativeNote>
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-white/[0.05]">
          <span ref={progressRef} className="block h-full origin-left scale-x-0 bg-white/30" />
        </span>
      </div>

      <p className="sr-only">
        An animation of one store backend, played twice. On a typical backend, a slow query on the orders table is
        flagged and waits for someone to fix it, and your agent&apos;s DROP TABLE carts runs as sent. On Backenly, the
        next check finds the missing index on orders.customer_id, Backenly adds it on its own and re-runs the check to
        confirm the fix, and dropping the carts table waits for your approval.
      </p>
    </BentoCell>
  )
}
