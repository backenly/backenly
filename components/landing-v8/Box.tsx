import type { ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { ArrowRight, type LucideIcon } from 'lucide-react'
import { WRAP } from './tokens'

/* ─────────────────────────────────────────────────────────────
   The box (founders, 2026-11-14, with Blaxel's feature sections: "make
   everything boxes except the hero ... these kind of professional boxes for
   explaining each stuff"). Every product section below the hero is one
   framed box; the FAQ and the closing sit on the page (founders, 2026-11-15:
   "these sections dont need boxes"):

     head    a tag (the product area, with its icon), a heading in the
             display face at regular weight, one short paragraph, and the
             section's picture: beside the words ("split") or under them
             when the picture needs the width ("stacked")
     cells   a row of parts split by hairlines: an icon and a name, one
             sentence, and where to read more

   One frame, one border weight, one radius for every box; the cells share the
   frame's hairline instead of being cards of their own. Corners are squarer
   (founders, 2026-11-15: "too much rounded, make it a little more squarey"):
   10px for a box, 8px for a picture inside one.

   Light (founders, 2026-11-15: the boxes were "full black", "use colors like
   Blaxel"): each box is lit the way Blaxel lights a section, a painted band
   of light under a film grain, fading into the box before its cells. The
   paintings are Backenly's own (violet with a lilac core, magenta on one edge,
   indigo-blue on the other: the hero's dawn), painted by a script, three
   shapes, each box placing one so neighbours differ. The figures and cells
   stay dark panels on top, so the light frames the proof and never sits
   under small text.
───────────────────────────────────────────────────────────── */

export type BoxLight = {
  /** Which painting: a rises to the top right, b crosses the top, c falls from the top left. */
  art: 'a' | 'b' | 'c'
  /** Mirror it, so neighbouring boxes lean opposite ways. */
  flip?: boolean
  /** Where the painting sits in the lit area (object-position). */
  at?: string
  /** How much of the box's top it lights before fading out, in px. */
  reach?: number
}

const HEAD_MASK = 'linear-gradient(to bottom, rgba(0,0,0,0.45) 0px, rgba(0,0,0,0.45) 240px, #000 400px, #000 68%, transparent 100%)'

function Light({ art, flip = false, at = 'center', reach = 820 }: BoxLight) {
  const area = { height: `min(100%, ${reach}px)`, maskImage: HEAD_MASK, WebkitMaskImage: HEAD_MASK }
  return (
    <>
      {/* Softer behind the words at the top (body text keeps 4.5:1 over the brightest streak), full around the figure, gone before the cells. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-hidden" style={area}>
        <Image
          src={`/media/v8/light/light-${art}.webp`}
          alt=""
          fill
          unoptimized
          sizes="100vw"
          className={`object-cover ${flip ? '-scale-x-100' : ''}`}
          style={{ objectPosition: at }}
        />
      </div>
      {/* The grain sits beside the light, not inside it: inside an isolated layer it cannot blend with the box and would only grey the black. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 bg-[url('/media/v8/light/grain.svg')] opacity-[0.28] mix-blend-soft-light" style={area} />
    </>
  )
}

export function Box({ id, children, className = '', light }: { id: string; children: ReactNode; className?: string; light?: BoxLight }) {
  return (
    <section aria-labelledby={id} className={`relative pt-[64px] md:pt-[96px] ${className}`}>
      <div className={WRAP}>
        <div className="relative isolate overflow-hidden rounded-[10px] border border-white/[0.10] bg-[#0b0c0f] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
          {light && <Light {...light} />}
          {children}
        </div>
      </div>
    </section>
  )
}

export function Tag({ icon: TagIcon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex h-[30px] items-center gap-[8px] rounded-[7px] border border-violet-300/[0.14] bg-violet-400/[0.08] px-[10px] text-[14px] font-medium tracking-[-0.006em] text-violet-200">
      <TagIcon aria-hidden className="h-[15px] w-[15px] text-violet-300" strokeWidth={1.75} />
      {children}
    </span>
  )
}

export const BOX_TITLE =
  'text-[32px] font-normal leading-[1.08] tracking-[-0.035em] text-white [text-wrap:balance] sm:text-[40px] lg:text-[48px] lg:leading-[1.04]'

export const BOX_BODY = 'text-[16px] leading-[1.6] text-zinc-300 [text-wrap:pretty] md:text-[17px]'

type Head = {
  id: string
  tag: { icon: LucideIcon; label: string }
  title: ReactNode
  body: ReactNode
  /** Anything under the paragraph: facts, a link. */
  extra?: ReactNode
  visual: ReactNode
  layout?: 'split' | 'stacked'
}

export function BoxHead({ id, tag, title, body, extra, visual, layout = 'split' }: Head) {
  if (layout === 'stacked') {
    return (
      <div className="p-[24px] sm:p-[32px] lg:p-[48px]">
        <div className="grid gap-[20px] lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-end lg:gap-[48px]">
          <div>
            <Tag icon={tag.icon}>{tag.label}</Tag>
            <h2 id={id} className={`mt-[24px] ${BOX_TITLE}`}>
              {title}
            </h2>
          </div>
          <div>
            <p className={BOX_BODY}>{body}</p>
            {extra}
          </div>
        </div>
        <div className="mt-[36px] lg:mt-[44px]">{visual}</div>
      </div>
    )
  }
  return (
    <div className="grid gap-[36px] p-[24px] sm:p-[32px] lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-[48px] lg:p-[48px]">
      <div className="lg:py-[24px]">
        <Tag icon={tag.icon}>{tag.label}</Tag>
        <h2 id={id} className={`mt-[24px] ${BOX_TITLE}`}>
          {title}
        </h2>
        <p className={`mt-[20px] max-w-[46ch] ${BOX_BODY}`}>{body}</p>
        {extra}
      </div>
      {visual}
    </div>
  )
}

export type CellItem = {
  icon: LucideIcon
  title: string
  body: ReactNode
  href?: string
  /** The link's words; defaults to "Read the docs". */
  link?: string
  /** A small figure under the sentence (the platform's line art). */
  figure?: ReactNode
  /** A photograph across the top of the cell, edge to edge. */
  photo?: ReactNode
}

export function Cells({ items, cols = 4 }: { items: CellItem[]; cols?: 3 | 4 }) {
  return (
    <ul className={`grid gap-px border-t border-white/[0.10] bg-white/[0.08] sm:grid-cols-2 ${cols === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
      {items.map((item) => (
        <Cell key={item.title} {...item} />
      ))}
    </ul>
  )
}

function Cell({ icon: CellIcon, title, body, href, link = 'Read the docs', figure, photo }: CellItem) {
  const external = href?.startsWith('http')
  return (
    <li className="flex flex-col bg-[#0b0c0f]">
      {photo}
      <div className="flex flex-1 flex-col p-[24px] lg:p-[28px]">
      <div className="flex items-center gap-[10px]">
        <CellIcon aria-hidden className="h-[17px] w-[17px] shrink-0 text-zinc-300" strokeWidth={1.75} />
        <h3 className="text-[16px] font-medium tracking-[-0.012em] text-white">{title}</h3>
      </div>
      <p className="mt-[12px] text-[15px] leading-[1.6] text-zinc-400 [text-wrap:pretty]">{body}</p>
      {/* Figures share one floor across a row, as in the v7 bento. */}
      {figure && <div className="mt-auto pt-[24px]">{figure}</div>}
      {href && (
        <Link
          href={href}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          className={`group ${figure ? '' : 'mt-auto'} inline-flex w-fit items-center gap-[8px] rounded-[3px] pt-[20px] text-[14.5px] font-medium text-zinc-100 transition-colors duration-150 [@media(hover:hover)_and_(pointer:fine)]:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70`}
        >
          {link}
          <ArrowRight aria-hidden className="h-[15px] w-[15px] text-violet-300 transition-transform duration-150 [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-[3px]" />
          {external && <span className="sr-only"> (opens in a new tab)</span>}
        </Link>
      )}
      </div>
    </li>
  )
}
