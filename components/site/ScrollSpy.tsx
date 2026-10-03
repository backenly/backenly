'use client'

import { useEffect, useState } from 'react'

export type SpyItem = { id: string; label: string; meta?: string }

/**
 * An in-page index that marks the section you are reading.
 *
 * IntersectionObserver, never a scroll listener: the browser reports when a
 * section crosses a band near the top of the viewport, and nothing runs while
 * the page scrolls between those moments. The band sits below the sticky
 * navbar (68px) so "current" means the section whose heading you can see.
 *
 * Links stay ordinary hash links, so the index works with JavaScript off and
 * middle-click, and `aria-current` tells a screen reader which one is active.
 */
export function ScrollSpy({
  items,
  label,
  className = '',
  numbered = false,
}: {
  items: SpyItem[]
  /** Accessible name of the navigation landmark. */
  label: string
  className?: string
  /** Prefix each entry with its position, for documents whose sections are numbered. */
  numbered?: boolean
}) {
  const [active, setActive] = useState<string | null>(items[0]?.id ?? null)

  useEffect(() => {
    const sections = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null)
    if (sections.length === 0) return

    const visible = new Map<string, number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top)
          else visible.delete(entry.target.id)
        }
        if (visible.size > 0) {
          // The topmost section inside the band is the one being read.
          const [first] = [...visible.entries()].sort((a, b) => a[1] - b[1])
          setActive(first[0])
        }
      },
      { rootMargin: '-96px 0px -55% 0px', threshold: 0 },
    )
    sections.forEach((section) => observer.observe(section))
    return () => observer.disconnect()
  }, [items])

  return (
    <nav aria-label={label} className={className}>
      <ul className="flex flex-col border-l border-white/[0.08]">
        {items.map((item, index) => {
          const current = item.id === active
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={current ? 'location' : undefined}
                className={`-ml-px flex gap-3 border-l py-[7px] pl-4 text-[14px] leading-[1.45] tracking-[-0.006em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 ${
                  current
                    ? 'border-violet-300 text-white'
                    : 'border-transparent text-zinc-500 hover:border-white/25 hover:text-zinc-200'
                }`}
              >
                {numbered && <span className="w-5 shrink-0 tabular-nums text-zinc-600">{index + 1}</span>}
                <span className="min-w-0">{item.label}</span>
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
