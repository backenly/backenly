'use client'

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { SOURCE_ORDER, SourceMark, type SourceId } from './sources'

/* ─────────────────────────────────────────────────────────────
   The sources on /migrate as tabs: Supabase, Firebase, any Postgres. Each
   tab's panel is rendered on the server and kept in the page (hidden when not
   chosen), so every word is there for search and for find-in-page.

   The choice follows the address: #supabase, #firebase and #postgres open
   their tab (the old guide's section anchors keep working), and choosing a
   tab writes its hash without scrolling. Arrow keys, Home and End move
   between tabs, which activate as they take focus.
───────────────────────────────────────────────────────────── */

const LABEL: Record<SourceId, string> = { supabase: 'Supabase', firebase: 'Firebase', postgres: 'Any Postgres' }

function isSource(value: string): value is SourceId {
  return (SOURCE_ORDER as string[]).includes(value)
}

export function SourceTabs({ panels }: { panels: Record<SourceId, ReactNode> }) {
  const [active, setActive] = useState<SourceId>('supabase')
  const wrap = useRef<HTMLDivElement>(null)
  const tabs = useRef<Partial<Record<SourceId, HTMLButtonElement | null>>>({})

  useEffect(() => {
    const follow = (scroll: boolean) => {
      const hash = window.location.hash.slice(1)
      if (!isSource(hash)) return
      setActive(hash)
      if (scroll) wrap.current?.scrollIntoView({ block: 'start' })
    }
    // On arrival, after the first paint, so the page has its height before the scroll.
    const first = requestAnimationFrame(() => follow(true))
    const onHash = () => follow(true)
    window.addEventListener('hashchange', onHash)
    return () => {
      cancelAnimationFrame(first)
      window.removeEventListener('hashchange', onHash)
    }
  }, [])

  const choose = (id: SourceId) => {
    setActive(id)
    window.history.replaceState(null, '', `#${id}`)
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, id: SourceId) => {
    const i = SOURCE_ORDER.indexOf(id)
    const last = SOURCE_ORDER.length - 1
    const to =
      e.key === 'ArrowRight' ? (i === last ? 0 : i + 1) : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null
    if (to === null) return
    e.preventDefault()
    const next = SOURCE_ORDER[to]
    choose(next)
    tabs.current[next]?.focus()
  }

  return (
    <div ref={wrap} className="scroll-mt-[96px]">
      <div
        role="tablist"
        aria-label="Where your project is now"
        className="flex w-full gap-[4px] rounded-[8px] border border-white/[0.10] bg-white/[0.03] p-[4px] sm:inline-flex sm:w-auto"
      >
        {SOURCE_ORDER.map((id) => {
          const on = id === active
          return (
            <button
              key={id}
              ref={(el) => {
                tabs.current[id] = el
              }}
              type="button"
              role="tab"
              id={`source-tab-${id}`}
              aria-selected={on}
              aria-controls={`source-panel-${id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => choose(id)}
              onKeyDown={(e) => onKey(e, id)}
              className={`inline-flex h-[38px] min-w-0 flex-1 items-center justify-center gap-[8px] rounded-[6px] px-[10px] text-[14px] font-medium transition-colors duration-150 sm:flex-none sm:px-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
                on ? 'bg-white/[0.10] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)]' : 'text-zinc-400 hover:text-white'
              }`}
            >
              <SourceMark id={id} className="h-[14px] w-[14px]" />
              {id === 'postgres' ? (
                <>
                  <span className="sm:hidden">Postgres</span>
                  <span className="hidden sm:inline">{LABEL[id]}</span>
                </>
              ) : (
                LABEL[id]
              )}
            </button>
          )
        })}
      </div>

      {SOURCE_ORDER.map((id) => (
        <div
          key={id}
          role="tabpanel"
          id={`source-panel-${id}`}
          aria-labelledby={`source-tab-${id}`}
          hidden={id !== active}
          className="mt-[20px]"
        >
          {panels[id]}
        </div>
      ))}
    </div>
  )
}
