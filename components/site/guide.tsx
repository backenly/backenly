import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { ICON_CHIP, READ, ROW_RULE } from '@/components/docs/tokens'
import { ButtonLink, Trail } from '@/components/site/kit'
import { ScrollSpy, type SpyItem } from '@/components/site/ScrollSpy'
import { StartButton } from '@/components/site/StartButton'
import { CONTAINER, DISPLAY, HEADING, PANEL, PROSE_LINK, TITLE } from '@/components/site/tokens'

/* ─────────────────────────────────────────────────────────────
   The guides (/guides/*): long technical reads.

   Set as the site's other documents are, the docs pages and the legal pages
   (app/docs/[slug]/page.tsx, components/site/legal.tsx): the docs header
   (crumb, icon chip, gradient title, summary, meta line), the page at a
   reading measure, sections under linkable headings with the docs' dot rows,
   and "On this page" following the scroll at xl. There is no left column: the
   guides are few and link each other at their foot.

   Presentation only. Each guide keeps its words and facts in its own
   content file, held to the code by its conformance test.
───────────────────────────────────────────────────────────── */

/** Long-form guide copy: the docs pages' reading prose. */
export const GUIDE_TEXT = READ

/** "October 24, 2026", the docs' date format (app/docs/content.ts DOCS_UPDATED). */
export function guideDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** The docs' list marker: a small dot on the first line of 15–16px copy. */
function Dot() {
  return <span aria-hidden className="mt-[11px] h-[4px] w-[4px] shrink-0 rounded-full bg-zinc-600" />
}

/**
 * One guide, laid out like a docs page. `crumb` is the guide's short name in
 * the trail; `meta` is the line under the summary; `toc` lists the sections
 * in order, by the ids their `GuideSection`s use.
 */
export function GuideDocument({
  icon: Icon,
  title,
  crumb,
  summary,
  meta,
  toc,
  close,
  children,
}: {
  icon: LucideIcon
  title: string
  crumb: string
  summary: ReactNode
  meta: ReactNode
  toc: SpyItem[]
  /** The closing panel's line under "Try it on a live project". */
  close: string
  children: ReactNode
}) {
  return (
    <>
      {/* Key light, as on every page, behind the title. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[260px] left-[-12%] h-[820px] w-[1100px] max-w-none bg-[radial-gradient(closest-side,rgba(255,255,255,0.06),transparent)]"
      />

      <div className={`${CONTAINER} relative pb-[120px] pt-[28px] md:pt-[48px]`}>
        <div className="grid gap-[40px] xl:grid-cols-[minmax(0,760px)_200px] xl:justify-between">
          <article className="min-w-0 max-w-[760px] lg:pt-[4px]">
            <header className={`hero-enter border-b pb-[36px] ${ROW_RULE}`}>
              <Trail
                readable
                items={[
                  { label: 'Home', href: '/' },
                  // Not a link: there is no guides index yet.
                  { label: 'Guides' },
                  { label: crumb },
                ]}
              />
              <div className="mt-[28px] flex items-center gap-[14px]">
                <span className={`h-[44px] w-[44px] rounded-[8px] text-zinc-200 ${ICON_CHIP}`}>
                  <Icon aria-hidden strokeWidth={1.75} className="h-[20px] w-[20px]" />
                </span>
                <h1
                  className={`min-w-0 bg-gradient-to-b from-white from-40% to-zinc-400 bg-clip-text pb-[4px] text-[34px] text-transparent sm:text-[40px] md:text-[46px] ${DISPLAY}`}
                >
                  {title}
                </h1>
              </div>
              <p className="mt-[20px] max-w-[64ch] text-[17px] leading-[1.65] tracking-[-0.012em] text-zinc-400 [text-wrap:pretty] md:text-[18px]">
                {summary}
              </p>
              <p className="mt-[20px] flex flex-wrap items-center gap-x-[12px] gap-y-[4px] text-[13px] text-zinc-400">
                {meta}
              </p>
            </header>

            <div className="mt-[48px] flex flex-col gap-[64px]">{children}</div>

            {/* The docs' closing panel shape (components/site/legal.tsx LegalContact), with the ask. */}
            <div
              className={`mt-[72px] flex flex-col gap-[20px] p-[20px] md:flex-row md:items-center md:justify-between md:p-[24px] ${PANEL}`}
            >
              <div className="min-w-0">
                <p className={`text-[16px] text-white ${HEADING}`}>Try it on a live project</p>
                <p className="mt-[6px] max-w-[52ch] text-[15px] leading-[1.65] text-zinc-400 [text-wrap:pretty]">{close}</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-[10px]">
                <StartButton />
                <ButtonLink href="/docs/connect" variant="secondary">
                  Connect your agent
                </ButtonLink>
              </div>
            </div>
          </article>

          <aside className="hidden xl:block">
            <div className="sticky top-[100px] pt-[4px]">
              <p className="mb-[12px] text-[13px] font-medium text-zinc-400">On this page</p>
              <ScrollSpy label="On this page" items={toc} readable />
            </div>
          </aside>
        </div>
      </div>
    </>
  )
}

/** The meta line's divider, as on a docs page. Hidden on a phone, where the items stack. */
export function GuideMetaDivider() {
  return <span aria-hidden className="hidden h-[12px] w-px bg-white/[0.12] sm:block" />
}

/** One section under the docs' linkable heading. */
export function GuideSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-[100px]">
      <h2 id={`${id}-heading`} className={`group text-[23px] text-white md:text-[26px] ${TITLE}`}>
        <a href={`#${id}`} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
          {title}
          <span aria-hidden className="ml-[8px] text-zinc-600 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            #
          </span>
        </a>
      </h2>
      <div className="mt-[20px] flex flex-col gap-[20px]">{children}</div>
    </section>
  )
}

/** A sub-heading inside a section. */
export function GuideSubHeading({ children }: { children: ReactNode }) {
  return <h3 className={`mt-[12px] text-[17px] text-white ${HEADING}`}>{children}</h3>
}

/** The docs' "Good to know" rows: a dot, a hairline under each. */
export function GuideRows({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className={`border-t ${ROW_RULE}`}>
      {items.map((item, index) => (
        <li key={index} className={`flex gap-[12px] border-b py-[16px] ${ROW_RULE}`}>
          <Dot />
          <span className={`min-w-0 ${READ}`}>{item}</span>
        </li>
      ))}
    </ul>
  )
}

/** A source line under a table or a passage. */
export function GuideSourceLine({ children }: { children: ReactNode }) {
  return <p className="text-[14px] leading-[1.65] text-zinc-400">{children}</p>
}

/** A link to a source, opened in a new tab. */
export function GuideSource({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={PROSE_LINK}>
      {children}
    </a>
  )
}

/** Inline code in guide prose. */
export function GuideCode({ children }: { children: string }) {
  return <code className="font-mono text-[13px] text-zinc-200">{children}</code>
}
