'use client'

/**
 * ProjectSidebar: the single, persistent project-level navigation.
 *
 * One grouped list, always visible (IA restructure §3.1): Overview, then
 * Build, Operate and Connect, with Settings closing the list. Brand, account,
 * inbox and the Connect button live in the TopBar; this component is
 * navigation only.
 *
 * Rebuilt 2026-09-30 (console redesign): items are real links, so they
 * prefetch and open in a new tab on Cmd/Ctrl-click; group labels are sentence
 * case; the group collapse toggles are gone (fourteen items do not need
 * folding, and a chevron on every heading was noise); counts are plain
 * tabular text rather than pills.
 */

import { useEffect, useState } from 'react'
import { useParams, usePathname } from 'next/navigation'
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
  Webhook,
  GitBranch,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { FrontendConnectionPill } from '@/components/inspector/FrontendConnectionPill'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { NavCount, NavGroup, NavItem, NavTag, SidebarNav } from './ConsoleChrome'

// ── Section registry ─────────────────────────────────────────────────────────

interface NavEntry {
  id: string
  title: string
  icon: LucideIcon
  /** Path suffix appended to /app/projects/[id]. */
  href: string
  /** Substrings that mark this item active when found in the pathname. */
  match?: string[]
  /** Live-count key rendered as a trailing number. */
  countKey?: 'functions'
  /** Small trailing tag (e.g. MCP). */
  tag?: string
}

interface NavSection {
  label?: string
  items: NavEntry[]
}

const NAV: NavSection[] = [
  {
    items: [{ id: 'overview', title: 'Overview', icon: LayoutDashboard, href: '', match: ['__exact__'] }],
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
      // Preview branches are a Cloud capability: the engine refuses off Cloud
      // (lib/branches/engine.ts) and the routes answer 404, so listing the item
      // here would offer a control for work that cannot happen.
      ...(CLOUD_CONTROL_PLANE
        ? [{ id: 'branches', title: 'Branches', icon: GitBranch, href: '/branches', match: ['/branches'] } as NavEntry]
        : []),
      { id: 'deploy',     title: 'Deploy',     icon: Rocket,   href: '/deploy',     match: ['/deploy'] },
    ],
  },
  {
    label: 'Connect',
    items: [
      { id: 'connect', title: 'Connect', icon: Cable, href: '/connect', match: ['/connect', '/mcp'], tag: 'MCP' },
      { id: 'webhooks', title: 'Webhooks', icon: Webhook, href: '/webhooks', match: ['/webhooks'] },
    ],
  },
  {
    items: [{ id: 'settings', title: 'Settings', icon: Settings, href: '/settings', match: ['/settings', '/iam'] }],
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

function isActive(item: NavEntry, pathname: string, basePath: string): boolean {
  // Overview is active only on the exact base path.
  if (item.match?.includes('__exact__')) {
    return pathname === basePath || pathname === `${basePath}/`
  }
  return (item.match ?? []).some((m) => pathname.startsWith(`${basePath}${m}`))
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

/**
 * The navigation list. ProjectShell mounts it in the desktop rail and in the
 * phone drawer (ConsoleFrame owns both), so it carries no positioning itself.
 */
export function ProjectSidebar() {
  const params = useParams()
  const pathname = usePathname() ?? ''
  const projectId = params.id as string
  const basePath = `/app/projects/${projectId}`
  const counts = useLiveCounts(projectId)

  return (
    <SidebarNav footer={<FrontendConnectionPill projectId={projectId} variant="compact" />}>
      {NAV.map((group, gi) => (
        <NavGroup key={group.label ?? `g${gi}`} label={group.label} first={gi === 0}>
          {group.items.map((item) => {
            const active = isActive(item, pathname, basePath)
            const count = item.countKey ? counts[item.countKey] : undefined
            return (
              <NavItem
                key={item.id}
                tourTarget={`nav-${item.id}`}
                href={`${basePath}${item.href}`}
                icon={item.icon}
                label={item.title}
                active={active}
                trailing={
                  item.tag ? (
                    <NavTag active={active}>{item.tag}</NavTag>
                  ) : typeof count === 'number' && count > 0 ? (
                    <NavCount value={count} />
                  ) : undefined
                }
              />
            )
          })}
        </NavGroup>
      ))}
    </SidebarNav>
  )
}
