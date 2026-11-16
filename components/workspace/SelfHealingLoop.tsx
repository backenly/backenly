'use client'

/**
 * The self-healing loop on Overview, drawn as an instrument instead of a
 * poster. Four stages on one hairline, and a return path back to the start:
 *
 *      ●──────────────●──────────────●──────────────●
 *    Check          Find            Fix          Re-check
 *    27 checks      1 open          2 in 30 days  2 of 2
 *   ╰──────────────────── Every minute ─────────────────────╯
 *
 * The motion is telemetry, not theatre. Once a minute, aligned to the loop's
 * real last pass, one violet trace draws from Check to Re-check, lighting each
 * stage as it reaches it, then returns along the lower path and fades. Nothing
 * else moves: no comet circling a border, no glow, no pulsing tiles. A stale
 * loop, a loop that is off, a hidden tab and reduced motion all hold still.
 * Below 560px the same loop stands upright.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { LOOP_PERIOD_MS, loopFraction, reducedMotion } from '@/components/console/LoopMark'

export interface LoopStage {
  key: string
  label: string
  value: ReactNode
  /** Needs a person: the value is white. */
  attention?: boolean
  /** Not running here (a deployment that doesn't apply repairs): dashed node, grey value. */
  dim?: boolean
}

const VIOLET = '#a78bfa'
const HEAD = '#ddd6fe'
const SURFACE = '#0f1012'
const NODE_STROKE = 'rgba(255,255,255,0.34)'
const LIT = '#fafafa'
const LABEL = '#a1a1aa'
const LABEL_LIT = '#f4f4f5'

const FWD_MS = 1500
const BACK_MS = 1100
const FADE_MS = 700
const LIT_MS = 900

interface Geo {
  w: number
  h: number
  vertical: boolean
  nodes: Array<{ x: number; y: number }>
  forward: string
  back: string
  caption: { x: number; y: number } | null
}

function geometry(w: number): Geo {
  if (w >= 560) {
    const y = 9
    const xs = [0, 1, 2, 3].map((i) => (w * (2 * i + 1)) / 8)
    const e = Math.min(64, xs[0] - 8)
    const xL = xs[0] - e
    const xR = xs[3] + e
    const ry = 96
    const r = 12
    return {
      w,
      h: ry + 2,
      vertical: false,
      nodes: xs.map((x) => ({ x, y })),
      forward: `M ${xs[0]} ${y} H ${xs[3]}`,
      back:
        `M ${xs[3]} ${y} H ${xR - r} A ${r} ${r} 0 0 1 ${xR} ${y + r} V ${ry - r} A ${r} ${r} 0 0 1 ${xR - r} ${ry} ` +
        `H ${xL + r} A ${r} ${r} 0 0 1 ${xL} ${ry - r} V ${y + r} A ${r} ${r} 0 0 1 ${xL + r} ${y} H ${xs[0]}`,
      caption: { x: w / 2, y: ry },
    }
  }
  const x = 27
  const ys = [0, 1, 2, 3].map((i) => 13 + i * 50)
  const xL = 9
  const r = 8
  return {
    w,
    h: ys[3] + 13,
    vertical: true,
    nodes: ys.map((y) => ({ x, y })),
    forward: `M ${x} ${ys[0]} V ${ys[3]}`,
    back: `M ${x} ${ys[3]} H ${xL + r} A ${r} ${r} 0 0 1 ${xL} ${ys[3] - r} V ${ys[0] + r} A ${r} ${r} 0 0 1 ${xL + r} ${ys[0]} H ${x}`,
    caption: null,
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOutIn = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2

export function SelfHealingLoop({
  stages,
  lastPassAt,
  animate,
}: {
  /** Exactly four: Check, Find, Fix, Re-check. */
  stages: LoopStage[]
  lastPassAt: string | null
  /** Off, stale or not yet run: the loop is drawn but holds still. */
  animate: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const geo = w > 0 ? geometry(w) : null

  const fwd = useRef<SVGPathElement>(null)
  const back = useRef<SVGPathElement>(null)
  const trace = useRef<SVGGElement>(null)
  const head = useRef<SVGCircleElement>(null)
  const nodeEls = useRef<Array<SVGCircleElement | null>>([])
  const labelEls = useRef<Array<HTMLSpanElement | null>>([])
  const raf = useRef(0)
  const running = useRef(false)
  const visible = useRef(true)
  const unlight = useRef<number[]>([])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    setW(Math.round(el.getBoundingClientRect().width))
    // Both observers are optional: without them the loop keeps its first width and always counts as on screen.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(([entry]) => setW(Math.round(entry.contentRect.width)))
    ro?.observe(el)
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => {
            visible.current = entry.isIntersecting
          })
    io?.observe(el)
    return () => {
      ro?.disconnect()
      io?.disconnect()
    }
  }, [])

  const light = useCallback((i: number) => {
    const node = nodeEls.current[i]
    const label = labelEls.current[i]
    if (node) {
      node.style.fill = LIT
      node.style.stroke = LIT
    }
    if (label) label.style.color = LABEL_LIT
    unlight.current.push(
      window.setTimeout(() => {
        if (node) {
          node.style.fill = ''
          node.style.stroke = ''
        }
        if (label) label.style.color = ''
      }, LIT_MS),
    )
  }, [])

  const runPass = useCallback(() => {
    const f = fwd.current
    const b = back.current
    const g = trace.current
    const h = head.current
    if (running.current || !f || !b || !g || !h || typeof f.getTotalLength !== 'function') return
    running.current = true
    const fl = f.getTotalLength()
    const bl = b.getTotalLength()
    const lit = [false, false, false, false]
    let closed = false
    const place = (p: DOMPoint) => {
      h.setAttribute('cx', String(p.x))
      h.setAttribute('cy', String(p.y))
    }
    f.style.strokeDashoffset = '1'
    b.style.strokeDashoffset = '1'
    g.style.opacity = '1'
    const t0 = performance.now()
    const step = (t: number) => {
      const e = t - t0
      if (e < FWD_MS) {
        const p = easeInOut(e / FWD_MS)
        f.style.strokeDashoffset = String(1 - p)
        place(f.getPointAtLength(p * fl))
        for (let i = 0; i < 4; i++) {
          if (!lit[i] && p >= i / 3 - 0.002) {
            lit[i] = true
            light(i)
          }
        }
      } else if (e < FWD_MS + BACK_MS) {
        f.style.strokeDashoffset = '0'
        const q = easeOutIn((e - FWD_MS) / BACK_MS)
        b.style.strokeDashoffset = String(1 - q)
        place(b.getPointAtLength(q * bl))
        if (!closed && q > 0.995) {
          closed = true
          light(0)
        }
      } else if (e < FWD_MS + BACK_MS + FADE_MS) {
        if (!closed) {
          closed = true
          light(0)
        }
        b.style.strokeDashoffset = '0'
        g.style.opacity = String(1 - (e - FWD_MS - BACK_MS) / FADE_MS)
      } else {
        g.style.opacity = '0'
        f.style.strokeDashoffset = '1'
        b.style.strokeDashoffset = '1'
        running.current = false
        return
      }
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
  }, [light])

  // One pass when the page opens, then one each minute on the loop's own beat.
  useEffect(() => {
    if (!animate || !geo || reducedMotion()) return
    const due = () => (1 - loopFraction(lastPassAt)) * LOOP_PERIOD_MS
    let beat = 0
    const schedule = () => {
      beat = window.setTimeout(() => {
        if (visible.current && !document.hidden) runPass()
        schedule()
      }, Math.max(250, due()))
    }
    const intro = due() > 4000 ? window.setTimeout(() => visible.current && runPass(), 700) : 0
    schedule()
    return () => {
      window.clearTimeout(beat)
      window.clearTimeout(intro)
      cancelAnimationFrame(raf.current)
      unlight.current.forEach((t) => window.clearTimeout(t))
      unlight.current = []
      running.current = false
    }
    // geo changes on resize; the beat only needs to know that one exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, lastPassAt, runPass, geo === null])

  return (
    <figure ref={box} aria-label="Self-healing loop" className="relative m-0 w-full" style={{ height: geo ? geo.h : 98 }}>
      <figcaption className="sr-only">Every minute Backenly checks this backend, finds what is wrong, fixes what is safe and re-checks the fix.</figcaption>
      {geo && (
        <>
          <svg aria-hidden width={geo.w} height={geo.h} className="absolute inset-0 overflow-visible" fill="none">
            <path d={geo.back} stroke="rgba(255,255,255,0.075)" strokeWidth={1} />
            <path d={geo.forward} stroke="rgba(255,255,255,0.14)" strokeWidth={1} />
            <g ref={trace} style={{ opacity: 0 }}>
              <path ref={back} d={geo.back} stroke={VIOLET} strokeWidth={1.5} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} />
              <path ref={fwd} d={geo.forward} stroke={VIOLET} strokeWidth={1.5} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} />
              <circle ref={head} r={2.5} fill={HEAD} cx={geo.nodes[0].x} cy={geo.nodes[0].y} />
            </g>
            {geo.nodes.map((n, i) => (
              <circle
                key={stages[i]?.key ?? i}
                ref={(el) => {
                  nodeEls.current[i] = el
                }}
                cx={n.x}
                cy={n.y}
                r={4}
                fill={SURFACE}
                stroke={NODE_STROKE}
                strokeWidth={1.25}
                strokeDasharray={stages[i]?.dim ? '2 2' : undefined}
                style={{ transition: 'fill 260ms ease, stroke 260ms ease' }}
              />
            ))}
          </svg>
          {stages.slice(0, 4).map((s, i) => {
            const n = geo.nodes[i]
            const value = (
              <span
                className={`tabular-nums ${
                  s.attention ? 'font-medium text-zinc-50' : s.dim ? 'text-zinc-500' : 'text-zinc-200'
                }`}
              >
                {s.value}
              </span>
            )
            const label = (
              <span
                ref={(el) => {
                  labelEls.current[i] = el
                }}
                style={{ color: LABEL, transition: 'color 260ms ease' }}
              >
                {s.label}
              </span>
            )
            return geo.vertical ? (
              <div
                key={s.key}
                className="absolute left-[48px] right-0 flex items-baseline gap-[12px] text-[13px] leading-[20px]"
                style={{ top: n.y - 10 }}
              >
                <span className="w-[72px] flex-shrink-0">{label}</span>
                <span className="min-w-0 truncate text-[14px]">{value}</span>
              </div>
            ) : (
              <div
                key={s.key}
                className="absolute flex -translate-x-1/2 flex-col items-center text-center"
                style={{ left: n.x, top: 24, width: Math.max(96, geo.w / 4 - 12) }}
              >
                <span className="text-[12.5px] leading-[18px]">{label}</span>
                <span className="mt-[3px] max-w-full truncate text-[15px] leading-[22px] tracking-[-0.01em]">{value}</span>
              </div>
            )
          })}
          {geo.caption && (
            <span
              aria-hidden
              className="absolute -translate-x-1/2 -translate-y-1/2 bg-[#0f1012] px-[10px] text-[11.5px] leading-[16px] text-faint"
              style={{ left: geo.caption.x, top: geo.caption.y }}
            >
              Every minute
            </span>
          )}
        </>
      )}
    </figure>
  )
}
