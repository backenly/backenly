'use client'

/**
 * TimeSeriesChart: values over time on an instrument page (Monitoring now,
 * Usage later).
 *
 *   1,400 ─────────────────────────────────────────────
 *         ▁▂▃▃▄▅▆▇█▇▆▅▄▃   ¦          ✦
 *   ──────────────────────────────────────────────────
 *   Nov 16      6 AM       12 PM       6 PM
 *
 * - One bucket per bar (or per line point), drawn where the bucket starts, so
 *   the chart says what the server counted and nothing in between. A bucket
 *   the server did not return had no traffic: no bar, and the line breaks.
 * - Brightness carries meaning, never hue: zinc for traffic, near-white for
 *   failures, and the markers: zinc for a person's event (a publish), violet
 *   for what Backenly itself did (a fix). No gradient, no glow.
 * - Time ticks on the x axis, in the viewer's zone; with `utc` (daily buckets
 *   are UTC days) the ticks and the hover say UTC.
 * - Hovering a bucket shows its time, each series' value and any marker in it.
 *   The chart is one image to assistive tech, labelled with what it shows and
 *   its peak, and its markers in words; the numbers it plots are also on the
 *   page as text (the header, the tables), so nothing lives only in the plot.
 *
 *   <TimeSeriesChart
 *     series={[{ id: 'requests', label: 'Requests', kind: 'bar', points, format: (v) => `${v} requests` }]}
 *     start={now - DAY} end={now} bucketMs={HOUR}
 *     markers={[{ t: publishedAt, tone: 'zinc', label: 'Published v5' }]}
 *     ariaLabel="Requests per hour, the last 24 hours."
 *   />
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatTime } from './format'
import { FLOAT, RAISE } from './tokens'

export interface TimePoint {
  /** The bucket's start, epoch ms. */
  t: number
  v: number
}

export interface TimeSeries {
  id: string
  /** The series in words: "Requests", "Server errors", "Average response". */
  label: string
  kind: 'bar' | 'line'
  /** zinc for traffic and timings; `bad` (near-white) for failures. */
  tone?: 'zinc' | 'bad'
  points: readonly TimePoint[]
  /** One value in words, for the hover and the summary: "1,351 requests", "62 ms". */
  format?: (v: number) => string
  /** What the hover says for a bucket the series has no point in. Bars default to format(0); lines to "No data". */
  empty?: string
}

export interface ChartMarker {
  /** When it happened, epoch ms. */
  t: number
  /** zinc: a person's event (a publish). violet: something Backenly itself did. */
  tone: 'zinc' | 'violet'
  /** "Published v5", "Backenly added an index on watchlist_items". */
  label: string
}

export interface TimeSeriesChartProps {
  series: readonly TimeSeries[]
  /** The window drawn, epoch ms. */
  start: number
  end: number
  /** One bucket's width in ms. Buckets are epoch-aligned, as the server counts them. */
  bucketMs: number
  markers?: readonly ChartMarker[]
  /** The plot's height in px (the tick row adds 20). */
  height?: number
  /** The y axis's top label: "1,400", "200 ms". */
  yFormat?: (v: number) => string
  /** Read buckets and ticks in UTC (daily buckets are UTC days). */
  utc?: boolean
  /**
   * The y axis never tops out below this. For counts that are usually 0 or 1
   * (server errors), so a single error is a short bar under an honest "5"
   * rather than a full-height alarm.
   */
  minTop?: number
  /** What the chart shows, in one sentence; its peak and markers are appended. */
  ariaLabel: string
  className?: string
}

const PAD_TOP = 18
const TICK_ROW = 20
const MIN_TICK_GAP = 64
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const STEPS = [MIN, 5 * MIN, 15 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY]

// A failure series is zinc-100 (white on hover), so it stands out by brightness.
const BAR_FILL = { zinc: '#71717a', bad: '#f4f4f5' } as const
const BAR_HOVER = { zinc: '#a1a1aa', bad: '#ffffff' } as const
const LINE_STROKE = { zinc: '#d4d4d8', bad: '#ffffff' } as const
const MARK_STROKE = { zinc: 'rgba(161,161,170,0.55)', violet: 'rgba(167,139,250,0.9)' } as const
const MARK_FILL = { zinc: '#a1a1aa', violet: '#a78bfa' } as const

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect
const nf = new Intl.NumberFormat('en-US')

/** The smallest round number at or above v: 1, 2, 2.5, 5 × 10ⁿ. */
export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / exp
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nice * exp
}

/** The bucket a moment falls in, epoch-aligned the way the server buckets. */
export function bucketOf(t: number, bucketMs: number): number {
  return Math.floor(t / bucketMs) * bucketMs
}

/** "6 AM" on the hour, "2:15 PM" otherwise. */
function clockShort(t: number, utc: boolean): string {
  return formatTime(t, 'clock', { utc }).replace(':00 ', ' ').replace(/ UTC$/, '')
}

function isMidnight(t: number, utc: boolean): boolean {
  const d = new Date(t)
  return utc ? d.getUTCHours() === 0 && d.getUTCMinutes() === 0 : d.getHours() === 0 && d.getMinutes() === 0
}

/** The first boundary of `step` at or after `t`, counted from midnight in the chart's zone. */
function firstTick(t: number, step: number, utc: boolean): number {
  const d = new Date(t)
  const midnight = utc
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (step >= DAY) return midnight >= t ? midnight : midnight + DAY
  return midnight + Math.ceil((t - midnight) / step) * step
}

/** Time ticks for the window: as fine as the buckets allow, at least MIN_TICK_GAP px apart. */
export function timeTicks(start: number, end: number, width: number, bucketMs: number, utc = false): Array<{ t: number; label: string }> {
  const span = end - start
  if (span <= 0 || width <= 0) return []
  const step = STEPS.find((s) => s >= bucketMs && (s / span) * width >= MIN_TICK_GAP) ?? STEPS[STEPS.length - 1]
  const out: Array<{ t: number; label: string }> = []
  for (let t = firstTick(start, step, utc); t <= end && out.length < 40; t += step) {
    const label = step >= DAY || isMidnight(t, utc) ? formatTime(t, 'date', { utc }) : clockShort(t, utc)
    out.push({ t, label })
  }
  return out
}

/** The hover's heading for one bucket. */
function bucketTitle(t: number, bucketMs: number, utc: boolean): string {
  if (bucketMs >= DAY) return `${formatTime(t, 'date', { utc })}${utc ? ' (UTC day)' : ''}`
  if (bucketMs >= HOUR) return `${formatTime(t, 'date', { utc })}, ${clockShort(t, utc)} to ${clockShort(t + bucketMs, utc)}`
  return `${formatTime(t, 'date', { utc })}, ${formatTime(t, 'clock', { utc }).replace(/ UTC$/, '')}`
}

export function TimeSeriesChart({
  series,
  start,
  end,
  bucketMs,
  markers = [],
  height = 120,
  yFormat = (v) => nf.format(v),
  utc = false,
  minTop = 0,
  ariaLabel,
  className = '',
}: TimeSeriesChartProps) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useIsoLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const span = Math.max(1, end - start)
  const x = (t: number) => ((t - start) / span) * width

  const inWindow = useMemo(
    () => series.map((s) => ({ ...s, points: s.points.filter((p) => p.t + bucketMs > start && p.t <= end) })),
    [series, start, end, bucketMs],
  )
  const max = Math.max(0, ...inWindow.flatMap((s) => s.points.map((p) => p.v)))
  const yMax = niceCeil(Math.max(max, minTop))
  const y = (v: number) => PAD_TOP + height - (v / yMax) * height
  const shownMarkers = useMemo(() => markers.filter((m) => m.t >= start && m.t <= end).sort((a, b) => a.t - b.t), [markers, start, end])
  const ticks = useMemo(() => timeTicks(start, end, width, bucketMs, utc), [start, end, width, bucketMs, utc])

  // The summary a screen reader hears: what it is, its peak, and its markers.
  const summary = useMemo(() => {
    const parts: string[] = [ariaLabel]
    for (const s of inWindow) {
      if (s.points.length === 0) continue
      const peak = s.points.reduce((a, b) => (b.v > a.v ? b : a))
      const say = s.format ?? ((v: number) => nf.format(v))
      parts.push(`${s.label}: highest ${say(peak.v)}, ${bucketTitle(peak.t, bucketMs, utc)}.`)
    }
    if (shownMarkers.length) {
      parts.push(
        `Marked: ${shownMarkers.map((m) => `${m.label}, ${formatTime(m.t, 'dateTime', { utc })}`).join('; ')}.`,
      )
    }
    return parts.join(' ')
  }, [ariaLabel, inWindow, shownMarkers, bucketMs, utc])

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (width <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = Math.min(Math.max(0, e.clientX - rect.left), width)
    const t = start + (px / width) * span
    setHover(bucketOf(t, bucketMs))
  }

  const plotH = PAD_TOP + height
  const barW = Math.max(1, Math.min(28, (bucketMs / span) * width * 0.72))
  const hoverX = hover === null ? null : Math.min(width, Math.max(0, x(hover + bucketMs / 2)))

  return (
    <div className={`relative select-none ${className}`}>
      <div
        ref={box}
        role="img"
        aria-label={summary}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        className="relative w-full touch-pan-y"
        style={{ height: plotH + TICK_ROW }}
      >
        {width > 0 && (
          <svg aria-hidden width={width} height={plotH} className="absolute left-0 top-0 overflow-visible">
            {/* Gridlines: the top value, the middle, the baseline. */}
            <line x1={0} x2={width} y1={PAD_TOP + 0.5} y2={PAD_TOP + 0.5} stroke="rgba(255,255,255,0.06)" />
            <line x1={0} x2={width} y1={Math.round(PAD_TOP + height / 2) + 0.5} y2={Math.round(PAD_TOP + height / 2) + 0.5} stroke="rgba(255,255,255,0.035)" />
            <line x1={0} x2={width} y1={plotH - 0.5} y2={plotH - 0.5} stroke="rgba(255,255,255,0.10)" />

            {inWindow.map((s) => {
              const tone = s.tone ?? 'zinc'
              if (s.kind === 'bar') {
                return (
                  <g key={s.id}>
                    {s.points.map((p) => {
                      if (p.v <= 0) return null
                      const slot = (bucketMs / span) * width
                      let bx = x(p.t) + (slot - barW) / 2
                      let bw = barW
                      if (bx < 0) {
                        bw += bx
                        bx = 0
                      }
                      if (bx + bw > width) bw = width - bx
                      if (bw <= 0) return null
                      const top = Math.min(y(p.v), plotH - 1.5)
                      return (
                        <rect
                          key={p.t}
                          x={bx}
                          y={top}
                          width={bw}
                          height={plotH - top}
                          rx={Math.min(1.5, bw / 2)}
                          fill={hover === p.t ? BAR_HOVER[tone] : BAR_FILL[tone]}
                          fillOpacity={hover === null || hover === p.t ? 0.95 : 0.7}
                        />
                      )
                    })}
                  </g>
                )
              }
              // A line through each bucket's middle; a gap in the buckets breaks it.
              const pts = [...s.points].sort((a, b) => a.t - b.t)
              const runs: TimePoint[][] = []
              for (const p of pts) {
                const run = runs[runs.length - 1]
                if (run && p.t - run[run.length - 1].t <= bucketMs * 1.5) run.push(p)
                else runs.push([p])
              }
              return (
                <g key={s.id}>
                  {runs.map((run) =>
                    run.length === 1 ? (
                      <circle key={run[0].t} cx={x(run[0].t + bucketMs / 2)} cy={y(run[0].v)} r={1.75} fill={LINE_STROKE[tone]} />
                    ) : (
                      <polyline
                        key={run[0].t}
                        points={run.map((p) => `${x(p.t + bucketMs / 2).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}
                        fill="none"
                        stroke={LINE_STROKE[tone]}
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    ),
                  )}
                </g>
              )
            })}

            {shownMarkers.map((m, i) => {
              const mx = Math.round(x(m.t)) + 0.5
              return (
                <g key={`${m.t}-${i}`}>
                  <line x1={mx} x2={mx} y1={PAD_TOP - 4} y2={plotH} stroke={MARK_STROKE[m.tone]} strokeDasharray={m.tone === 'zinc' ? '3 3' : undefined} />
                  {m.tone === 'violet' ? (
                    // Backenly's mark: a small four-point sparkle.
                    <path
                      d={`M${mx} ${PAD_TOP - 11} Q${mx + 0.8} ${PAD_TOP - 7.8} ${mx + 4} ${PAD_TOP - 7} Q${mx + 0.8} ${PAD_TOP - 6.2} ${mx} ${PAD_TOP - 3} Q${mx - 0.8} ${PAD_TOP - 6.2} ${mx - 4} ${PAD_TOP - 7} Q${mx - 0.8} ${PAD_TOP - 7.8} ${mx} ${PAD_TOP - 11}Z`}
                      fill={MARK_FILL.violet}
                    />
                  ) : (
                    <circle cx={mx} cy={PAD_TOP - 7} r={2.25} fill={MARK_FILL.zinc} />
                  )}
                </g>
              )
            })}

            {hoverX !== null && <line x1={hoverX} x2={hoverX} y1={PAD_TOP} y2={plotH} stroke="rgba(255,255,255,0.22)" />}
          </svg>
        )}

        {/* The top gridline's value. */}
        {width > 0 && max > 0 && (
          <span aria-hidden className="pointer-events-none absolute left-0 top-0 text-[11px] leading-[14px] tabular-nums text-faint">
            {yFormat(yMax)}
          </span>
        )}

        {/* Time ticks. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0" style={{ height: TICK_ROW }}>
          {ticks.map((tk) => {
            const tx = x(tk.t)
            const edge = tx < 24 ? 'left' : tx > width - 24 ? 'right' : 'center'
            return (
              <span
                key={tk.t}
                className="absolute top-[5px] whitespace-nowrap text-[11px] leading-[14px] tabular-nums text-faint"
                style={
                  edge === 'left'
                    ? { left: Math.max(0, tx) }
                    : edge === 'right'
                      ? { right: Math.max(0, width - tx) }
                      : { left: tx, transform: 'translateX(-50%)' }
                }
              >
                {tk.label}
              </span>
            )
          })}
        </div>

        {hover !== null && hoverX !== null && (
          <HoverCard
            x={hoverX}
            width={width}
            title={bucketTitle(hover, bucketMs, utc)}
            rows={inWindow.map((s) => {
              const p = s.points.find((q) => q.t === hover)
              const say = s.format ?? ((v: number) => nf.format(v))
              return {
                id: s.id,
                tone: s.tone ?? 'zinc',
                text: p ? say(p.v) : s.empty ?? (s.kind === 'bar' ? say(0) : 'No data'),
              }
            })}
            marks={shownMarkers.filter((m) => m.t >= hover && m.t < hover + bucketMs)}
          />
        )}
      </div>
    </div>
  )
}

function HoverCard({
  x,
  width,
  title,
  rows,
  marks,
}: {
  x: number
  width: number
  title: string
  rows: Array<{ id: string; tone: 'zinc' | 'bad'; text: string }>
  marks: ChartMarker[]
}) {
  const right = x > width / 2
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute top-[2px] z-[5] max-w-[260px] rounded-[8px] ${RAISE} ${FLOAT} px-[10px] py-[8px]`}
      style={right ? { right: Math.max(0, width - x + 10) } : { left: Math.min(x + 10, Math.max(0, width - 180)) }}
    >
      <p className="whitespace-nowrap text-[11.5px] leading-[16px] text-faint">{title}</p>
      {rows.map((r) => (
        <p key={r.id} className="mt-[2px] whitespace-nowrap text-[12.5px] font-medium leading-[18px] tabular-nums text-zinc-100">
          {r.text}
        </p>
      ))}
      {marks.map((m, i) => (
        <p key={i} className="mt-[4px] flex items-start gap-[6px] text-[12px] leading-[16px] text-zinc-300">
          <span className={`mt-[4px] h-[8px] w-[2px] flex-shrink-0 rounded-full ${m.tone === 'violet' ? 'bg-violet-400' : 'bg-zinc-400'}`} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{m.label}</span>
        </p>
      ))}
    </div>
  )
}
