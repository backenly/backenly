'use client'

/**
 * ProjectSidebar — the single, persistent project-level navigation.
 *
 * Supersedes InspectorSidebar. There is now exactly one sidebar for the whole
 * project workspace (Overview + every section), matching the target IA in
 * the IA restructure §3.1. No "Back to workspace" escape hatch, no
 * Control-Hub overlay nav, no mode switches — one grouped list, always visible.
 *
 * Design language is the locked kit (components/inspector/kit.tsx): #141519
 * panel, hairline borders, 13px medium labels, mono tabular counts, violet only
 * for the active row. Brand, account, inbox and the Connect button live in the
 * TopBar now — this component is nav only.
 */

import { useEffect, useState, useTransition } from 'react'
import { useParams, usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  Database,
  Shield,
  HardDrive,
  Code2,
  Radio,
  Zap,
  Bot,
  Activity,
  Rocket,
  Cable,
  GitBranch,
  Settings,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { FrontendConnectionPill } from '@/components/inspector/FrontendConnectionPill'

// ── Section registry ─────────────────────────────────────────────────────────

interface NavItem {
  id: string
  title: string
  icon: React.ComponentType<{ className?: string }>
  /** Path suffix appended to /app/projects/[id]. */
  href: string
  /** Substrings that mark this item active when found in the pathname. */
  match?: string[]
  /** Live-count key rendered as a mono badge. */
  countKey?: 'functions'
  /** Small trailing tag (e.g. SDK). */
  tag?: string
}

interface NavGroup {
  label?: string
  items: NavItem[]
}

const NAV: NavGroup[] = [
  {
    items: [
      { id: 'overview', title: 'Overview', icon: LayoutDashboard, href: '', match: ['__exact__'] },
    ],
  },
  {
    label: 'Build',
    items: [
      { id: 'database',     title: 'Database',      icon: Database, href: '/database',     match: ['/database'] },
      // APIs entry removed 2026-07-21: under PostgREST the API IS the schema,
      // so the tables page is the API page. /apis redirects to /database.
      { id: 'auth',         title: 'Auth & Users',  icon: Shield,   href: '/auth',         match: ['/auth', '/users'] },
      { id: 'storage',      title: 'Storage',       icon: HardDrive,href: '/storage',      match: ['/storage'] },
      { id: 'functions',    title: 'Functions',     icon: Code2,    href: '/functions',    match: ['/functions'],   countKey: 'functions' },
      { id: 'realtime',     title: 'Realtime',      icon: Radio,    href: '/realtime',     match: ['/realtime'] },
      { id: 'integrations', title: 'Integrations',  icon: Zap,      href: '/integrations', match: ['/integrations'] },
    ],
  },
  {
    label: 'Operate',
    items: [
      { id: 'autonomy',   title: 'Autonomy',   icon: Bot,      href: '/autonomy',   match: ['/autonomy'] },
      { id: 'monitoring', title: 'Monitoring', icon: Activity, href: '/monitoring', match: ['/monitoring'] },
      { id: 'branches',   title: 'Branches',   icon: GitBranch,href: '/branches',   match: ['/branches'] },
      { id: 'deploy',     title: 'Deploy',     icon: Rocket,   href: '/deploy',     match: ['/deploy'] },
    ],
  },
  {
    label: 'Connect',
    items: [
      { id: 'connect', title: 'Connect', icon: Cable, href: '/connect', match: ['/connect', '/mcp'], tag: 'MCP' },
    ],
  },
  {
    items: [
      { id: 'settings', title: 'Settings', icon: Settings, href: '/settings', match: ['/settings', '/iam'] },
    ],
  },
]

// ── Live counts ───────────────────────────────────────────────────────────────

interface LiveCounts {
  functions?: number
}

function useLiveCounts(projectId: string): LiveCounts {
  const [counts, setCounts] = useState<LiveCounts>({})

  useEffect(() => {
    if (!projectId) return
    let cancelled = false

    async function fetchCounts() {
      try {
        const fnRes = await fetch(`/api/projects/${projectId}/ai-functions`, { credentials: 'include' })
        const next: LiveCounts = {}
        if (fnRes.ok) {
          const j = await fnRes.json()
          next.functions = Array.isArray(j.functions) ? j.functions.length : undefined
        }
        if (!cancelled) setCounts(next)
      } catch {
        /* silent — counts are decorative */
      }
    }

    fetchCounts()
    const interval = setInterval(fetchCounts, 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [projectId])

  return counts
}

// ── Active resolution ─────────────────────────────────────────────────────────

function isActive(item: NavItem, pathname: string, basePath: string): boolean {
  // Overview is active only on the exact base path.
  if (item.match?.includes('__exact__')) {
    return pathname === basePath
  }
  return (item.match ?? []).some((m) => pathname.includes(m))
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export function ProjectSidebar() {
  const params = useParams()
  const router = useRouter()
  const pathname = usePathname()
  const projectId = params.id as string
  const basePath = `/app/projects/${projectId}`

  const [isPending, startTransition] = useTransition()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const counts = useLiveCounts(projectId)

  const navigate = (item: NavItem) => {
    startTransition(() => router.push(`${basePath}${item.href}`))
  }

  const toggleGroup = (label: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(label) ? next.delete(label) : next.add(label)
      return next
    })

  const countFor = (item: NavItem): number | undefined =>
    item.countKey ? counts[item.countKey] : undefined

  return (
    <aside className="w-[248px] flex-shrink-0 border-r border-white/[0.07] bg-[#141519] flex flex-col fixed left-0 top-12 bottom-0 z-20">
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {NAV.map((group, gi) => {
          const isCollapsed = group.label ? collapsed.has(group.label) : false
          return (
            <div key={group.label ?? `g${gi}`} className={gi > 0 ? 'mt-5' : 'mt-0.5'}>
              {group.label && (
                <button
                  onClick={() => toggleGroup(group.label!)}
                  className="w-full flex items-center justify-between px-2.5 mb-1.5 group"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600 group-hover:text-zinc-400 transition-colors">
                    {group.label}
                  </span>
                  {isCollapsed
                    ? <ChevronRight className="w-3 h-3 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
                    : <ChevronDown className="w-3 h-3 text-zinc-600 group-hover:text-zinc-400 transition-colors" />}
                </button>
              )}

              {!isCollapsed && (
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const active = isActive(item, pathname, basePath)
                    const Icon = item.icon
                    const count = countFor(item)
                    return (
                      <button
                        key={item.id}
                        onClick={() => navigate(item)}
                        aria-current={active ? 'page' : undefined}
                        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors group ${
                          active
                            ? 'bg-white/[0.06] border border-white/[0.12] shadow-[inset_3px_0_0_rgba(196,181,253,0.78)]'
                            : 'border border-transparent hover:bg-white/[0.045] hover:border-white/[0.06]'
                        }`}
                      >
                        <Icon
                          className={`w-4 h-4 flex-shrink-0 transition-colors ${
                            active ? 'text-zinc-50' : 'text-zinc-400 group-hover:text-zinc-200'
                          }`}
                        />
                        <span
                          className={`text-[13px] font-medium flex-1 transition-colors ${
                            active ? 'text-zinc-50' : 'text-zinc-300 group-hover:text-zinc-100'
                          }`}
                        >
                          {item.title}
                        </span>

                        {item.tag && (
                          <span
                            className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full tracking-tight transition-colors ${
                              active
                                ? 'bg-violet-200/15 text-violet-100'
                                : 'bg-white/[0.05] text-zinc-400 group-hover:text-zinc-200'
                            }`}
                          >
                            {item.tag}
                          </span>
                        )}

                        {typeof count === 'number' && count > 0 && (
                          <span className="font-mono text-[10.5px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full min-w-[18px] text-center leading-none bg-white/[0.07] text-zinc-300">
                            {count}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* Frontend connection status — "is my Lovable/v0/Bolt app actually
          talking to this backend?" answered without leaving the workspace. */}
      <div className="px-3.5 py-3 border-t border-white/[0.07]">
        <FrontendConnectionPill projectId={projectId} variant="compact" />
      </div>

      {isPending && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/50 to-transparent" />
      )}
    </aside>
  )
}
