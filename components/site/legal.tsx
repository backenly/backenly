import Link from 'next/link'
import { ArrowLeft, ArrowRight, ChevronDown, FileText, Mail, Receipt, ShieldCheck, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { ICON_CHIP, READ, ROW_RULE } from '@/components/docs/tokens'
import { ScrollSpy, type SpyItem } from '@/components/site/ScrollSpy'
import { Trail } from '@/components/site/kit'
import { CONTAINER, DISPLAY, HEADING, PANEL, SECONDARY_CTA, TITLE } from '@/components/site/tokens'

/* ─────────────────────────────────────────────────────────────
   The legal documents: Privacy, Terms, Refund.

   Set exactly as the docs pages are (app/docs/[slug]/page.tsx), because they
   are the site's other documents (2026-10-23, founders: match the landing and
   the rest of the site's design). The same three columns: the documents on
   the left, grouped like the docs sidebar with an icon each; the document at
   a reading measure in the middle, opening on the docs header (crumb, icon
   chip, gradient title, summary, meta line); "On this page" on the right,
   following the scroll. The same section headings with their anchor, the
   same prose and the same dot bullets, and a previous/next pager at the foot.

   Presentation only. The words live in each page (or its data file) and are
   reproduced exactly; nothing here edits legal text.
───────────────────────────────────────────────────────────── */

/** Long-form legal copy: the docs pages' reading prose. */
export const LEGAL_TEXT = READ

type PolicyId = 'privacy' | 'terms' | 'refund'

/** The three documents, in reading order. The order is also the pager's. */
const POLICIES: { id: PolicyId; title: string; href: string; icon: LucideIcon }[] = [
  { id: 'privacy', title: 'Privacy Policy', href: '/privacy', icon: ShieldCheck },
  { id: 'terms', title: 'Terms of Service', href: '/terms', icon: FileText },
  { id: 'refund', title: 'Refund Policy', href: '/refund-policy', icon: Receipt },
]

function policy(id: PolicyId) {
  return POLICIES.find((p) => p.id === id)!
}

/** The docs' list marker: a small dot on the first line of 15–16px copy. */
function Dot() {
  return <span aria-hidden className="mt-[11px] h-[4px] w-[4px] shrink-0 rounded-full bg-zinc-600" />
}

/**
 * One legal document, laid out like a docs page. `meta` is the line under the
 * summary (the effective or last-updated date); `numbered` numbers the
 * contents for documents whose sections are numbered.
 */
export function LegalDocument({
  current,
  summary,
  meta,
  toc,
  numbered = false,
  children,
}: {
  current: PolicyId
  summary: ReactNode
  meta: ReactNode
  toc: SpyItem[]
  numbered?: boolean
  children: ReactNode
}) {
  const doc = policy(current)
  const Icon = doc.icon

  return (
    <>
      {/* Key light, as on every page, behind the title. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[260px] left-[-12%] h-[820px] w-[1100px] max-w-none bg-[radial-gradient(closest-side,rgba(255,255,255,0.06),transparent)]"
      />

      <div className={`${CONTAINER} relative pb-[120px] pt-[28px] md:pt-[48px]`}>
        <div className="grid gap-[40px] lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-[48px] xl:grid-cols-[232px_minmax(0,1fr)_200px] xl:gap-[64px]">
          <div className="hidden border-r border-white/[0.06] pr-[20px] lg:block">
            <nav aria-label="Legal documents" className="sticky top-[100px]">
              <PolicyList current={current} />
            </nav>
          </div>

          <article className="min-w-0 max-w-[760px] lg:pt-[4px]">
            <PolicyMenu current={current} />

            <header className={`hero-enter mt-[28px] border-b pb-[36px] lg:mt-0 ${ROW_RULE}`}>
              <Trail
                readable
                items={[
                  { label: 'Home', href: '/' },
                  // Not a link: there is no legal index page; the list beside this is the map.
                  { label: 'Legal' },
                  { label: doc.title },
                ]}
              />
              <div className="mt-[28px] flex items-center gap-[14px]">
                <span className={`h-[44px] w-[44px] rounded-[8px] text-zinc-200 ${ICON_CHIP}`}>
                  <Icon aria-hidden strokeWidth={1.75} className="h-[20px] w-[20px]" />
                </span>
                <h1
                  className={`min-w-0 bg-gradient-to-b from-white from-40% to-zinc-400 bg-clip-text pb-[4px] text-[34px] text-transparent sm:text-[40px] md:text-[46px] ${DISPLAY}`}
                >
                  {doc.title}
                </h1>
              </div>
              <p className="mt-[20px] max-w-[64ch] text-[17px] leading-[1.65] tracking-[-0.012em] text-zinc-400 [text-wrap:pretty] md:text-[18px]">
                {summary}
              </p>
              <p className="mt-[20px] flex flex-wrap items-center gap-x-[12px] gap-y-[4px] text-[13px] text-zinc-400">
                {meta}
              </p>
            </header>

            <div className="mt-[48px] flex flex-col gap-[56px]">{children}</div>

            <PolicyPager current={current} />
          </article>

          <div className="hidden xl:block">
            <div className="sticky top-[100px] pt-[4px]">
              <p className="mb-[12px] text-[13px] font-medium text-zinc-400">On this page</p>
              <ScrollSpy label="On this page" items={toc} numbered={numbered} readable />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * The meta line's divider, as on a docs page. Hidden on a phone, where the two
 * items stack and a divider would hang at the end of the first line.
 */
export function MetaDivider() {
  return <span aria-hidden className="hidden h-[12px] w-px bg-white/[0.12] sm:block" />
}

/**
 * One section, with a heading that links to itself so a clause can be cited by
 * URL: the docs' section heading, numbered where the document is.
 */
export function LegalSection({
  id,
  title,
  number,
  children,
}: {
  id: string
  title: string
  number?: number
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-[100px]">
      <h2 id={`${id}-heading`} className={`group text-[23px] text-white md:text-[26px] ${TITLE}`}>
        <a href={`#${id}`} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
          {number !== undefined && <span className="mr-[10px] tabular-nums text-zinc-500">{number}.</span>}
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

/** A list in a legal document, with the docs' dot. */
export function LegalList({ items, size = 'read' }: { items: string[]; size?: 'read' | 'small' }) {
  const text =
    size === 'read'
      ? 'text-[16px] leading-[1.75] tracking-[-0.006em]'
      : 'text-[15px] leading-[1.7]'
  return (
    <ul className="flex flex-col gap-[10px]">
      {items.map((item) => (
        <li key={item} className={`flex max-w-[68ch] gap-[12px] text-zinc-300 [text-wrap:pretty] ${text}`}>
          <Dot />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  )
}

/** A short list set apart in a panel: the docs' "For example" block. */
export function LegalPanel({ title, items }: { title: string; items: string[] }) {
  return (
    <div className={`p-[20px] md:p-[24px] ${PANEL}`}>
      <p className={`text-[15px] text-white ${HEADING}`}>{title}</p>
      <div className="mt-[12px]">
        <LegalList items={items} size="small" />
      </div>
    </div>
  )
}

/** Who to write to, at the foot of each document. */
export function LegalContact({ title, body, email }: { title: string; body: string; email: string }) {
  return (
    <div className={`flex flex-col gap-[20px] p-[20px] md:flex-row md:items-center md:justify-between md:p-[24px] ${PANEL}`}>
      <div className="min-w-0">
        <p className={`text-[16px] text-white ${HEADING}`}>{title}</p>
        <p className="mt-[6px] max-w-[52ch] text-[15px] leading-[1.65] text-zinc-400 [text-wrap:pretty]">{body}</p>
      </div>
      <a href={`mailto:${email}`} className={`${SECONDARY_CTA} shrink-0`}>
        <Mail aria-hidden className="h-4 w-4" />
        {email}
      </a>
    </div>
  )
}

/* ── Navigation ──────────────────────────────────────────────────────────── */

/** The three documents, set like the docs sidebar: an icon each, the current one lit. */
function PolicyList({ current }: { current: PolicyId }) {
  return (
    <div>
      <p className="mb-[6px] px-[10px] text-[12.5px] font-medium tracking-[-0.004em] text-zinc-400">Legal</p>
      <ul className="flex flex-col gap-[2px]">
        {POLICIES.map((p) => {
          const Icon = p.icon
          const active = p.id === current
          return (
            <li key={p.id}>
              <Link
                href={p.href}
                aria-current={active ? 'page' : undefined}
                className={`group flex items-center gap-[10px] rounded-[8px] px-[10px] py-[7px] text-[14px] tracking-[-0.006em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 ${
                  active ? 'bg-white/[0.06] font-normal text-white' : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-100'
                }`}
              >
                <Icon
                  aria-hidden
                  strokeWidth={1.75}
                  className={`h-[15px] w-[15px] shrink-0 transition-colors duration-200 ${
                    active ? 'text-zinc-100' : 'text-zinc-500 group-hover:text-zinc-300'
                  }`}
                />
                <span className="min-w-0 truncate">{p.title}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Below lg, the same list behind a disclosure at the top of the document, as
 * on a docs page. A native <details>: no JavaScript, keyboard operable, and
 * announced as expandable.
 */
function PolicyMenu({ current }: { current: PolicyId }) {
  const doc = policy(current)
  const Icon = doc.icon
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
        <span className="flex shrink-0 items-center gap-[6px] text-[13px] text-zinc-400">
          All policies
          <ChevronDown aria-hidden className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" />
        </span>
      </summary>
      <nav aria-label="Legal documents" className="border-t border-white/[0.08] px-[6px] pb-[12px] pt-[16px]">
        <PolicyList current={current} />
      </nav>
    </details>
  )
}

/** Previous and next document, the docs pager. */
function PolicyPager({ current }: { current: PolicyId }) {
  const index = POLICIES.findIndex((p) => p.id === current)
  const previous = index > 0 ? POLICIES[index - 1] : undefined
  const next = index < POLICIES.length - 1 ? POLICIES[index + 1] : undefined
  const pager = `group flex min-w-0 flex-col gap-[8px] p-[20px] transition-colors duration-200 hover:border-white/[0.13] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${PANEL}`

  return (
    <nav aria-label="Previous and next document" className="mt-[72px] grid gap-[12px] sm:grid-cols-2">
      {previous ? (
        <Link href={previous.href} className={pager}>
          <span className="inline-flex items-center gap-[6px] text-[13px] text-zinc-400">
            <ArrowLeft aria-hidden className="h-[14px] w-[14px] transition-transform duration-200 group-hover:-translate-x-0.5" />
            Previous
          </span>
          <span className={`text-[16px] text-white ${HEADING}`}>{previous.title}</span>
        </Link>
      ) : (
        <span className="hidden sm:block" />
      )}
      {next && (
        <Link href={next.href} className={`${pager} items-end text-right`}>
          <span className="inline-flex items-center gap-[6px] text-[13px] text-zinc-400">
            Next
            <ArrowRight aria-hidden className="h-[14px] w-[14px] transition-transform duration-200 group-hover:translate-x-0.5" />
          </span>
          <span className={`text-[16px] text-white ${HEADING}`}>{next.title}</span>
        </Link>
      )}
    </nav>
  )
}
