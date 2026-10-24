'use client'

import { useEffect, useRef, useState } from 'react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { REGIONS, type Globe } from './globe-engine'
import { BentoCell, CellBody, CellTitle, CONTAINER, FIG, frameGate, SECTION, SECTION_BODY_GAP, SECTION_TITLE, whenIdle } from './shared'

/* ─────────────────────────────────────────────────────────────
   Regions, in the bento's system (./shared): the same two-tone title, no
   eyebrow, and one BentoCell holding a CellTitle and CellBody, the regions as
   fact chips, and the globe (./globe-engine) rising out of the cell's bottom
   edge, Appwrite's composition. Labels on the globe are bento diagram chips.
   The globe rolls west from region to region; a chip focuses its region.
   All five are live (founders, 2026-10-14: "all are live"), so none carries
   a tag: every region has the violet dot, and a region added before it opens
   sets `live: false` in ./globe-engine to draw a hollow ring. Like Appwrite's "The Appwrite Network", the regions are named as
   Backenly's own places, never by the cloud vendor's codes. Nothing from
   Appwrite's feature line (global CDN, DDoS protection, sub-50ms latency) is
   claimed: Backenly Cloud has no CDN or edge network to back it.
───────────────────────────────────────────────────────────── */

export function RegionsV7() {
  const quiet = useSettledReducedMotion()
  const [focus, setFocus] = useState(REGIONS[0].id)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const quietRef = useRef(false)
  const actions = useRef<{ focus: (id: string) => void; setQuiet: (q: boolean) => void } | null>(null)

  useEffect(() => {
    quietRef.current = quiet
    actions.current?.setQuiet(quiet)
  }, [quiet])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const labels = new Map<string, HTMLElement>()
    wrap.querySelectorAll<HTMLElement>('[data-region]').forEach((el) => labels.set(el.dataset.region ?? '', el))

    let globe: Globe | null = null
    let disposed = false
    let booting = false
    let visible = false
    let raf = 0

    const gate = frameGate()
    const loop = (now: number) => {
      raf = 0
      if (!globe || !visible || quietRef.current || disposed) return
      if (gate(now)) globe.render(now)
      raf = requestAnimationFrame(loop)
    }
    const start = () => {
      if (raf || !globe || !visible || quietRef.current || document.hidden) return
      raf = requestAnimationFrame(loop)
    }
    const stop = () => {
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    actions.current = {
      focus(id) {
        globe?.focus(id)
        if (quietRef.current) globe?.render(performance.now(), true)
      },
      setQuiet(q) {
        if (!globe) return
        if (q) {
          stop()
          globe.render(performance.now(), true)
        } else start()
      },
    }

    async function boot() {
      booting = true
      try {
        const { createGlobe } = await import('./globe-engine')
        const created = await createGlobe(canvas as HTMLCanvasElement, wrap as HTMLElement, {
          label: (id) => labels.get(id) ?? null,
          onFocus: (id) => setFocus(id),
        })
        if (disposed) {
          created.dispose()
          return
        }
        globe = created
        if (quietRef.current) created.render(performance.now(), true)
        else start()
        setReady(true)
      } catch {
        setFailed(true)
      }
    }

    // Boot while the visitor reads the hero, so the globe never loads mid-scroll;
    // the observer below still boots it if someone gets here first.
    const cancelIdle = whenIdle(() => {
      if (!globe && !booting && !disposed) void boot()
    }, 4000)

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting
        if (visible && !globe && !booting) void boot()
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
        if (entry.isIntersecting && !globe && !booting && !disposed) void boot()
      },
      { rootMargin: '600px 0px' },
    )
    near.observe(wrap)

    const ro = new ResizeObserver(() => {
      if (!globe) return
      globe.resize()
      if (quietRef.current) globe.render(performance.now(), true)
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
      globe?.dispose()
    }
  }, [])

  return (
    <section id="regions" aria-labelledby="regions-heading" className={`${SECTION} scroll-mt-[92px] font-light`}>
      <div className={CONTAINER}>
        <div>
          <h2 id="regions-heading" className={SECTION_TITLE}>
            Run close to your users.{' '}
            <span className="text-zinc-500">Five regions across three continents.</span>
          </h2>
        </div>

        <div className={SECTION_BODY_GAP}>
          <BentoCell bare>
            <div className="flex flex-col gap-5 p-6 md:flex-row md:items-start md:justify-between md:gap-10 md:p-8">
              <div className="min-w-0">
                <CellTitle>Backenly Cloud regions</CellTitle>
                <CellBody>
                  Backenly Cloud runs in Mumbai, Frankfurt, US East, US West and Singapore. Self-hosted, Backenly
                  runs wherever your servers do.
                </CellBody>
              </div>
              <ul aria-label="Regions" className="flex max-w-[460px] flex-wrap gap-2 md:justify-end lg:max-w-none lg:flex-nowrap">
                {REGIONS.map((r) => {
                  const on = focus === r.id
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => actions.current?.focus(r.id)}
                        className={`${FIG.FACT} ${on ? FIG.FACT_ON : FIG.FACT_OFF} inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300`}
                      >
                        <span
                          aria-hidden
                          className={r.live ? 'h-[6px] w-[6px] rounded-full bg-violet-300' : 'h-[6px] w-[6px] rounded-full border border-zinc-400'}
                        />
                        {r.name}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>

            <div ref={wrapRef} className="relative h-[250px] w-full select-none sm:h-[360px] md:h-[440px] lg:h-[500px]">
              <canvas
                ref={canvasRef}
                aria-hidden
                className={`absolute inset-0 h-full w-full transition-opacity duration-1000 ${ready ? 'opacity-100' : 'opacity-0'}`}
              />
              <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
                {REGIONS.map((r) => (
                  <div key={r.id} data-region={r.id} className="group absolute left-0 top-0 opacity-0 will-change-transform">
                    <div className="flex -translate-x-1/2 -translate-y-[calc(100%+2px)] flex-col items-center">
                      <span className={`${FIG.CHIP} transition-colors duration-300 group-data-[focus=true]:border-white/[0.18]`}>
                        <span
                          aria-hidden
                          className={r.live ? 'h-[6px] w-[6px] rounded-full bg-violet-300' : 'h-[6px] w-[6px] rounded-full border border-zinc-400'}
                        />
                        <span className={`${FIG.MONO} ${FIG.TEXT} transition-colors duration-300 group-data-[focus=true]:text-zinc-100`}>{r.name}</span>
                      </span>
                      <span className="h-[14px] w-px bg-white/[0.24]" />
                    </div>
                  </div>
                ))}
              </div>

              {failed && (
                <p className="absolute inset-x-0 bottom-[40%] text-center text-[14px] text-zinc-500">
                  Mumbai, Frankfurt, US East, US West and Singapore.
                </p>
              )}
            </div>
          </BentoCell>
        </div>
      </div>
    </section>
  )
}
