'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { BentoCell, CellTitle, frameGate, whenIdle } from './shared'
import { Callout, ChipNote, ChipValue, IllustrativeNote, PlayPause } from './scene-ui'
import type { Engine } from './evolution-engine'
import { CHAPTERS, CYCLE, HOLD, chapterAt } from './evolution-story'

/* ─────────────────────────────────────────────────────────────
   The card around the three.js scene in ./evolution-engine. Two of the
   landing's own parts, put together:

     the stage   the self-healing card's (./OperatedScene): a BentoCell, the
                 scene's name, bento diagram chips pinned into the canvas, the
                 honesty note that it is an illustrative example store
     the rail    the hero's chapter rail (./HeroV7) under it: one tab per step,
                 each naming itself and saying what happens, the lit one's
                 hairline filling while it plays; below lg the lit step's
                 sentence sits under the five names, as in the hero

   A step can be chosen at any moment (click, or the arrow keys once a tab
   has focus); the story plays on from there. Autoplay longer than five
   seconds can be paused (WCAG 2.2.2); a paused or reduced-motion card rests
   on each step's own last frame. The sentence under the rail is announced
   only once the visitor has used a control, so the loop never talks over the
   page. The story starts from its first step the first time the card comes
   on screen.

   three.js and GSAP load only when the card nears the viewport (or while the
   visitor reads the hero), render only while it is on screen, and rest on a
   still frame when motion is reduced.
───────────────────────────────────────────────────────────── */

export function EvolutionScene() {
  const quiet = useSettledReducedMotion()
  const [chapter, setChapter] = useState(0)
  const [paused, setPaused] = useState(false)
  const [manual, setManual] = useState(false)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** The lit step's hairline fill; the loop writes its scale straight to the element. */
  const fillRef = useRef<HTMLSpanElement | null>(null)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const countRef = useRef<HTMLSpanElement | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const quietRef = useRef(false)
  /** The story time the loop last drew, so a newly lit hairline starts at the right length. */
  const timeRef = useRef(0)
  /** Set by the effect below; the controls and the motion preference talk to the scene through it. */
  const actions = useRef<{ jump: (i: number) => void; setPaused: (p: boolean) => void; setQuiet: (q: boolean) => void } | null>(null)

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
    /** Story time in seconds. It advances only while the card is on screen and playing. */
    const tRef = { current: 0 }
    const pausedRef = { current: false }
    const chapterRef = { current: 0 }

    let disposed = false
    let booting = false
    let visible = false
    let raf = 0
    let last = 0

    const sync = (t: number) => {
      timeRef.current = t
      const c = chapterAt(t)
      if (c !== chapterRef.current) {
        chapterRef.current = c
        setChapter(c)
      }
      const at = CHAPTERS[c].at
      const end = CHAPTERS[c + 1]?.at ?? CYCLE
      const f = quietRef.current ? 1 : Math.min(1, Math.max(0, (t - at) / (end - at)))
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${f.toFixed(4)})`
    }
    const still = (t: number) => {
      tRef.current = t
      engineRef.current?.render(t, performance.now(), true)
      sync(t)
    }

    const gate = frameGate()
    const loop = (now: number) => {
      raf = 0
      const engine = engineRef.current
      if (!engine || !visible || quietRef.current || pausedRef.current || disposed) return
      // A long gap (a dropped frame, a slow device) never jumps the story forward.
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (gate(now)) {
        let t = tRef.current + dt
        if (t >= CYCLE) t -= CYCLE
        tRef.current = t
        engine.render(t, now)
        sync(t)
      } else tRef.current = Math.min(CYCLE - 0.001, tRef.current + dt)
      raf = requestAnimationFrame(loop)
    }

    const start = () => {
      if (raf || !engineRef.current || !visible || quietRef.current || pausedRef.current || document.hidden) return
      last = performance.now()
      raf = requestAnimationFrame(loop)
    }
    const stop = () => {
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    actions.current = {
      jump(i) {
        const c = CHAPTERS[i]
        if (!c) return
        if (quietRef.current || pausedRef.current) still(c.rest)
        else {
          tRef.current = c.at
          sync(c.at)
        }
      },
      setPaused(p) {
        pausedRef.current = p
        if (p) {
          stop()
          still(tRef.current)
        } else start()
      },
      setQuiet(q) {
        if (!engineRef.current) return
        if (q) {
          stop()
          still(HOLD)
        } else start()
      },
    }

    async function boot() {
      booting = true
      try {
        const { createEngine } = await import('./evolution-engine')
        const engine = await createEngine(canvas as HTMLCanvasElement, wrap as HTMLElement, {
          chip: (key) => chips.get(key) ?? null,
          count: () => countRef.current,
          pointer: () => pointer.current,
        })
        if (disposed) {
          engine.dispose()
          return
        }
        engineRef.current = engine
        if (quietRef.current) still(HOLD)
        else {
          engine.render(tRef.current, performance.now())
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
    }, 3500)

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
      if (!raf) engine.render(tRef.current, performance.now(), quietRef.current || pausedRef.current)
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

  const choose = (i: number, focus = false) => {
    setManual(true)
    actions.current?.jump(i)
    if (focus) tabs.current[i]?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const n = CHAPTERS.length
    if (e.key === 'ArrowRight') choose((chapter + 1) % n, true)
    else if (e.key === 'ArrowLeft') choose((chapter - 1 + n) % n, true)
    else if (e.key === 'Home') choose(0, true)
    else if (e.key === 'End') choose(n - 1, true)
    else return
    e.preventDefault()
  }

  const lit = CHAPTERS[chapter]

  return (
    <BentoCell bare>
      <div className="flex items-center justify-between gap-4 px-6 pt-6 md:px-8 md:pt-8">
        <CellTitle>One table, two jobs</CellTitle>
        <div className="flex items-center gap-4">
          <IllustrativeNote className="hidden sm:inline">Illustrative example</IllustrativeNote>
          {!quiet && (
            <PlayPause
              paused={paused}
              onToggle={() => {
                setManual(true)
                setPaused(!paused)
                actions.current?.setPaused(!paused)
              }}
            />
          )}
        </div>
      </div>

      <div role="tabpanel" id="evolution-stage" aria-labelledby={`evolution-step-${lit.id}`}>
        <div
          ref={wrapRef}
          className="relative aspect-[2.3/1] min-h-[280px] w-full select-none"
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
            <Callout name="app" align="start">
              <ChipValue>your app</ChipValue>
              <ChipNote className="hidden sm:inline">uses orders</ChipNote>
            </Callout>
            <Callout name="concern" align="start" accent>
              <ChipValue bright>refund_*</ChipValue>
              <ChipNote>one job</ChipNote>
            </Callout>
            <Callout name="lock" align="start">
              <ChipValue bright>ALTER TABLE orders</ChipValue>
              <ChipNote>locks writes</ChipNote>
            </Callout>
            <Callout name="rehearsal" align="end" accent>
              <ChipValue>rehearsal</ChipValue>
              <ChipNote>rolled back</ChipNote>
            </Callout>
            <Callout name="waits" accent>
              <ChipValue bright>waits for you</ChipValue>
              <ChipNote className="hidden sm:inline">exact plan</ChipNote>
            </Callout>
            <Callout name="approved">
              <ChipValue bright>approved</ChipValue>
              <ChipNote>by you</ChipNote>
            </Callout>
            <Callout name="satellite" align="end" accent>
              <ChipValue bright>order_refunds</ChipValue>
              <ChipNote>created</ChipNote>
            </Callout>
            <Callout name="backfill" align="end" accent>
              <ChipValue bright className="tabular-nums">
                <span ref={countRef}>0</span> refunds
              </ChipValue>
              <ChipNote>copied</ChipNote>
            </Callout>
            <Callout name="verified" align="end" accent>
              <ChipValue>row for row</ChipValue>
              <ChipNote>match</ChipNote>
            </Callout>
            <Callout name="newcode" align="end">
              <ChipValue>new code</ChipValue>
              <ChipNote className="hidden sm:inline">uses order_refunds</ChipNote>
            </Callout>
            <Callout name="contract" align="end" below>
              <ChipValue>drop old columns</ChipValue>
              <ChipNote>your call</ChipNote>
            </Callout>
            {/* The same label for a phone's frame, where orders sits at the left edge: it runs right instead. */}
            <Callout name="contract-narrow" align="start" below>
              <ChipValue>drop old columns</ChipValue>
              <ChipNote>your call</ChipNote>
            </Callout>
          </div>
          {failed && (
            <div className="absolute inset-0 flex items-center justify-center p-[24px] text-center text-[14px] text-zinc-500">
              This animation needs WebGL. The steps below tell the same story.
            </div>
          )}
        </div>

        <p className="sr-only">
          An animation of one store backend. Your app keeps writing to the orders table the whole time. Backenly
          notices that the refund columns on orders, refund_amount, refund_reason and refunded_at, behave as one job of
          their own, and that every change to them has locked orders while it was in use. It rehearses moving them on a
          copy of orders and rolls the copy back, then waits for you to approve that exact plan. Once you approve,
          Backenly creates an order_refunds table, mirrors every write to orders into it, copies the existing refunds
          across in small batches and checks that both tables match, row for row. Then order_refunds opens to your
          apps: old code keeps using orders, new code can use order_refunds, and writes flow both ways. The old columns
          stay on orders until you decide to drop them, and undo stays available.
        </p>
      </div>

      {/* The hero's chapter rail, one tab per step. */}
      <div className="px-6 pb-6 pt-1 md:px-8 md:pb-8">
        <div
          role="tablist"
          aria-label="The change, step by step"
          className="grid grid-cols-5 gap-x-[6px] sm:gap-x-[16px] md:gap-x-[28px]"
        >
          {CHAPTERS.map((c, i) => {
            const on = i === chapter
            return (
              <button
                key={c.id}
                id={`evolution-step-${c.id}`}
                ref={(el) => {
                  tabs.current[i] = el
                }}
                type="button"
                role="tab"
                aria-label={c.label}
                aria-describedby={`evolution-step-${c.id}-caption`}
                aria-selected={on}
                aria-controls="evolution-stage"
                tabIndex={on ? 0 : -1}
                onClick={() => choose(i)}
                onKeyDown={onKey}
                className="group relative flex min-w-0 flex-col justify-start rounded-[4px] pt-[16px] text-left [-webkit-tap-highlight-color:transparent] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-[6px] focus-visible:ring-offset-[#0b0c0e]"
              >
                <span
                  aria-hidden
                  className={`absolute inset-x-0 top-0 h-px overflow-hidden transition-colors duration-200 ${
                    on ? 'bg-white/[0.16]' : 'bg-white/[0.08] [@media(hover:hover)_and_(pointer:fine)]:group-hover:bg-white/[0.16]'
                  }`}
                >
                  {on && (
                    <span
                      ref={(el) => {
                        fillRef.current = el
                        if (el) {
                          // A newly lit step starts at the length the story has already played of it.
                          const end = CHAPTERS[i + 1]?.at ?? CYCLE
                          const f = quiet ? 1 : Math.min(1, Math.max(0, (timeRef.current - c.at) / (end - c.at)))
                          el.style.transform = `scaleX(${f.toFixed(4)})`
                        }
                      }}
                      className="block h-full origin-left bg-white/80"
                    />
                  )}
                </span>
                <span
                  className={`block truncate text-[12px] font-medium tracking-[-0.01em] transition-colors duration-200 sm:text-[14px] md:text-[15px] ${
                    on ? 'text-zinc-50' : 'text-zinc-400 [@media(hover:hover)_and_(pointer:fine)]:group-hover:text-zinc-200'
                  }`}
                >
                  {c.label}
                </span>
                <span
                  id={`evolution-step-${c.id}-caption`}
                  className={`mt-[6px] hidden text-[13.5px] leading-[1.55] tracking-[-0.004em] transition-colors duration-200 [text-wrap:pretty] lg:block ${
                    on ? 'text-zinc-300' : 'text-zinc-400 [@media(hover:hover)_and_(pointer:fine)]:group-hover:text-zinc-300'
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
          className="mt-[14px] min-h-[44px] text-[14px] leading-[1.55] tracking-[-0.006em] text-zinc-400 lg:hidden"
        >
          {lit.caption}
        </p>
      </div>
    </BentoCell>
  )
}
