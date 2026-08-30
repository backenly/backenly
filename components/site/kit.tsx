import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import type { HTMLAttributes, ReactNode } from 'react'

type Width = 'prose' | 'default' | 'wide' | 'wide-prose'

const WIDTHS: Record<Width, string> = {
  prose: 'max-w-3xl',
  default: 'max-w-4xl',
  // Card grids, tables and two-column layouts. Below 2xl (1536px) this is
  // unchanged, so mobile, tablet and 13"/14" laptops render exactly as before.
  // At 2xl and up it steps to the 1440px container token, because the site nav
  // and the landing page already run at 100rem and a 1280px subpage under a
  // 1600px navbar reads as a mis-set column on a 16" display.
  wide: 'max-w-7xl 2xl:max-w-container',
  // Same layout width, deliberately pinned at 7xl: for `wide` sections whose
  // main column is long-form body copy, where extra width buys nothing and
  // costs line length.
  'wide-prose': 'max-w-7xl',
}

export type Crumb = { label: string; href?: string }

export function Container({
  width = 'default',
  className = '',
  children,
}: {
  width?: Width
  className?: string
  children: ReactNode
}) {
  return <div className={`${WIDTHS[width]} mx-auto px-6 ${className}`}>{children}</div>
}

export function Section({
  width = 'default',
  className = '',
  containerClassName = '',
  children,
  ...rest
}: {
  width?: Width
  className?: string
  containerClassName?: string
  children: ReactNode
} & HTMLAttributes<HTMLElement>) {
  return (
    <section className={`relative border-t border-white/[0.06] py-20 md:py-28 ${className}`} {...rest}>
      <Container width={width} className={containerClassName}>
        {children}
      </Container>
    </section>
  )
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-medium uppercase text-zinc-400">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      {children}
    </p>
  )
}

export function SectionHeading({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <h2 className={`text-3xl font-semibold leading-tight text-white md:text-[40px] ${className}`}>
      {children}
    </h2>
  )
}

export function SectionIntro({
  eyebrow,
  title,
  body,
  align = 'left',
  className = '',
}: {
  eyebrow?: ReactNode
  title: ReactNode
  body?: ReactNode
  align?: 'left' | 'center'
  className?: string
}) {
  const centered = align === 'center'
  return (
    <div className={`${centered ? 'mx-auto text-center' : ''} max-w-3xl ${className}`}>
      {eyebrow && <p className="text-sm font-semibold text-zinc-500">{eyebrow}</p>}
      <SectionHeading className={eyebrow ? 'mt-3' : ''}>{title}</SectionHeading>
      {body && <p className="mt-5 text-base leading-7 text-zinc-400">{body}</p>}
    </div>
  )
}

export function Lead({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-base leading-7 text-zinc-400 ${className}`}>{children}</p>
}

export function PrimaryButton({
  href,
  children,
  className = '',
  external = false,
}: {
  href: string
  children: ReactNode
  className?: string
  external?: boolean
}) {
  const cls = `inline-flex h-12 items-center justify-center gap-2 rounded-md bg-white px-5 text-sm font-semibold text-black transition hover:bg-zinc-200 ${className}`

  if (external) {
    const opensNewTab = href.startsWith('http')
    return (
      <a
        href={href}
        target={opensNewTab ? '_blank' : undefined}
        rel={opensNewTab ? 'noopener noreferrer' : undefined}
        className={cls}
      >
        {children}
      </a>
    )
  }

  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  )
}

export function SecondaryButton({
  href,
  children,
  className = '',
  external = false,
}: {
  href: string
  children: ReactNode
  className?: string
  external?: boolean
}) {
  const cls = `inline-flex h-12 items-center justify-center gap-2 rounded-md border border-white/12 bg-white/[0.03] px-5 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.06] ${className}`

  if (external) {
    const opensNewTab = href.startsWith('http')
    return (
      <a
        href={href}
        target={opensNewTab ? '_blank' : undefined}
        rel={opensNewTab ? 'noopener noreferrer' : undefined}
        className={cls}
      >
        {children}
      </a>
    )
  }

  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  )
}

export function Card({
  className = '',
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`rounded-lg border border-white/10 bg-white/[0.035] p-6 shadow-[0_28px_90px_-70px_rgba(255,255,255,0.24)] ${className}`}>
      {children}
    </div>
  )
}

export function LinkCard({
  href,
  className = '',
  children,
}: {
  href: string
  className?: string
  children: ReactNode
}) {
  return (
    <Link href={href} className="group block h-full">
      <article
        className={`flex h-full flex-col rounded-lg border border-white/10 bg-white/[0.035] p-6 shadow-[0_28px_90px_-76px_rgba(255,255,255,0.22)] transition group-hover:-translate-y-1 group-hover:border-white/20 group-hover:bg-white/[0.055] ${className}`}
      >
        {children}
      </article>
    </Link>
  )
}

export function IconTile({ children, size = 48 }: { children: ReactNode; size?: number }) {
  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-md border border-white/10 bg-black/35"
      style={{ width: size, height: size }}
    >
      {children}
    </div>
  )
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-zinc-400">
      {children}
    </span>
  )
}

export function ChipLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
    >
      {children}
    </Link>
  )
}

export function MutedChipLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-sm font-medium text-zinc-500 transition hover:border-white/20 hover:text-white"
    >
      {children}
    </Link>
  )
}

export function Breadcrumb({ items, width = 'default' }: { items: Crumb[]; width?: Width }) {
  return (
    <nav aria-label="Breadcrumb" className="pt-8">
      <Container width={width}>
        <ol className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          {items.map((item, index) => (
            <li key={`${item.label}-${index}`} className="flex items-center gap-2">
              {item.href ? (
                <Link href={item.href} className="hover:text-zinc-300">
                  {item.label}
                </Link>
              ) : (
                <span className="text-zinc-300">{item.label}</span>
              )}
              {index < items.length - 1 && <span className="text-zinc-700">/</span>}
            </li>
          ))}
        </ol>
      </Container>
    </nav>
  )
}

export function PageHero({
  eyebrow,
  title,
  subtitle,
  actions,
  icon,
  align = 'left',
  width = 'default',
  proof,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  icon?: ReactNode
  align?: 'left' | 'center'
  width?: Width
  proof?: { label: string; value: string }[]
}) {
  const centered = align === 'center'

  return (
    <section className="relative isolate overflow-hidden border-b border-white/10 px-0 pb-14 pt-10 md:pb-20 md:pt-14">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.035),rgba(255,255,255,0)_58%)]"
      />
      <Container width={width} className={centered ? 'flex flex-col items-center text-center' : ''}>
        {icon && <div className="mb-6">{icon}</div>}
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="mt-6 max-w-5xl text-4xl font-semibold leading-[1.05] text-white md:text-5xl lg:text-[56px]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-5 max-w-3xl text-base leading-7 text-zinc-400 md:text-[17px]">{subtitle}</p>
        )}
        {actions && (
          <div className={`mt-8 flex flex-wrap gap-3 ${centered ? 'justify-center' : ''}`}>
            {actions}
          </div>
        )}
        {proof && proof.length > 0 && (
          <dl className="mt-10 grid w-full gap-3 sm:grid-cols-3">
            {proof.map((item) => (
              <div key={item.label} className="rounded-lg border border-white/10 bg-white/[0.03] p-4 shadow-[0_22px_70px_-58px_rgba(255,255,255,0.3)]">
                <dt className="text-xs uppercase text-zinc-500">{item.label}</dt>
                <dd className="mt-1 text-sm font-semibold text-white">{item.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Container>
    </section>
  )
}

export function FaqList({ items }: { items: { q: string; a: string }[] }) {
  return (
    <div className="divide-y divide-white/[0.08] rounded-lg border border-white/10 bg-white/[0.025]">
      {items.map((item) => (
        <div key={item.q} className="p-6">
          <h3 className="text-base font-semibold text-white">{item.q}</h3>
          <p className="mt-2 text-sm leading-6 text-zinc-400">{item.a}</p>
        </div>
      ))}
    </div>
  )
}

export function CtaSection({
  title,
  body,
  children,
}: {
  title: ReactNode
  body: ReactNode
  children: ReactNode
}) {
  return (
    <section className="px-6 py-20 md:py-28">
      <div className="mx-auto max-w-4xl rounded-lg border border-white/10 bg-white/[0.035] px-6 py-14 text-center md:px-12">
        <h2 className="text-3xl font-semibold leading-tight text-white md:text-5xl">{title}</h2>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-zinc-400">{body}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">{children}</div>
      </div>
    </section>
  )
}

export function ChipRow({ label, children }: { label?: ReactNode; children: ReactNode }) {
  return (
    <div>
      {label && <p className="mb-3 text-sm text-zinc-500">{label}</p>}
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

export function InlineArrow() {
  return <ArrowRight className="h-4 w-4" aria-hidden="true" />
}
