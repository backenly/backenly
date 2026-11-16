'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, Rss } from 'lucide-react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'

/* ─────────────────────────────────────────────────────────────
   The changelog's frame (founders, 2026-11-15: "more professional, like how
   our competitors and devtools do"). On a wide screen a rail stays in view
   beside the entries: the months, with the one being read marked; the areas,
   to show only one; and the feed. On a phone the areas are a row of chips
   above the entries.

   Filtering is CSS on the server-rendered page (app/changelog/page.tsx writes
   the rules): this only sets data-cl-filter, so every entry is in the HTML for
   search engines and readers without script, and nothing re-renders.
───────────────────────────────────────────────────────────── */

type Month = { id: string; label: string; count: number }
type Area = { area: string; slug: string; count: number }

const RAIL_LINK =
  'flex items-center justify-between gap-[12px] rounded-[6px] px-[10px] py-[6px] text-[14px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70'

export function ChangelogFeed({
  months,
  areas,
  total,
  children,
}: {
  months: Month[]
  areas: Area[]
  total: number
  children: ReactNode
}) {
  const [filter, setFilter] = useState('all')
  const [reading, setReading] = useState(months[0]?.id ?? '')
  const feedRef = useRef<HTMLDivElement>(null)
  const quiet = useSettledReducedMotion()

  // The month being read: the topmost month section inside the band under the header.
  useEffect(() => {
    const sections = months.map((m) => document.getElementById(m.id)).filter((el): el is HTMLElement => el !== null)
    const visible = new Map<string, number>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top)
          else visible.delete(e.target.id)
        }
        const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0]
        if (top) setReading(top[0])
      },
      { rootMargin: '-96px 0px -35% 0px' },
    )
    sections.forEach((s) => io.observe(s))
    return () => io.disconnect()
  }, [months])

  const choose = (next: string) => {
    setFilter(next)
    // Bring the start of the list into view when the reader is below it, so a shorter list never leaves them past its end.
    const feed = feedRef.current
    // Under the sticky header (68px) counts as out of view: the month's title would sit behind it.
    if (feed && feed.getBoundingClientRect().top < 96) {
      window.scrollTo({ top: feed.getBoundingClientRect().top + window.scrollY - 96, behavior: quiet ? 'auto' : 'smooth' })
    }
  }

  const chosen = areas.find((a) => a.slug === filter)
  const shown = chosen ? chosen.count : total

  return (
    <div className="grid gap-x-[64px] lg:grid-cols-[208px_minmax(0,1fr)]">
      <aside className="hidden lg:block" aria-label="Changelog">
        <div className="sticky top-[96px] max-h-[calc(100vh-112px)] overflow-y-auto pb-[24px] pr-[4px]">
          <nav aria-label="Months">
            <p className="px-[10px] text-[13px] text-faint">Months</p>
            <ul className="mt-[8px] grid gap-[2px]">
              {months.map((m) => (
                <li key={m.id}>
                  <a
                    href={`#${m.id}`}
                    aria-current={reading === m.id ? 'location' : undefined}
                    className={`${RAIL_LINK} ${reading === m.id ? 'bg-white/[0.06] text-white' : 'text-zinc-400 hover:bg-white/[0.03] hover:text-white'}`}
                  >
                    <span>{m.label}</span>
                    <span className="tabular-nums text-[12.5px] text-zinc-400">{m.count}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="mt-[28px]">
            <p id="cl-area-label" className="px-[10px] text-[13px] text-faint">
              Area
            </p>
            <div role="group" aria-labelledby="cl-area-label" className="mt-[8px] grid gap-[2px]">
              {[{ area: 'All changes', slug: 'all', count: total }, ...areas].map((a) => (
                <button
                  key={a.slug}
                  type="button"
                  aria-pressed={filter === a.slug}
                  onClick={() => choose(a.slug)}
                  className={`${RAIL_LINK} w-full text-left ${
                    filter === a.slug ? 'bg-white/[0.06] text-white' : 'text-zinc-400 hover:bg-white/[0.03] hover:text-white'
                  }`}
                >
                  <span>{a.area}</span>
                  <span className="tabular-nums text-[12.5px] text-zinc-400">{a.count}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-[28px]">
            <p className="px-[10px] text-[13px] text-faint">Follow</p>
            <ul className="mt-[8px] grid gap-[2px]">
              <li>
                <a href="/changelog/rss.xml" className={`${RAIL_LINK} text-zinc-400 hover:bg-white/[0.03] hover:text-white`}>
                  <span>RSS feed</span>
                  <Rss aria-hidden className="h-[14px] w-[14px]" />
                </a>
              </li>
              <li>
                <a
                  href="https://x.com/Backenly"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${RAIL_LINK} text-zinc-400 hover:bg-white/[0.03] hover:text-white`}
                >
                  <span>
                    Backenly on X<span className="sr-only"> (opens in a new tab)</span>
                  </span>
                  <ArrowUpRight aria-hidden className="h-[14px] w-[14px]" />
                </a>
              </li>
            </ul>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        {/* On a phone the areas are one row of chips; the row scrolls sideways, every chip a button. */}
        <div className="-mx-5 mb-[28px] overflow-x-auto px-5 pb-[4px] sm:-mx-6 sm:px-6 lg:hidden">
          <div role="group" aria-label="Area" className="flex w-max gap-[8px]">
            {[{ area: 'All', slug: 'all', count: total }, ...areas].map((a) => (
              <button
                key={a.slug}
                type="button"
                aria-pressed={filter === a.slug}
                onClick={() => choose(a.slug)}
                className={`inline-flex h-[34px] items-center gap-[8px] whitespace-nowrap rounded-[6px] border px-[12px] text-[14px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
                  filter === a.slug ? 'border-white bg-white text-black' : 'border-white/[0.10] bg-white/[0.03] text-zinc-300'
                }`}
              >
                {a.area}
                <span className={`tabular-nums text-[12.5px] ${filter === a.slug ? 'text-zinc-600' : 'text-zinc-400'}`}>{a.count}</span>
              </button>
            ))}
          </div>
        </div>

        <p className="sr-only" aria-live="polite">
          {filter === 'all' ? `Showing all ${total} changes` : `Showing ${shown} ${chosen?.area ?? ''} changes`}
        </p>

        <div ref={feedRef} data-cl-filter={filter} className="scroll-mt-[96px]">
          {children}
        </div>
      </div>
    </div>
  )
}
