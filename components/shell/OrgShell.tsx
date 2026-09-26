'use client'

/**
 * OrgShell — the org-level frame (IA restructure §5).
 *
 * One top bar + one left sidebar across the account-level pages: Projects,
 * Usage, Members, Billing, Settings. Same visual language
 * as the project-level shell (§4) so both levels feel like one product — the
 * locked kit: #141519 chrome, hairline borders, mono numerals, violet only for
 * the primary action / active row.
 *
 * The top bar here has no project switcher (there's no project in scope at org
 * level) and no environment chip — just brand, the org/plan breadcrumb, and the
 * account menu. Org switching itself is Phase 6 (the Organization model doesn't
 * exist yet), so the breadcrumb shows the account name.
 */

import { type ReactNode, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  FolderKanban,
  Gauge,
  Users,
  CreditCard,
  // Gift, — referral hidden for now, see NAV below
  Settings,
  Settings as SettingsIcon,
  LogOut,
  Menu,
  X,
} from 'lucide-react'
import { Logo } from '@/components/Logo'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { GettingStartedMenuItem } from '@/components/onboarding/GuideDrawer'

interface MeUser {
  name?: string
  email?: string
}

let cachedUser: MeUser | null = null

/**
 * Members and Billing are Cloud surfaces: their pages and APIs live in the
 * private overlay, so a public build that listed them would offer a menu item
 * routing to a page it does not contain. CLOUD_CONTROL_PLANE is a build-time
 * constant that is true exactly when those files are present. It gates
 * PRESENTATION only; every access decision stays server-side.
 */
const NAV = [
  { id: 'projects', title: 'Projects',          icon: FolderKanban, href: '/app',          match: (p: string) => p === '/app' || p === '/app/' },
  // Usage is a billing-cycle surface: it reads /api/billing/usage (overlay-only)
  // and renders consumption against plan ceilings. A self-hosted deployment has
  // no billing cycle and no ceilings — every self-host entitlement is null —
  // so the page could only ever show bars against infinity, and in the public
  // build it showed "Could not load usage data" because its endpoint is absent.
  ...(CLOUD_CONTROL_PLANE
    ? ([
        { id: 'usage',    title: 'Usage',             icon: Gauge,        href: '/app/usage',    match: (p: string) => p.startsWith('/app/usage') },
        { id: 'members',  title: 'Members',           icon: Users,        href: '/app/members',  match: (p: string) => p.startsWith('/app/members') },
        { id: 'billing',  title: 'Billing', icon: CreditCard,   href: '/app/billing',  match: (p: string) => p.startsWith('/app/billing') },
      ] as const)
    : ([] as const)),
  // HIDDEN 2026-07-19 — referral program parked for now. Backend (signup ?ref=,
  // /api/referral, credit grants) still works; to restore, uncomment this row,
  // the Gift import above, and REFERRAL_HIDDEN in app/app/referral/page.tsx.
  // { id: 'referral', title: 'Referral',          icon: Gift,         href: '/app/referral', match: (p: string) => p.startsWith('/app/referral') },
] as const

export function OrgShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [user, setUser] = useState<MeUser | null>(cachedUser)
  const [accountMenu, setAccountMenu] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user) {
          cachedUser = d.user
          setUser(d.user)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setAccountMenu(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  // Close mobile nav on route change or Escape
  useEffect(() => {
    setMobileNavOpen(false)
  }, [pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Prevent background scroll chaining when mobile drawer is open
  useEffect(() => {
    if (!mobileNavOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [mobileNavOpen])

  const initials = () => {
    if (!user) return '?'
    if (user.name) return user.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    return user.email?.[0]?.toUpperCase() ?? '?'
  }

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    router.push('/login')
  }

  const settingsActive = pathname.startsWith('/app/settings')

  return (
    <div className="min-h-screen bg-[#101116]">
      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <header className="fixed top-0 left-0 right-0 h-12 z-30 bg-[#141519] border-b border-white/[0.07] flex items-center px-3 sm:px-4 gap-1">
        {/* Violet warmth gradient — mobile-only brand-warmth touch inside the chrome */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-b from-violet-500/[0.03] to-transparent md:hidden" />

        {/* Mobile menu toggle — 44×44 touch target, properly centred in the 48px header */}
        <button
          type="button"
          onClick={() => setMobileNavOpen((o) => !o)}
          className="md:hidden inline-flex items-center justify-center w-11 h-11 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors -ml-2 flex-shrink-0 focus:outline-none"
          aria-label="Toggle navigation menu"
          aria-expanded={mobileNavOpen}
        >
          <AnimatePresence mode="wait" initial={false}>
            {mobileNavOpen ? (
              <motion.span
                key="x"
                initial={{ opacity: 0, rotate: -45, scale: 0.8 }}
                animate={{ opacity: 1, rotate: 0, scale: 1 }}
                exit={{ opacity: 0, rotate: 45, scale: 0.8 }}
                transition={{ duration: 0.15 }}
                className="inline-flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </motion.span>
            ) : (
              <motion.span
                key="menu"
                initial={{ opacity: 0, rotate: 45, scale: 0.8 }}
                animate={{ opacity: 1, rotate: 0, scale: 1 }}
                exit={{ opacity: 0, rotate: -45, scale: 0.8 }}
                transition={{ duration: 0.15 }}
                className="inline-flex items-center justify-center"
              >
                <Menu className="w-4 h-4" />
              </motion.span>
            )}
          </AnimatePresence>
        </button>

        <Link href="/app" className="flex items-center flex-shrink-0 pl-0.5 pr-2" aria-label="Backenly home">
          <Logo />
        </Link>

        {/* Desktop divider — kept only for sm+ where the name chip follows */}
        <div className="h-5 w-px bg-white/[0.08] mx-1 hidden sm:block" />

        {/* User name + plan chip — hidden on mobile (avatar already identifies the user) */}
        <div className="hidden sm:flex items-center gap-1.5 px-1.5 min-w-0">
          <span className="text-[12.5px] text-zinc-300 truncate max-w-[120px] sm:max-w-[180px]">
            {user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'Personal'}
          </span>
          {/* Plan chip is a Cloud concept. It was a hardcoded literal, so a
              self-hosted deployment — which has unlimited entitlements — was
              being told it was on a free tier. */}
          {CLOUD_CONTROL_PLANE && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-white/[0.05] text-zinc-400 tracking-tight shrink-0">
              Free
            </span>
          )}
        </div>

        {/* Flex-1 spacer — pushes the avatar to the far right on all screen sizes */}
        <div className="flex-1" />

        <div className="flex items-center gap-1">
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setAccountMenu((o) => !o)}
              className="w-8 h-8 rounded-full bg-white/[0.08] ring-1 ring-white/[0.12] flex items-center justify-center text-[11px] font-semibold text-zinc-100 hover:ring-white/25 transition-colors"
              aria-label="Account menu"
            >
              {initials()}
            </button>
            <AnimatePresence>
              {accountMenu && (
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.96 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  className="absolute top-full right-0 mt-1 w-[220px] bg-[#1c1d23] border border-white/[0.10] rounded-lg shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] overflow-hidden z-40"
                >
                  {user && (
                    <div className="px-3 py-2.5 border-b border-white/[0.07]">
                      <p className="text-[12px] font-medium text-zinc-200 truncate">{user.name ?? user.email?.split('@')[0]}</p>
                      <p className="text-[11px] text-zinc-500 truncate">{user.email}</p>
                    </div>
                  )}
                  <button
                    onClick={() => { setAccountMenu(false); router.push('/app/settings') }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-zinc-300 hover:text-zinc-50 hover:bg-white/[0.05] transition-colors"
                  >
                    <SettingsIcon className="w-3.5 h-3.5" />
                    <span className="text-[12.5px] font-medium">Account settings</span>
                  </button>
                  {/* The guide lives on Projects at org level: reopen it, then go there. */}
                  <GettingStartedMenuItem
                    onSelect={() => {
                      setAccountMenu(false)
                      if (pathname !== '/app' && pathname !== '/app/') router.push('/app')
                    }}
                  />
                  <button
                    onClick={() => { setAccountMenu(false); logout() }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-zinc-300 hover:text-rose-300 hover:bg-rose-500/[0.06] transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span className="text-[12.5px] font-medium">Log out</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      {/* ── Mobile drawer ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {mobileNavOpen && (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
            {/* Backdrop — smooth fade-in and fade-out */}
            <motion.div
              key="mobile-drawer-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              className="fixed inset-0 bg-black/70 backdrop-blur-sm"
              onClick={() => setMobileNavOpen(false)}
            />
            {/* Drawer panel — spring physics for buttery glide into/out of frame */}
            <motion.div
              key="mobile-drawer-panel"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{
                type: 'spring',
                damping: 32,
                stiffness: 340,
                mass: 0.85,
              }}
              className="fixed inset-y-0 left-0 w-[280px] max-w-[85vw] bg-[#141519] border-r border-white/[0.07] flex flex-col z-50 pt-14 shadow-[0_16px_44px_-12px_rgba(0,0,0,0.95)]"
            >
              {/* Violet brand-warmth line — mirrors the top-bar gradient and modal header bar */}
              <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-b from-violet-500/[0.35] to-transparent" />

              {/* Section label — increased contrast from text-zinc-500 to text-zinc-400 */}
              <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                Workspace
              </div>
              {/* overscroll-contain prevents body scroll-chaining when drawer list is at top/bottom */}
              <nav className="flex-1 overflow-y-auto overscroll-contain px-3 py-1 space-y-1">
                {NAV.map((item, idx) => {
                  const active = item.match(pathname)
                  const Icon = item.icon
                  return (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.2, delay: 0.05 + idx * 0.03, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <Link
                        href={item.href}
                        onClick={() => setMobileNavOpen(false)}
                        aria-current={active ? 'page' : undefined}
                        className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-colors group min-h-[44px] ${
                          active
                            ? 'bg-white/[0.06] border border-white/[0.12] shadow-[inset_3px_0_0_rgba(196,181,253,0.78)]'
                            : 'border border-transparent hover:bg-white/[0.045] hover:border-white/[0.06]'
                        }`}
                      >
                        <Icon className={`w-4 h-4 flex-shrink-0 transition-colors ${active ? 'text-zinc-50' : 'text-zinc-400 group-hover:text-zinc-200'}`} />
                        <span className={`text-[13.5px] font-medium transition-colors ${active ? 'text-zinc-50' : 'text-zinc-300 group-hover:text-zinc-100'}`}>
                          {item.title}
                        </span>
                      </Link>
                    </motion.div>
                  )
                })}
              </nav>

              <div className="px-3 pt-1 pb-1 border-t border-white/[0.07]">
                <Link
                  href="/app/settings"
                  onClick={() => setMobileNavOpen(false)}
                  aria-current={settingsActive ? 'page' : undefined}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-colors group min-h-[44px] ${
                    settingsActive
                      ? 'bg-white/[0.06] border border-white/[0.12] shadow-[inset_3px_0_0_rgba(196,181,253,0.78)]'
                      : 'border border-transparent hover:bg-white/[0.045] hover:border-white/[0.06]'
                  }`}
                >
                  <Settings className={`w-4 h-4 flex-shrink-0 ${settingsActive ? 'text-zinc-50' : 'text-zinc-400 group-hover:text-zinc-200'}`} />
                  <span className={`text-[13.5px] font-medium ${settingsActive ? 'text-zinc-50' : 'text-zinc-300 group-hover:text-zinc-100'}`}>
                    Settings
                  </span>
                </Link>
              </div>

              {/* User identity footer — lets the user confirm their session and log out
                  without dismissing the drawer and opening the top-bar account popover */}
              <div className="px-3 py-3 border-t border-white/[0.07]">
                <div className="flex items-center gap-3 px-3 py-2">
                  <div className="w-7 h-7 shrink-0 rounded-full bg-white/[0.08] ring-1 ring-white/[0.12] flex items-center justify-center text-[11px] font-semibold text-zinc-100">
                    {initials()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium text-zinc-200 truncate">
                      {user?.name ?? user?.email?.split('@')[0] ?? 'Account'}
                    </p>
                    <p className="text-[11px] text-zinc-500 truncate">{user?.email}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setMobileNavOpen(false); logout() }}
                  className="mt-1 w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-transparent hover:bg-rose-500/[0.06] hover:border-rose-400/20 text-zinc-400 hover:text-rose-300 transition-colors min-h-[44px]"
                >
                  <LogOut className="w-4 h-4 flex-shrink-0" />
                  <span className="text-[13px] font-medium">Log out</span>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Sidebar (desktop) ──────────────────────────────────────────────── */}
      <aside className="hidden md:flex w-[248px] flex-shrink-0 border-r border-white/[0.07] bg-[#141519] flex-col fixed left-0 top-12 bottom-0 z-20">
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {NAV.map((item) => {
            const active = item.match(pathname)
            const Icon = item.icon
            return (
              <Link
                key={item.id}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md transition-colors group ${
                  active
                    ? 'bg-white/[0.06] border border-white/[0.12] shadow-[inset_3px_0_0_rgba(196,181,253,0.78)]'
                    : 'border border-transparent hover:bg-white/[0.045] hover:border-white/[0.06]'
                }`}
              >
                <Icon className={`w-4 h-4 flex-shrink-0 transition-colors ${active ? 'text-zinc-50' : 'text-zinc-400 group-hover:text-zinc-200'}`} />
                <span className={`text-[13px] font-medium transition-colors ${active ? 'text-zinc-50' : 'text-zinc-300 group-hover:text-zinc-100'}`}>
                  {item.title}
                </span>
              </Link>
            )
          })}
        </nav>

        {/* Settings pinned at the bottom of the org sidebar */}
        <div className="px-3 py-3 border-t border-white/[0.07]">
          <Link
            href="/app/settings"
            aria-current={settingsActive ? 'page' : undefined}
            className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md transition-colors group ${
              settingsActive
                ? 'bg-white/[0.06] border border-white/[0.12] shadow-[inset_3px_0_0_rgba(196,181,253,0.78)]'
                : 'border border-transparent hover:bg-white/[0.045] hover:border-white/[0.06]'
            }`}
          >
            <Settings className={`w-4 h-4 flex-shrink-0 ${settingsActive ? 'text-zinc-50' : 'text-zinc-400 group-hover:text-zinc-200'}`} />
            <span className={`text-[13px] font-medium ${settingsActive ? 'text-zinc-50' : 'text-zinc-300 group-hover:text-zinc-100'}`}>
              Settings
            </span>
          </Link>
        </div>
      </aside>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      {/* overflow-x-hidden prevents horizontal scroll bleed from slide-in animations */}
      <div className="pt-12 pl-0 md:pl-[248px] overflow-x-hidden">
        <div className="relative min-h-[calc(100vh-48px)] animate-fade-in">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-0 h-px bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.30),transparent)]"
          />
          {children}
        </div>
      </div>
    </div>
  )
}
