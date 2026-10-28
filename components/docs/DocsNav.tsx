import Link from 'next/link'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { DOC_GROUPS, DOCS_BY_SLUG, docsInGroup, type DocSlug } from '@/app/docs/content'
import { DOC_ICONS } from './DocIcon'

/**
 * The small tag the console sidebar puts beside a label, such as MCP or Beta,
 * in the landing's figure grammar: an uppercase tag on a solid ink chip.
 */
export function DocTag({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex h-[18px] shrink-0 items-center rounded-[5px] border border-white/[0.09] bg-[#0b0b0e] px-[6px] text-[9px] font-medium uppercase leading-none tracking-[0.14em] text-zinc-400 ${className}`}
    >
      {children}
    </span>
  )
}

/**
 * Every docs page, grouped exactly like the console sidebar, with the same
 * icons. Shared by the desktop rail and the phone menu so the two can never
 * list different pages. The current page is marked by brightness alone; the
 * one violet mark on a docs page is the "On this page" rail.
 *
 * There is no Overview entry: the docs have no index page (founders,
 * 2026-10-15). /docs redirects to the first section here (next.config.js).
 */
function DocsNavList({ current }: { current: DocSlug }) {
  const item = (active: boolean) =>
    `group flex items-center gap-[10px] rounded-[8px] px-[10px] py-[7px] text-[14px] tracking-[-0.006em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 ${
      active ? 'bg-white/[0.06] font-normal text-white' : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-100'
    }`
  const icon = (active: boolean) =>
    `h-[15px] w-[15px] shrink-0 transition-colors duration-200 ${active ? 'text-zinc-100' : 'text-zinc-500 group-hover:text-zinc-300'}`

  return (
    <div className="flex flex-col gap-[22px]">
      {DOC_GROUPS.map((group) => (
        <div key={group.id}>
          <p className="mb-[6px] px-[10px] text-[12.5px] font-medium tracking-[-0.004em] text-zinc-500">{group.label}</p>
          <ul className="flex flex-col gap-[2px]">
            {docsInGroup(group.id).map((doc) => {
              const Icon = DOC_ICONS[doc.slug]
              const active = doc.slug === current
              return (
                <li key={doc.slug}>
                  <Link href={`/docs/${doc.slug}`} aria-current={active ? 'page' : undefined} className={item(active)}>
                    <Icon aria-hidden strokeWidth={1.75} className={icon(active)} />
                    <span className="min-w-0 truncate">{doc.title}</span>
                    {doc.tag && <DocTag className="ml-auto">{doc.tag}</DocTag>}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

/** The desktop rail, from lg up. */
export function DocsSidebar({ current }: { current: DocSlug }) {
  return (
    <nav aria-label="Documentation" className="sticky top-[100px]">
      <DocsNavList current={current} />
    </nav>
  )
}

/**
 * Below lg, the same list behind a disclosure at the top of the page, so a
 * phone reader can reach any section without scrolling to the foot of a long
 * page. A native <details>: it works without JavaScript, is keyboard operable
 * and is announced as expandable. Keyed by the page, so it is closed again
 * after a navigation instead of carrying its open state across.
 */
export function DocsMobileNav({ current }: { current: DocSlug }) {
  const doc = DOCS_BY_SLUG[current]
  const Icon = DOC_ICONS[doc.slug]

  return (
    <details
      key={current}
      className="group rounded-[8px] border border-white/[0.09] bg-[linear-gradient(180deg,rgba(255,255,255,0.028),rgba(255,255,255,0.008))] lg:hidden"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-[12px] rounded-[8px] px-[14px] py-[12px] text-[14px] text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-[10px]">
          <Icon aria-hidden strokeWidth={1.75} className="h-[15px] w-[15px] shrink-0 text-zinc-300" />
          <span className="truncate">{doc.title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-[6px] text-[13px] text-zinc-500">
          All sections
          <ChevronDown aria-hidden className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" />
        </span>
      </summary>
      <nav aria-label="Documentation" className="border-t border-white/[0.08] px-[6px] pb-[12px] pt-[16px]">
        <DocsNavList current={current} />
      </nav>
    </details>
  )
}
