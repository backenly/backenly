'use client'

import { useId, useState } from 'react'
import { Plus } from 'lucide-react'
import { BODY, HEADING, MEASURE } from '@/components/site/tokens'

export type FaqEntry = { q: string; a: string }

/**
 * The landing page's accordion, shared by every subpage. One question open at
 * a time, the first open by default, so the list never lands as a wall of
 * closed rows.
 *
 * Every answer stays in the DOM, collapsed with a grid-rows transition rather
 * than unmounted, so the FAQPage structured data each page emits describes
 * text that is actually on the page. A closed answer is `invisible`, which
 * also takes it out of the accessibility tree and the tab order.
 *
 * CSS only: no animation library, and the reduced-motion preference is honoured
 * by the `motion-reduce:` variant without any hydration branch.
 */
export function Faq({ items, defaultOpen = 0 }: { items: FaqEntry[]; defaultOpen?: number | null }) {
  const [openIndex, setOpenIndex] = useState<number | null>(defaultOpen)

  return (
    <div className="border-t border-white/[0.08]">
      {items.map((item, index) => (
        <FaqItem
          key={item.q}
          item={item}
          open={openIndex === index}
          onToggle={() => setOpenIndex(openIndex === index ? null : index)}
        />
      ))}
    </div>
  )
}

function FaqItem({ item, open, onToggle }: { item: FaqEntry; open: boolean; onToggle: () => void }) {
  const panelId = useId()

  return (
    <div className="border-b border-white/[0.08]">
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="group flex w-full cursor-pointer items-center justify-between gap-6 py-6 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30 md:py-7"
        >
          <span
            className={`min-w-0 text-[16px] transition-colors duration-200 md:text-[18px] ${HEADING} ${
              open ? 'text-white' : 'text-zinc-300 group-hover:text-white'
            }`}
          >
            {item.q}
          </span>
          <span
            aria-hidden
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-[transform,border-color,background-color] duration-300 motion-reduce:transition-none ${
              open ? 'rotate-45 border-white/25 bg-white/[0.06]' : 'border-white/[0.10] group-hover:border-white/25'
            }`}
          >
            <Plus className="h-3.5 w-3.5 text-zinc-300" />
          </span>
        </button>
      </h3>
      <div
        id={panelId}
        className={`grid transition-[grid-template-rows,opacity,visibility] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
          open ? 'visible grid-rows-[1fr] opacity-100' : 'invisible grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <p className={`${MEASURE} pb-7 pr-12 ${BODY} text-zinc-400 [text-wrap:pretty]`}>{item.a}</p>
        </div>
      </div>
    </div>
  )
}
