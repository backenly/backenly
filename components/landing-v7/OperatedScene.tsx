'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Database } from 'lucide-react'
import { AGENT_MARKS, AgentGlyph } from '@/components/landing/AgentMarks'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { BentoCell, CellBody, CellTitle, FIG, frameGate, whenIdle } from './shared'
import { BEATS, CYCLE, HOLD, beatAt, type Engine, type Mode } from './operated-engine'

/* ─────────────────────────────────────────────────────────────
   The card around the three.js scene in ./operated-engine, in the bento's
   system: a BentoCell whose CellTitle names the scene and whose CellBody is
   the narration, fact chips for the toggle, bento diagram chips pinned into
   the canvas, and a mono caption under it. three.js loads only when the card
   nears the viewport, renders only while it is on screen, and rests on a
   still frame when motion is reduced.
───────────────────────────────────────────────────────────── */

/** No favourite: the agent is any MCP host, shown as three of them in one tone. */
const AGENTS = ['claude', 'cursor', 'codex']
  .map((id) => AGENT_MARKS.find((m) => m.id === id))
  .filter((m): m is (typeof AGENT_MARKS)[number] => m !== undefined)

/** Which way a chip runs from its leader: centred over it, or as a flag running right or left. */
const ALIGN = {
  center: { box: 'items-center -translate-x-1/2', stem: '', dot: '' },
  start: { box: 'items-start -translate-x-[15px]', stem: 'ml-[14.5px]', dot: 'ml-[12px]' },
  end: { box: 'items-end translate-x-[calc(-100%+15px)]', stem: 'mr-[14.5px]', dot: 'mr-[12px]' },
} as const

/**
 * A label pinned to a point in the scene, drawn as a bento diagram chip on a
 * leader with an anchor dot (the dot's centre on the point). `accent` marks
 * what Backenly itself does, in the brand violet; everything else is grey.
 * `align` picks the side a chip runs to, so none covers a table's printed
 * name. The engine finds it by `data-chip`.
 */
function Callout({
  name,
  accent = false,
  align = 'center',
  children,
}: {
  name: string
  accent?: boolean
  align?: keyof typeof ALIGN
  children: ReactNode
}) {
  const a = ALIGN[align]
  return (
    <div data-chip={name} aria-hidden className="pointer-events-none absolute left-0 top-0 opacity-0 will-change-transform">
      <div className={`flex -translate-y-[calc(100%-3px)] flex-col ${a.box}`}>
        <span className={accent ? FIG.CHIP_BRIGHT : FIG.CHIP}>{children}</span>
        <span className={`h-[20px] w-px bg-white/[0.24] ${a.stem}`} />
        <span className={`h-[6px] w-[6px] rounded-full ring-2 ring-[#0b0b0e] ${accent ? 'bg-violet-300' : 'bg-zinc-400'} ${a.dot}`} />
      </div>
    </div>
  )
}

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
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const progressRef = useRef<HTMLSpanElement | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const quietRef = useRef(false)
  /** Set by the effect below; the toggle and the motion preference talk to the scene through it. */
  const actions = useRef<{ choose: (m: Mode) => void; setQuiet: (q: boolean) => void } | null>(null)

  useEffect(() => {
    quietRef.current = quiet
    actions.current?.setQuiet(quiet)
  }, [quiet])

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

    let disposed = false
    let booting = false
    let visible = false
    let raf = 0
    let pausedAt = 0

    const still = (m: Mode) => engineRef.current?.render(m, HOLD[m], performance.now(), true)

    const gate = frameGate()
    const loop = (now: number) => {
      raf = 0
      const engine = engineRef.current
      if (!engine || !visible || quietRef.current || disposed) return
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
      if (raf || !engineRef.current || !visible || quietRef.current || document.hidden) return
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
            <span aria-live="polite">{line}</span>
          </CellBody>
        </div>
        <div role="group" aria-label="Play the same problems on" className="flex shrink-0 gap-2">
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
                aria-label={label}
                title={label}
                onClick={() => actions.current?.choose(m)}
                className={`${FIG.FACT} ${on ? FIG.FACT_ON : FIG.FACT_OFF} group inline-flex h-[34px] w-[42px] items-center justify-center !p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300`}
              >
                {m === 'backenly' ? (
                  <BackenlyGlyph
                    className={`h-[17px] w-[17px] transition-[filter,opacity] duration-200 ${on ? '' : 'opacity-60 grayscale group-hover:opacity-90'}`}
                  />
                ) : (
                  <Database aria-hidden className="h-[17px] w-[17px]" strokeWidth={1.75} />
                )}
              </button>
            )
          })}
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
            <span className={`${FIG.MONO} ${FIG.TEXT}`}>check</span>
            <span className={FIG.TAG}>every minute</span>
          </Callout>
          <Callout name="latency" align="start">
            <span className={`${FIG.MONO} ${FIG.TEXT}`}>orders</span>
            <span className={`${FIG.MONO} ${FIG.BRIGHT}`}>1,840 ms</span>
            <span className={FIG.TAG}>avg</span>
          </Callout>
          <Callout name="detected" align="end" accent>
            <span className={`${FIG.MONO} ${FIG.TEXT}`}>slow_query_missing_index</span>
            <span className={FIG.TAG}>detected</span>
          </Callout>
          <Callout name="flagged" align="end">
            <span className={`${FIG.MONO} ${FIG.TEXT}`}>slow query</span>
            <span className={FIG.TAG}>flagged · waits</span>
          </Callout>
          <Callout name="fix" align="start" accent>
            <span className={`${FIG.MONO} ${FIG.BRIGHT}`}>idx_orders_customer_id</span>
            <span className={FIG.TAG}>on its own</span>
          </Callout>
          <Callout name="verified" align="start" accent>
            <span className={`${FIG.MONO} ${FIG.TEXT}`}>re-checked</span>
            <span className={FIG.TAG}>confirmed</span>
          </Callout>
          <Callout name="agent" align="end">
            <span className="flex -space-x-[4px]">
              {AGENTS.map((m) => (
                <span key={m.id} className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-white/[0.12] bg-[#141518]">
                  <AgentGlyph mark={m} className="h-[9px] w-[9px] text-zinc-300" />
                </span>
              ))}
            </span>
            <span className={`${FIG.MONO} ${FIG.TEXT}`}>your agent</span>
            <span className={`${FIG.TAG} hidden sm:inline`}>any mcp host</span>
          </Callout>
          <Callout name="packet" align="start">
            <span className={`${FIG.MONO} ${FIG.BRIGHT}`}>DROP TABLE carts;</span>
          </Callout>
          <Callout name="waits" align="start" accent>
            <span className={`${FIG.MONO} ${FIG.BRIGHT}`}>waits for you</span>
            <span className={`${FIG.TAG} hidden sm:inline`}>1,284 rows kept</span>
          </Callout>
          <Callout name="dropped">
            <span className={`${FIG.MONO} ${FIG.TEXT}`}>carts dropped</span>
            <span className={`${FIG.TAG} hidden sm:inline`}>1,284 rows gone</span>
          </Callout>
        </div>
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center p-[24px] text-center text-[14px] text-zinc-500">
            This animation needs WebGL. The line above tells the same story.
          </div>
        )}
      </div>

      <div className="relative flex items-center justify-between gap-4 border-t border-white/[0.06] px-6 py-3.5 md:px-8">
        {/* zinc-400, not the figures' muted grey: "illustrative" is the honesty note and must read at 4.5:1. */}
        <span className={`${FIG.MONO} text-zinc-400`}>
          {mode === 'backenly' ? 'backenly · checks every minute' : 'typical backend · flagged, not fixed'}
        </span>
        <span className={`${FIG.MONO} hidden text-zinc-400 sm:inline`}>example store · 5 tables · illustrative</span>
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
