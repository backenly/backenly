import Link from 'next/link'
import { Mail } from 'lucide-react'
import type { ReactNode } from 'react'
import { ScrollSpy, type SpyItem } from '@/components/site/ScrollSpy'
import { CONTAINER, HEADING, PANEL, SECONDARY_CTA, TITLE } from '@/components/site/tokens'

/* ─────────────────────────────────────────────────────────────
   The legal documents: Privacy, Terms, Refund.

   Set as documents, not as marketing: no card around every clause, one
   readable column at a comfortable measure, a contents rail that follows the
   scroll, and every heading a link to itself so a clause can be cited by URL.

   Presentation only. The words live in each page (or its data file) and are
   reproduced exactly; nothing here edits legal text.
───────────────────────────────────────────────────────────── */

/** Long-form legal copy: brighter and larger than marketing body. */
export const LEGAL_TEXT = 'text-[16px] leading-[1.8] tracking-[-0.006em] text-zinc-300 [text-wrap:pretty]'

export function LegalBody({
  toc,
  numbered = false,
  children,
}: {
  toc: SpyItem[]
  numbered?: boolean
  children: ReactNode
}) {
  return (
    <div className={`${CONTAINER} relative pb-[120px] pt-[56px] md:pt-[80px]`}>
      <div className="grid gap-12 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-16 xl:gap-24">
        <aside className="hidden lg:block">
          <div className="sticky top-[100px]">
            <p className="mb-3 text-[13px] font-medium text-zinc-500">Contents</p>
            <ScrollSpy label="Contents" items={toc} numbered={numbered} />
          </div>
        </aside>
        <div className="min-w-0 max-w-[760px]">{children}</div>
      </div>
    </div>
  )
}

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
    <section id={id} className="scroll-mt-[100px] border-t border-white/[0.08] py-10 first:border-t-0 first:pt-0">
      <h2 className={`group text-[22px] text-white md:text-[24px] ${TITLE}`}>
        <a href={`#${id}`} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
          {number !== undefined && <span className="mr-3 tabular-nums text-zinc-600">{number}.</span>}
          {title}
          <span aria-hidden className="ml-2 text-zinc-600 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            #
          </span>
        </a>
      </h2>
      <div className="mt-5 flex flex-col gap-5">{children}</div>
    </section>
  )
}

export function LegalList({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-2.5 pl-5 marker:text-zinc-600">
      {items.map((item) => (
        <li key={item} className={`pl-1.5 ${LEGAL_TEXT}`}>
          {item}
        </li>
      ))}
    </ul>
  )
}

/** The contact block and the other two policies, at the foot of each document. */
export function LegalFooter({
  title,
  body,
  email,
  current,
}: {
  title: string
  body: string
  email: string
  current: 'privacy' | 'terms' | 'refund'
}) {
  const policies = [
    { id: 'privacy', label: 'Privacy Policy', href: '/privacy' },
    { id: 'terms', label: 'Terms of Service', href: '/terms' },
    { id: 'refund', label: 'Refund Policy', href: '/refund-policy' },
  ].filter((p) => p.id !== current)

  return (
    <div className="mt-6">
      <div className={`flex flex-col gap-6 p-6 md:flex-row md:items-center md:justify-between md:p-8 ${PANEL}`}>
        <div>
          <h2 className={`text-[19px] text-white ${HEADING}`}>{title}</h2>
          <p className="mt-2 max-w-[52ch] text-[15px] leading-[1.65] text-zinc-400">{body}</p>
        </div>
        <a href={`mailto:${email}`} className={`${SECONDARY_CTA} shrink-0`}>
          <Mail aria-hidden className="h-4 w-4" />
          {email}
        </a>
      </div>
      <nav aria-label="Other policies" className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[14px]">
        {policies.map((policy) => (
          <Link
            key={policy.id}
            href={policy.href}
            className="rounded-sm text-zinc-400 underline decoration-white/20 underline-offset-4 transition-colors duration-200 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
          >
            {policy.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
