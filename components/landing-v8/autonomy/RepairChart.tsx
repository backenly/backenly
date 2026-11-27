'use client'

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { usePlayOnce } from './play'

/* ─────────────────────────────────────────────────────────────
   "Your backend repairs itself", shown the database's way (founders,
   2026-11-15: the two schema films were redundant; three designers in review
   agreed each box gets its own kind of evidence). One measurement, one fix,
   at the scale the product really works: a minute.

   The series is honest at this size: before the index, finding one movie's
   watchlist entries reads the whole table (4,120 rows); after it, the
   matching rows (about 3: 4,120 entries over 1,284 movies). Backenly's
   relationship-index check reads the catalog every minute, so the fix lands
   a minute after the check finds it, never hours later. One violet line is
   the one thing Backenly did; the dashed line is the one thing it left for a
   person. It draws once, then rests; hover or arrow keys read any minute.
───────────────────────────────────────────────────────────── */

const MINUTES = ['03:05', '03:06', '03:07', '03:08', '03:09', '03:10', '03:11', '03:12', '03:13', '03:14', '03:15', '03:16', '03:17']
const FOUND = 1
const FIX = 2
const RECHECK = 3
const HELD = 7
const LAST = MINUTES.length - 1
const x = (i: number) => (i / LAST) * 100
/** Heights in percent from the top of the plot. */
const Y_TABLE = 18
const Y_ROWS = 90

const READ = MINUTES.map((m, i) => ({
  m,
  rows: i < FIX ? '4,120' : '3',
  note: i === FOUND ? '26 of 27 checks pass' : i === FIX ? 'index added, re-checked next minute' : i === HELD ? 'all 27 checks pass; one request waiting on you' : 'all 27 checks pass',
}))

const NOTES = [
  { at: MINUTES[FOUND], text: 'Found: watchlist_items.movie_id has no index' },
  { at: MINUTES[FIX], text: 'Index added on its own, without blocking reads or writes' },
  { at: MINUTES[RECHECK], text: 'Re-checked: fixed. All 27 checks pass.' },
]

/** The pen's moments: it reaches the fix, the line lands, the notes arrive, it runs on to now. */
const MARKS = [0, 700, 820, 900, 1000, 1150, 1450, 1650, 2300] as const

export function RepairChart() {
  const ref = useRef<HTMLDivElement>(null)
  const t = usePlayOnce(ref, MARKS)
  const [hover, setHover] = useState<number | null>(null)

  const playing = t >= 0 && t !== Infinity
  const fixed = t >= 1000
  const pen = t < 0 ? 0 : t < 1000 ? x(FIX) : 100
  const penMove = t < 0 ? 'none' : t < 1000 ? 'transform 700ms linear' : 'transform 1300ms linear'
  const shown = (m: number) => t >= m

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setHover(Math.max(0, Math.min(LAST, Math.round(((e.clientX - r.left) / r.width) * LAST))))
  }
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    setHover((h) => Math.max(0, Math.min(LAST, (h ?? FIX) + (e.key === 'ArrowRight' ? 1 : -1))))
  }
  const read = hover === null ? null : READ[hover]

  return (
    <figure ref={ref} className="overflow-hidden rounded-[8px] border border-white/[0.07] bg-[#0a0a0d]">
      <div className="flex items-start justify-between gap-[24px] px-[20px] pt-[18px] sm:px-[28px] sm:pt-[24px]">
        <div className="min-w-0">
          <p className="text-[14.5px] font-medium tracking-[-0.01em] text-zinc-100">Rows read to find one movie&apos;s watchlist entries</p>
          <p className="mt-[4px] text-[12.5px] text-faint">watchlist_items, from Postgres&apos;s own table statistics</p>
        </div>
        <div className="shrink-0 text-right" aria-hidden>
          <p className="font-mono text-[26px] leading-none tracking-[-0.02em] text-white tabular-nums">{read ? read.rows : fixed ? '3' : '4,120'}</p>
          <p className="mt-[6px] text-[12.5px] text-faint">{read ? read.m : fixed ? 'was 4,120' : 'the whole table'}</p>
        </div>
      </div>

      <div className="px-[20px] pb-[18px] pt-[22px] sm:px-[28px] sm:pb-[22px]">
        <div
          tabIndex={0}
          role="group"
          aria-label="Rows read per lookup, minute by minute. Use the arrow keys to read each minute."
          onPointerMove={pick}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover((h) => h ?? FIX)}
          onBlur={() => setHover(null)}
          onKeyDown={keys}
          className="relative h-[170px] cursor-crosshair rounded-[2px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#0a0a0d] sm:h-[200px]"
        >
          {/* Rules: the whole table, and nothing. */}
          <span aria-hidden className="absolute inset-x-0 border-t border-dashed border-white/[0.10]" style={{ top: `${Y_TABLE}%` }} />
          <span aria-hidden className="absolute bottom-0 left-0 right-0 h-px bg-white/[0.12]" />
          <span aria-hidden className="absolute right-0 -translate-y-full pb-[4px] font-mono text-[12px] tabular-nums text-faint" style={{ top: `${Y_TABLE}%` }}>
            4,120
          </span>

          <span aria-hidden className="absolute right-0 -translate-y-full pb-[4px] font-mono text-[12px] tabular-nums text-faint" style={{ top: `${Y_ROWS}%` }}>
            3
          </span>

          {/* The series: the whole table until the index, then the matching rows. */}
          <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
            {/* Before and after; the violet line alone joins them, since the fix is the change. */}
            <path d={`M0 ${Y_TABLE} H${x(FIX)} M${x(FIX)} ${Y_ROWS} H100`} fill="none" stroke="rgba(228,228,231,0.92)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
          </svg>

          {/* The one thing Backenly did. */}
          <span
            aria-hidden
            className="absolute bottom-0 top-0 w-[2px] origin-bottom bg-violet-400 transition-transform duration-[260ms] ease-out"
            style={{ left: `calc(${x(FIX)}% - 1px)`, transform: shown(820) ? 'scaleY(1)' : 'scaleY(0)' }}
          />
          {/* The one thing it left for a person. */}
          <span
            aria-hidden
            className="absolute bottom-0 top-0 border-l border-dashed border-white/40 transition-opacity duration-300"
            style={{ left: `${x(HELD)}%`, opacity: shown(1650) ? 1 : 0 }}
          />

          {/* Notes, on the chart where there is room (xl up). */}
          <div aria-hidden className="pointer-events-none absolute hidden xl:block" style={{ left: `calc(${x(FIX)}% + 16px)`, top: 40 }}>
            {NOTES.map((n, i) => (
              <p
                key={n.at}
                className="flex gap-[10px] whitespace-nowrap text-[13px] leading-[24px] transition-[opacity,transform] duration-300 ease-out"
                style={{ opacity: shown([900, 1150, 1450][i]) ? 1 : 0, transform: shown([900, 1150, 1450][i]) ? 'none' : 'translateY(4px)' }}
              >
                <span className="font-mono text-[12px] tabular-nums text-faint">{n.at}</span>
                <span className={i === 1 ? 'text-white' : 'text-zinc-300'}>{n.text}</span>
              </p>
            ))}
          </div>
          <div aria-hidden className="pointer-events-none absolute hidden xl:block" style={{ left: `calc(${x(HELD)}% + 16px)`, top: 40, opacity: shown(1650) ? 1 : 0, transition: 'opacity 300ms ease-out' }}>
            <p className="flex gap-[10px] whitespace-nowrap text-[13px] leading-[24px]">
              <span className="font-mono text-[12px] tabular-nums text-faint">{MINUTES[HELD]}</span>
              <span className="rounded-[4px] border border-dashed border-white/50 px-[6px] text-[12.5px] leading-[20px] text-white">Waiting on you</span>
            </p>
            <p className="pl-[50px] text-[13px] leading-[20px] text-zinc-400">Your agent asked to drop a column on movies</p>
          </div>

          {/* The pen: an edge of night moving right, uncovering the record. */}
          {t !== Infinity && (
            <span
              aria-hidden
              className="absolute inset-y-[-4px] left-0 w-full border-l border-white/45 bg-[#0a0a0d]"
              style={{ transform: `translateX(${pen}%)`, transition: penMove, willChange: playing ? 'transform' : undefined }}
            />
          )}

          {/* Reading a minute. */}
          {read && hover !== null && (
            <>
              <span aria-hidden className="pointer-events-none absolute bottom-0 top-0 w-px bg-white/25" style={{ left: `${x(hover)}%` }} />
              <span
                aria-hidden
                className="pointer-events-none absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#0a0a0d] bg-white"
                style={{ left: `${x(hover)}%`, top: `${hover < FIX ? Y_TABLE : Y_ROWS}%` }}
              />
              <span
                aria-hidden
                className={`pointer-events-none absolute -top-[2px] whitespace-nowrap rounded-[6px] border border-white/[0.10] bg-[#111114] px-[8px] py-[4px] text-[12px] text-zinc-200 shadow-[0_8px_20px_-10px_rgba(0,0,0,0.9)] ${hover > LAST / 2 ? '-translate-x-full -ml-[8px]' : 'ml-[8px]'}`}
                style={{ left: `${x(hover)}%` }}
              >
                <span className="font-mono tabular-nums text-faint">{read.m}</span> {read.note}
              </span>
            </>
          )}
        </div>

        {/* One tick per run of the 27 checks; the one that found it stands taller. */}
        <div aria-hidden className="relative mt-[2px] h-[30px]">
          {MINUTES.map((m, i) => (
            <span key={m} className="absolute top-0 -translate-x-1/2" style={{ left: `${x(i)}%` }}>
              <span className={`mx-auto block w-px transition-[height,background-color] duration-300 ${i === FOUND && shown(900) ? 'h-[12px] bg-white' : 'h-[6px] bg-white/25'}`} />
              <span className={`mt-[4px] block font-mono text-[12px] tabular-nums text-faint ${i % 2 ? 'hidden' : i % 4 ? 'hidden sm:block' : 'block'}`}>{m}</span>
            </span>
          ))}
        </div>

        {/* Narrower, the notes sit under the chart. */}
        <ul aria-hidden className="mt-[14px] grid gap-[6px] border-t border-white/[0.07] pt-[14px] md:grid-cols-2 md:gap-x-[24px] xl:hidden">
          {NOTES.map((n) => (
            <li key={n.at} className="flex gap-[10px] text-[13px] leading-[1.5] text-zinc-300">
              <span className="shrink-0 font-mono text-[12px] tabular-nums text-faint">{n.at}</span>
              {n.text}
            </li>
          ))}
          <li className="flex gap-[10px] text-[13px] leading-[1.5] text-zinc-300">
            <span className="shrink-0 font-mono text-[12px] tabular-nums text-faint">{MINUTES[HELD]}</span>
            <span>
              <span className="mr-[6px] rounded-[4px] border border-dashed border-white/50 px-[5px] text-white">Waiting on you</span>
              your agent asked to drop a column on movies
            </span>
          </li>
        </ul>
      </div>

      {/* The record behind the drawing, for screen readers. */}
      <table className="sr-only">
        <caption>Rows read to find one movie&apos;s watchlist entries, per minute. At 03:06 a check found no index on watchlist_items.movie_id; at 03:07 Backenly added it on its own; at 03:08 it was re-checked and all 27 checks passed. At 03:12 your agent&apos;s request to drop a column on movies waited for you.</caption>
        <thead>
          <tr>
            <th scope="col">Minute</th>
            <th scope="col">Rows read</th>
            <th scope="col">Checks</th>
          </tr>
        </thead>
        <tbody>
          {READ.map((r) => (
            <tr key={r.m}>
              <td>{r.m}</td>
              <td>{r.rows}</td>
              <td>{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
