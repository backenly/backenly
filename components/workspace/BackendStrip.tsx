'use client'

/**
 * "Your backend" on Overview: the four parts of the project, one cell each,
 * every cell opening its own page. It replaced Recent changes on the
 * founder's call (2026-11-16): History already lists changes, while Overview
 * should say what the backend is.
 *
 * Built (mode 'numbers'): the project's own numbers, read where those pages
 * read them, so the two never disagree.
 *
 *   Database        Auth & Users     Storage          Functions
 *   8  tables       37  users        1  bucket        4  functions
 *   6.8 MB                           196 MB           1 failed  /  Last run 2 min ago
 *
 * Nothing built yet (mode 'intro'): the same four cells, each saying in one
 * line what it holds, so a new project shows what the agent will build. The
 * page switches to numbers once the first table exists.
 *
 * Counts come from /dashboard-stats (tables, size, users, buckets) and
 * /ai-functions (the Functions page's list; "failed" is its own rule, a last
 * run with status 'error'). A part that could not be read shows "—", never a
 * zero; both failing is one error row.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Code2, Database, HardDrive, Shield, type LucideIcon } from 'lucide-react'
import { Skeleton } from '@/components/inspector/kit'
import { Panel } from '@/components/autonomy/rows'
import { ErrorRow } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { FOCUS_INSET } from '@/components/console/tokens'
import { formatBytes } from '@/components/storage/format'

interface DashboardStats {
  tableCount?: number
  buckets?: Array<{ totalBytes: number }>
  summary?: { endUsers: number | null; dbBytes: number | null }
}

interface FunctionsList {
  functions?: Array<{ status?: string; lastRun?: string | null }>
}

interface Cell {
  key: string
  label: string
  icon: LucideIcon
  href: string
  /** The number, large. */
  value?: string
  /** Words after the number: "tables", "bucket, 196 MB". */
  unit?: ReactNode
  /** One plain line under it: the intro sentence, or a fact. */
  line?: ReactNode
}

/** The one-line descriptions a new project shows (the founder's words, from the old Included cards). */
const INTRO: Record<string, string> = {
  database: 'Postgres tables with REST endpoints and row-level security.',
  auth: 'Sign-up, sign-in and sessions for the people using your app.',
  storage: 'Buckets for your app’s files, each with its own read rule.',
  functions: 'Endpoints, scheduled jobs and code that runs when data changes.',
}

const PARTS: Array<{ key: string; label: string; icon: LucideIcon; path: string }> = [
  { key: 'database', label: 'Database', icon: Database, path: '/database' },
  { key: 'auth', label: 'Auth & Users', icon: Shield, path: '/auth?tab=users' },
  { key: 'storage', label: 'Storage', icon: HardDrive, path: '/storage' },
  { key: 'functions', label: 'Functions', icon: Code2, path: '/functions' },
]

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export function BackendStrip({ projectId, mode, refreshSignal = 0 }: { projectId: string; mode: 'numbers' | 'intro'; refreshSignal?: number }) {
  const base = `/app/projects/${projectId}`
  const [stats, setStats] = useState<DashboardStats | null | undefined>(undefined)
  const [fns, setFns] = useState<FunctionsList | null | undefined>(undefined)
  const [retrying, setRetrying] = useState(false)

  const load = useCallback(async () => {
    const read = async <T,>(route: string): Promise<T | null> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/${route}`, { credentials: 'include' })
        return res.ok ? ((await res.json()) as T) : null
      } catch {
        return null
      }
    }
    const [s, f] = await Promise.all([read<{ data?: DashboardStats }>('dashboard-stats'), read<FunctionsList>('ai-functions')])
    // A failed refresh keeps what was shown.
    setStats((prev) => (s?.data ? s.data : prev ?? null))
    setFns((prev) => (f && Array.isArray(f.functions) ? f : prev ?? null))
    setRetrying(false)
  }, [projectId])

  useEffect(() => {
    if (mode === 'numbers') void load()
  }, [mode, load, refreshSignal])

  if (mode === 'numbers' && stats === null && fns === null) {
    return (
      <Panel>
        <ErrorRow
          things="your backend’s numbers"
          onRetry={() => {
            setRetrying(true)
            void load()
          }}
          retrying={retrying}
        />
      </Panel>
    )
  }

  const loading = mode === 'numbers' && (stats === undefined || fns === undefined)
  const cells: Cell[] = PARTS.map((p) => {
    const cell: Cell = { key: p.key, label: p.label, icon: p.icon, href: `${base}${p.path}` }
    if (mode === 'intro') return { ...cell, line: INTRO[p.key] }
    if (p.key === 'database') {
      // The route's own total. Never the length of `tables`: that list is cut at 12 (OV-3, "12 Tables" for 15).
      const n = typeof stats?.tableCount === 'number' ? stats.tableCount : null
      const size = stats?.summary?.dbBytes
      return n == null ? { ...cell, value: '—' } : { ...cell, value: n.toLocaleString('en-US'), unit: plural(n, 'table', 'tables'), line: size != null ? formatBytes(size) : undefined }
    }
    if (p.key === 'auth') {
      const n = stats?.summary?.endUsers
      // No users table yet is "—", not "0 users": nobody has signed up versus nothing to sign up to.
      return n == null ? { ...cell, value: '—', line: stats ? 'No sign-up yet' : undefined } : { ...cell, value: n.toLocaleString('en-US'), unit: plural(n, 'user', 'users') }
    }
    if (p.key === 'storage') {
      const buckets = stats?.buckets
      if (!buckets) return { ...cell, value: '—' }
      const bytes = buckets.reduce((acc, b) => acc + (b.totalBytes || 0), 0)
      return { ...cell, value: buckets.length.toLocaleString('en-US'), unit: plural(buckets.length, 'bucket', 'buckets'), line: buckets.length > 0 ? formatBytes(bytes) : undefined }
    }
    const list = fns?.functions
    if (!list) return { ...cell, value: '—' }
    const failed = list.filter((f) => f.status === 'error').length
    const last = list.reduce<string | null>((acc, f) => (f.lastRun && (!acc || f.lastRun > acc) ? f.lastRun : acc), null)
    return {
      ...cell,
      value: list.length.toLocaleString('en-US'),
      unit: plural(list.length, 'function', 'functions'),
      // The same rule as the Functions page's "✕ 1 failed": white, because it needs a look.
      line: failed > 0 ? <span className="font-medium text-zinc-50">{failed} failed</span> : last ? <Time iso={last} prefix="Last run" /> : undefined,
    }
  })

  return (
    <Panel>
      <ul className="grid grid-cols-1 divide-y divide-white/[0.06] sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
        {cells.map((c, i) => {
          const Icon = c.icon
          // Hairlines between cells: below a cell on top rows (2 columns), beside every cell after the first in its row.
          const edges = `${i % 2 === 1 ? 'sm:border-l' : ''} ${i >= 2 ? 'sm:border-t lg:border-t-0' : ''} ${i % 4 !== 0 ? 'lg:border-l' : 'lg:border-l-0'} border-white/[0.06]`
          return (
            <li key={c.key} className={`min-w-0 ${edges}`}>
              {/* On a phone a numbers cell is one row, label left and number right, as Last 24 hours does it. */}
              <Link
                href={c.href}
                className={`group h-full px-[20px] transition-colors duration-150 hover:bg-white/[0.02] ${FOCUS_INSET} ${
                  mode === 'intro' ? 'block py-[14px]' : 'flex items-start justify-between gap-[12px] py-[12px] sm:block sm:py-[14px]'
                }`}
              >
                <span className="flex items-center gap-[8px] text-[12.5px] leading-[18px] text-faint transition-colors group-hover:text-zinc-300 max-sm:pt-[4px]">
                  <Icon aria-hidden className="h-[14px] w-[14px] flex-shrink-0" strokeWidth={1.75} />
                  {c.label}
                </span>
                {mode === 'intro' ? (
                  <span className="mt-[6px] block text-[13px] leading-[20px] text-zinc-300 [text-wrap:pretty]">{c.line}</span>
                ) : loading ? (
                  <Skeleton className="h-[22px] w-[88px] sm:mt-[6px]" />
                ) : (
                  <span className="flex min-w-0 flex-col items-end sm:items-start">
                    <span className="flex min-w-0 items-baseline gap-[6px] sm:mt-[4px]">
                      <span className="text-[20px] font-medium leading-[26px] tracking-[-0.02em] tabular-nums text-white">{c.value}</span>
                      {c.unit && <span className="truncate text-[12.5px] leading-[18px] text-zinc-400">{c.unit}</span>}
                    </span>
                    {c.line ? (
                      <span className="mt-[2px] block max-w-full truncate text-[12.5px] leading-[18px] tabular-nums text-faint">{c.line}</span>
                    ) : (
                      <span aria-hidden className="mt-[2px] hidden min-h-[18px] sm:block" />
                    )}
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
