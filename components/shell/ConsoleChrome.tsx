'use client'

/**
 * ConsoleChrome: the parts both console frames share.
 *
 * OrgShell (account level: Projects, Usage, Members, Billing, Settings) and
 * ProjectShell (everything under a project) used to carry their own copies of
 * the sidebar, the account menu and the mobile drawer, and the copies had
 * drifted. They now compose from this file, so the two levels are one product.
 *
 * The composition (see components/console/tokens.ts):
 *
 *   ┌ chrome: one night surface ────────────────────────────────────────┐
 *   │ ◆  /  account  /  project ▾                 ⌘K  ⎔  Ask  Connect (A) │
 *   │ nav        ╭──────────────── lit edge ─────────────────╮            │
 *   │ nav        │ canvas: the page                          │            │
 *   │ nav        │                                           │            │
 *   │            ╰───────────────────────────────────────────╯            │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * The document is the scroller (the canvas grows with its page), because
 * Next resets DOCUMENT scroll on navigation; an inner scroll container would
 * carry one page's scroll position into the next.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight, LogOut, Menu, Search, Settings, X, type LucideIcon } from 'lucide-react'
import { Logo } from '@/components/Logo'
import { signOut } from '@/lib/api/auth'
import { useMobileNavStore } from '@/lib/stores/use-mobile-nav-store'
import { openCommandPalette } from '@/components/app/CommandPalette'
import { Kbd, MenuItem, MenuPanel, MenuSeparator, Skeleton, useDismiss } from '@/components/inspector/kit'
import { CANVAS, CHROME, FOCUS, R_CONTROL } from '@/components/console/tokens'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { OrgSwitcher } from '@cloud/org-switcher'

/* ── Frame ─────────────────────────────────────────────────────────────── */

export function ConsoleFrame({
  bar,
  sidebar,
  children,
  rightInset = false,
  drawerLabel = 'Navigation',
}: {
  bar: ReactNode
  /** The sidebar's navigation. Rendered in the desktop rail and the phone drawer. */
  sidebar: ReactNode
  children: ReactNode
  /** Reserve room on the right for the assistant panel (lg+). */
  rightInset?: boolean
  drawerLabel?: string
}) {
  const pathname = usePathname()
  const isMobileNavOpen = useMobileNavStore((s) => s.isOpen)
  const closeMobileNav = useMobileNavStore((s) => s.close)

  // The drawer closes on navigation and on Escape, and the page behind it
  // stops scrolling while it is open.
  useEffect(() => {
    closeMobileNav()
  }, [pathname, closeMobileNav])

  useEffect(() => {
    if (!isMobileNavOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMobileNav()
    }
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [isMobileNavOpen, closeMobileNav])

  return (
    <div className={`min-h-screen ${CHROME} text-zinc-100 [color-scheme:dark]`}>
      <a
        href="#console-main"
        className="sr-only z-[60] rounded-md bg-white px-3 py-2 text-[13px] font-semibold text-black focus:not-sr-only focus:fixed focus:left-3 focus:top-2"
      >
        Skip to content
      </a>

      {bar}

      {/* Desktop rail. Same surface as the bar: the chrome is one piece, and
          the canvas's own edge is what separates it from the work. */}
      <aside
        aria-label="Sidebar"
        className={`fixed bottom-0 left-0 top-[var(--console-bar)] z-20 hidden w-[240px] flex-col ${CHROME} md:flex`}
      >
        {sidebar}
      </aside>

      {/* Phone drawer */}
      <AnimatePresence>
        {isMobileNavOpen && (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label={drawerLabel}>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 top-[var(--console-bar)] bg-black/60"
              onClick={closeMobileNav}
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 34, stiffness: 360, mass: 0.8 }}
              className={`absolute bottom-0 left-0 top-[var(--console-bar)] flex w-[284px] max-w-[86vw] flex-col overscroll-contain border-r border-white/[0.07] ${CHROME} pb-[env(safe-area-inset-bottom)] shadow-[24px_0_60px_-20px_rgba(0,0,0,0.9)]`}
            >
              {sidebar}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      {/* The canvas */}
      <div
        className={`pt-[var(--console-bar)] md:pb-[var(--console-gap)] md:pl-[240px] md:pr-[var(--console-gap)] ${
          rightInset ? 'lg:pr-[388px]' : ''
        } transition-[padding] duration-200`}
      >
        <main
          id="console-main"
          tabIndex={-1}
          className={`console-canvas-min relative ${CANVAS} focus:outline-none md:rounded-[14px] md:border md:border-white/[0.07] md:shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_30px_80px_-40px_rgba(0,0,0,0.9)]`}
        >
          <LitEdge />
          <div key={pathname} className="console-enter relative">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}

/**
 * The canvas's lit top edge: the landing page's horizon line (the hairline
 * the hero film sits under), carried into the product. It is the one
 * decorative element in the console, so it stays faint.
 */
function LitEdge() {
  // No z-index, and nothing between here and the page may add one: a stacking
  // context on the canvas would trap every page dialog beneath the chrome.
  // Painting order alone puts this behind the page, which is where it belongs.
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 hidden h-[90px] overflow-hidden md:block md:rounded-t-[14px]">
      <div className="absolute inset-x-[14%] top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(196,181,253,0.35)_28%,rgba(255,255,255,0.55)_50%,rgba(196,181,253,0.35)_72%,transparent)]" />
      <div className="absolute left-1/2 top-[-60px] h-[120px] w-[62%] -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(167,139,250,0.07),transparent)]" />
    </div>
  )
}

/* ── Top bar pieces ────────────────────────────────────────────────────── */

export function ConsoleBar({ children }: { children: ReactNode }) {
  return (
    <header
      className={`fixed inset-x-0 top-0 z-30 flex h-[var(--console-bar)] items-center gap-1 ${CHROME} px-2 sm:px-3`}
    >
      {children}
    </header>
  )
}

export function BrandHome({ href = '/app' }: { href?: string }) {
  return (
    <Link
      href={href}
      aria-label="Backenly home"
      className={`flex h-[32px] flex-shrink-0 items-center gap-2 rounded-[8px] px-1.5 ${FOCUS}`}
    >
      <span className="block h-[22px] w-[22px] overflow-hidden rounded-[6px] [&_svg]:h-[22px] [&_svg]:w-[22px]">
        <Logo />
      </span>
    </Link>
  )
}

/** The breadcrumb separator. */
export function Crumb() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 flex-shrink-0 text-zinc-700" fill="none">
      <path d="M10.5 2.5 5.5 13.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

export function MobileNavButton() {
  const isOpen = useMobileNavStore((s) => s.isOpen)
  const toggle = useMobileNavStore((s) => s.toggle)
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isOpen ? 'Close navigation' : 'Open navigation'}
      aria-expanded={isOpen}
      className={`inline-flex h-[40px] w-[40px] flex-shrink-0 items-center justify-center ${R_CONTROL} text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 md:hidden ${FOCUS}`}
    >
      {isOpen ? <X className="h-[18px] w-[18px]" /> : <Menu className="h-[18px] w-[18px]" />}
    </button>
  )
}

/** Opens the ⌘K palette. A button, because it looked like one and did nothing. */
export function SearchTrigger() {
  const [isMac, setIsMac] = useState(true)
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))
  }, [])
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-label="Search and jump to"
      className={`group hidden h-[30px] items-center gap-2 ${R_CONTROL} border border-white/[0.08] bg-white/[0.03] pl-2.5 pr-1.5 text-[12.5px] text-faint transition-colors hover:border-white/[0.13] hover:text-zinc-300 lg:inline-flex ${FOCUS}`}
    >
      <Search className="h-3.5 w-3.5" strokeWidth={2} />
      <span className="pr-6">Search</span>
      <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
      <Kbd className="-ml-1">K</Kbd>
    </button>
  )
}

/* ── Menus ─────────────────────────────────────────────────────────────── */
// The menu primitives live in the kit so any page can use them; re-exported
// here for the shell's own call sites.
export { useDismiss, MenuPanel, MenuItem, MenuSeparator } from '@/components/inspector/kit'

/* ── Account menu ──────────────────────────────────────────────────────── */

export interface MeUser {
  name?: string | null
  email?: string
  /** The Google account's own photo; null for every other account. */
  avatarUrl?: string | null
}

let cachedUser: MeUser | null = null

/** The signed-in platform user, fetched once per page load and shared. */
export function useMe(): MeUser | null {
  const [user, setUser] = useState<MeUser | null>(cachedUser)
  useEffect(() => {
    if (cachedUser) return
    let cancelled = false
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user && !cancelled) {
          cachedUser = d.user
          setUser(d.user)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return user
}

// Built at run time: the type-check target (ES5) refuses `u`-flag literals.
const LETTER = new RegExp('\\p{L}', 'u')
const ONE_CHARACTER_SCRIPTS = new RegExp('[\\p{Script=Han}\\p{Script=Hangul}\\p{Script=Hiragana}\\p{Script=Katakana}]', 'u')

/**
 * The avatar's letters: the first letter of the name's first two words, or one
 * character for a Chinese, Japanese or Korean name, as Google draws it. Only
 * the name itself counts: a Google Workspace name often carries a department
 * after a bar ("Name | Department | School"), and the bar used to be drawn as
 * an initial.
 */
export function initialsOf(user: MeUser | null): string {
  if (!user) return ''
  const name = (user.name ?? '').normalize('NFC').split(/[|(]/)[0]
  const firsts = name
    .split(/\s+/)
    .map((word) => word.match(LETTER)?.[0])
    .filter((letter): letter is string => !!letter)
  if (firsts.length === 0) return user.email?.match(LETTER)?.[0].toUpperCase() ?? ''
  if (ONE_CHARACTER_SCRIPTS.test(firsts[0])) return firsts[0]
  return firsts.slice(0, 2).join('').toUpperCase()
}

export function displayNameOf(user: MeUser | null, fallback = 'Account'): string {
  return user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? fallback
}

let cachedPlan: string | null | undefined

/**
 * The account's plan name on Backenly Cloud ("Free", "Pro", "Enterprise"), or
 * null while it loads and on a self-hosted build, which has no plan.
 *
 * Both bars used to print the literal "Free", so an account that had paid for
 * Pro was told it was on the free tier on every page. The answer comes from
 * the same subscription row Billing reads, fetched once per page load.
 */
export function usePlanName(): string | null {
  const [plan, setPlan] = useState<string | null>(cachedPlan ?? null)
  useEffect(() => {
    // A self-hosted build has no billing routes; asking would be a 404.
    if (!CLOUD_CONTROL_PLANE || cachedPlan !== undefined) return
    let cancelled = false
    fetch('/api/billing/current', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        cachedPlan = typeof d?.displayName === 'string' && d.displayName ? d.displayName : null
        if (!cancelled) setPlan(cachedPlan)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return plan
}

/**
 * Who is in scope: the organization switcher on Cloud (a static name chip on a
 * self-hosted build), with the plan beside it. A short placeholder holds the
 * place until the signed-in user is known, so the bar never flashes a
 * made-up "Personal" before the real name arrives.
 */
export function AccountScope({ className = '' }: { className?: string }) {
  const user = useMe()
  const plan = usePlanName()
  if (!user) return <Skeleton className={`mx-1.5 h-[14px] w-[72px] ${className}`} />
  return (
    <div className={`min-w-0 ${className}`}>
      <OrgSwitcher fallbackName={displayNameOf(user, 'Personal')} plan={plan ?? ''} />
    </div>
  )
}

/**
 * The account's avatar: its Google photo when it has one of its own, otherwise
 * its initials. A photo that fails to load (Google has since replaced it)
 * falls back to the initials too.
 */
export function Avatar({
  user,
  size = 28,
  className = 'text-[11px]',
}: {
  user: MeUser | null
  size?: number
  /** The initials' type size. */
  className?: string
}) {
  const photo = user?.avatarUrl || null
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={`relative flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(135deg,#27272a,#18181b)] font-semibold text-zinc-200 ${className}`}
    >
      {photo && failed !== photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(photo)}
          className="h-full w-full object-cover"
        />
      ) : (
        initialsOf(user)
      )}
      {/* The hairline sits over the photo as well as the initials. */}
      <span className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-white/[0.12]" />
    </span>
  )
}

export function AccountMenu() {
  const user = useMe()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const ref = useDismiss(open, close)

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`ml-0.5 flex h-[32px] w-[32px] items-center justify-center rounded-full transition-opacity hover:opacity-90 ${FOCUS}`}
      >
        <Avatar user={user} />
      </button>
      <AnimatePresence>
        {open && (
          <MenuPanel align="right" width="w-[240px]">
            {user && (
              <div className="px-2.5 pb-2 pt-1.5">
                <p className="truncate text-[13px] font-medium text-zinc-100">{user.name ?? displayNameOf(user)}</p>
                <p className="truncate text-[12px] text-faint">{user.email}</p>
              </div>
            )}
            {user && <MenuSeparator />}
            <MenuItem
              icon={Settings}
              onClick={() => {
                close()
                router.push('/app/settings')
              }}
            >
              Account settings
            </MenuItem>
            <MenuItem
              icon={LogOut}
              danger
              onClick={() => {
                close()
                signOut().catch((error) => console.error('Sign-out failed:', error))
              }}
            >
              Log out
            </MenuItem>
          </MenuPanel>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ── Sidebar navigation ────────────────────────────────────────────────── */

export function SidebarNav({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <nav aria-label="Primary" className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3 pt-2">
        {children}
      </nav>
      {footer && <div className="flex-shrink-0 px-3 pb-3 pt-1">{footer}</div>}
    </>
  )
}

export function NavGroup({ label, children, first = false }: { label?: string; children: ReactNode; first?: boolean }) {
  return (
    <div className={first ? '' : label ? 'mt-5' : 'mt-3'}>
      {label && <p className="mb-1 px-2.5 text-[12px] font-medium leading-[20px] text-faint">{label}</p>}
      <ul className="space-y-px">{children}</ul>
    </div>
  )
}

export function NavItem({
  href,
  icon: Icon,
  label,
  active,
  trailing,
  tourTarget,
  external = false,
}: {
  href: string
  icon: LucideIcon
  label: string
  active: boolean
  trailing?: ReactNode
  tourTarget?: string
  /** Opens in a new tab (the docs), and says so to sighted and screen-reader users alike. */
  external?: boolean
}) {
  return (
    <li>
      <Link
        href={href}
        data-tour={tourTarget}
        aria-current={active ? 'page' : undefined}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        className={`group flex h-[36px] items-center gap-2.5 rounded-[7px] px-2.5 text-[13px] font-medium transition-[background-color,color] duration-150 md:h-[30px] ${FOCUS} ${
          active
            ? 'bg-white/[0.07] text-zinc-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.045),inset_0_1px_0_rgba(255,255,255,0.05)]'
            : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
        }`}
      >
        <Icon
          className={`h-4 w-4 flex-shrink-0 transition-colors duration-150 ${
            active ? 'text-zinc-100' : 'text-zinc-500 group-hover:text-zinc-300'
          }`}
          strokeWidth={1.75}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {external && (
          <>
            <ArrowUpRight
              aria-hidden
              className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 transition-colors duration-150 group-hover:text-zinc-400"
              strokeWidth={1.75}
            />
            <span className="sr-only">(opens in a new tab)</span>
          </>
        )}
        {trailing}
      </Link>
    </li>
  )
}

/**
 * The plan at the foot of the account sidebar. On Free it says what upgrading
 * buys and links to Billing; on a paid plan it is absent, because the bar's
 * scope chip already names the plan. Cloud only (a self-hosted build has no
 * plans), and silent until the plan is known, so it never flashes a guess.
 */
export function SidebarPlan({ billingHref }: { billingHref: string }) {
  const plan = usePlanName()
  if (!CLOUD_CONTROL_PLANE || plan !== 'Free') return null
  return (
    <div className="mb-2 rounded-[10px] border border-white/[0.07] bg-white/[0.025] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <p className="text-[12.5px] font-medium leading-[18px] text-zinc-100">Free plan</p>
      <p className="mt-0.5 text-[12px] leading-[17px] text-faint [text-wrap:pretty]">
        Upgrade for production-severity support and higher limits.
      </p>
      <Link
        href={billingHref}
        className={`mt-2.5 inline-flex h-[26px] items-center ${R_CONTROL} border border-white/[0.10] bg-white/[0.05] px-2.5 text-[12px] font-medium text-zinc-100 transition-[background-color,border-color] duration-150 hover:border-white/[0.16] hover:bg-white/[0.08] ${FOCUS}`}
      >
        Upgrade
      </Link>
    </div>
  )
}

/** Trailing count on a nav item: plain tabular text, not a pill. */
export function NavCount({ value }: { value: number }) {
  return <span className="text-[12px] font-normal tabular-nums text-faint">{value}</span>
}

/** Trailing tag on a nav item (e.g. MCP). */
export function NavTag({ children, active }: { children: ReactNode; active?: boolean }) {
  return (
    <span
      className={`rounded-[4px] border px-1 text-[10.5px] font-medium leading-[16px] ${
        active ? 'border-violet-300/25 text-violet-200' : 'border-white/[0.08] text-faint'
      }`}
    >
      {children}
    </span>
  )
}

/** Kept for callers that still import the old helper name. */
export const railSurface = CHROME
