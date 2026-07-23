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
import {
  FolderKanban,
  Gauge,
  Users,
  CreditCard,
  // Gift, — referral hidden for now, see NAV below
  Settings,
  Settings as SettingsIcon,
  LogOut,
} from 'lucide-react'
import { Logo } from '@/components/Logo'

interface MeUser {
  name?: string
  email?: string
}

const NAV = [
  { id: 'projects', title: 'Projects',          icon: FolderKanban, href: '/app',          match: (p: string) => p === '/app' || p === '/app/' },
  { id: 'usage',    title: 'Usage',             icon: Gauge,        href: '/app/usage',    match: (p: string) => p.startsWith('/app/usage') },
  { id: 'members',  title: 'Members',           icon: Users,        href: '/app/members',  match: (p: string) => p.startsWith('/app/members') },
  { id: 'billing',  title: 'Billing', icon: CreditCard,   href: '/app/billing',  match: (p: string) => p.startsWith('/app/billing') },
  // HIDDEN 2026-07-19 — referral program parked for now. Backend (signup ?ref=,
  // /api/referral, credit grants) still works; to restore, uncomment this row,
  // the Gift import above, and REFERRAL_HIDDEN in app/app/referral/page.tsx.
  // { id: 'referral', title: 'Referral',          icon: Gift,         href: '/app/referral', match: (p: string) => p.startsWith('/app/referral') },
] as const

export function OrgShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [user, setUser] = useState<MeUser | null>(null)
  const [accountMenu, setAccountMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.user) setUser(d.user) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setAccountMenu(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

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
      <header className="fixed top-0 left-0 right-0 h-12 z-30 bg-[#141519] border-b border-white/[0.07] flex items-center px-3 gap-1">
        <Link href="/app" className="flex items-center pl-1 pr-2" aria-label="Backenly home">
          <Logo />
        </Link>

        <div className="h-5 w-px bg-white/[0.08] mx-1 hidden sm:block" />

        <div className="flex items-center gap-1.5 px-1.5">
          <span className="text-[12.5px] text-zinc-300 truncate max-w-[180px]">
            {user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'Personal'}
          </span>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-white/[0.05] text-zinc-400 tracking-tight">
            Free
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1">

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setAccountMenu((o) => !o)}
              className="w-7 h-7 ml-1 rounded-full bg-white/[0.08] ring-1 ring-white/[0.12] flex items-center justify-center text-[11px] font-semibold text-zinc-100 hover:ring-white/25 transition-colors"
              aria-label="Account menu"
            >
              {initials()}
            </button>
            {accountMenu && (
              <div className="absolute top-full right-0 mt-1 w-[220px] bg-[#1c1d23] border border-white/[0.10] rounded-lg shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] overflow-hidden z-40">
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
                <button
                  onClick={() => { setAccountMenu(false); logout() }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-zinc-300 hover:text-rose-300 hover:bg-rose-500/[0.06] transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="text-[12.5px] font-medium">Log out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── Sidebar ───────────────────────────────────────────────────────── */}
      <aside className="w-[248px] flex-shrink-0 border-r border-white/[0.07] bg-[#141519] flex flex-col fixed left-0 top-12 bottom-0 z-20">
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
      <div className="pt-12 pl-[248px]">
        <div className="relative min-h-[calc(100vh-48px)]">
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
