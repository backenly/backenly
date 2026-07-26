'use client'

/**
 * Usage (/app/usage) — IA restructure §5.2.
 *
 * Account-wide usage for the current billing cycle, read from the existing
 * /api/billing/usage endpoint (the same source the old settings billing meter
 * used). Flat kit — solid violet meters, mono numerals, no gradients/glows.
 *
 * Honesty: we render only metrics the endpoint actually returns. "Autonomy runs
 * this cycle" and the per-day chart from the report need data sources that
 * aren't wired yet, so they're intentionally absent rather than faked. The
 * "may take up to an hour to refresh" note is kept as an honesty beat.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Database, HardDrive, Bot, Activity, Users, ArrowUpRight, Loader2, AlertTriangle, ShieldCheck, Sparkles } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import { SectionTitle, KitButton, KitNote, KitCard, KitCardHeader, KitCardBody } from '@/components/inspector/kit'

interface UsageData {
  planName: string
  aiCreditsUsed: number
  monthlyAiCredits: number | null
  aiFunctionInvocationsUsed: number
  maxAiFunctionInvocationsPerMonth: number | null
  apiRequestsUsed: string
  maxApiRequestsPerMonth: string | null
  apiQuotaIsLifetime: boolean
  monthlyActiveUsersUsed: number
  maxMonthlyActiveUsers: number | null
  maxPostgresStorageMb: number | null
  dbStorageUsedMb: number
  maxFileStorageMb: number | null
  fileStorageUsedMb: number
  resetAt: string
}

interface AutonomyActivity {
  runsThisCycle: number
  perDay: { date: string; count: number }[]
  cycleStart: string
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.0', '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace('.0', '')}k`
  return n.toLocaleString()
}
function fmtStorage(mb: number): string {
  if (mb >= 1_024) return `${(mb / 1_024).toFixed(1).replace('.0', '')} GB`
  return `${Math.round(mb)} MB`
}
function pct(used: number, max: number | null): number {
  if (max === null) return 0
  if (max === 0) return 100
  return Math.min(100, Math.round((used / max) * 100))
}

function Meter({
  icon: Icon,
  label,
  used,
  max,
  format,
  resetNote,
}: {
  icon: React.ElementType
  label: string
  used: number
  max: number | null
  format: (v: number) => string
  resetNote?: string
}) {
  const p = pct(used, max)
  const over = max !== null && (used > max || max === 0)
  const warn = !over && p >= 75
  const bar = over ? 'bg-rose-400' : warn ? 'bg-amber-400' : 'bg-violet-500'

  return (
    <div className="relative rounded-xl border border-white/[0.07] bg-[#16171d] px-4 py-3.5 shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className="h-3 w-3 text-zinc-600 flex-shrink-0" />
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600 truncate">{label}</p>
        </div>
        {over && (
          <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-rose-300 bg-rose-500/10 border border-rose-500/20 px-1.5 py-0.5 rounded-full">
            Over
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-baseline gap-1.5">
        <span className={`font-mono text-[20px] font-medium tabular-nums leading-none ${over ? 'text-rose-300' : warn ? 'text-amber-500' : 'text-white'}`}>
          {format(used)}
        </span>
        <span className="font-mono text-[12px] tabular-nums text-zinc-600">
          / {max === null ? '∞' : format(max)}
        </span>
      </div>

      {max !== null && (
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
          <div className={`h-full rounded-full ${bar} transition-[width] duration-700`} style={{ width: `${p}%` }} />
        </div>
      )}
      {resetNote && <p className="mt-2 font-mono text-[10px] text-zinc-600">{resetNote}</p>}
    </div>
  )
}

export default function UsagePage() {
  const router = useRouter()
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [activity, setActivity] = useState<AutonomyActivity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res = await fetch('/api/billing/usage', { credentials: 'include' })
        if (res.status === 401) { router.push('/auth/login?redirect=/app/usage'); return }
        if (!res.ok) throw new Error('Failed to load usage')
        const data = await res.json()
        if (!cancelled) setUsage(data)
      } catch {
        if (!cancelled) setError('Could not load usage data.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    async function loadActivity() {
      try {
        const res = await fetch('/api/account/autonomy-activity', { credentials: 'include' })
        if (res.ok && !cancelled) setActivity(await res.json())
      } catch { /* non-blocking — the card just stays quiet if it can't load */ }
    }
    load()
    loadActivity()
    return () => { cancelled = true }
  }, [router])

  const resetDate = usage
    ? new Date(usage.resetAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : ''
  const resetNote = usage ? `Resets ${resetDate}` : undefined
  const apiReqUsed = usage ? parseInt(usage.apiRequestsUsed, 10) || 0 : 0
  const apiReqMax = usage?.maxApiRequestsPerMonth ? parseInt(usage.maxApiRequestsPerMonth, 10) : null

  return (
    <OrgShell>
      <div className="mx-auto w-full max-w-[1000px] px-6 py-8 lg:px-10">
        <SectionTitle
          title="Usage"
          description="Everything your account has used this billing cycle, across all projects."
          actions={<KitButton variant="primary" size="sm" iconRight={ArrowUpRight} onClick={() => router.push('/app/billing')}>Upgrade</KitButton>}
        />

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-24 text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-[12.5px]">Loading usage…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-500/15 bg-rose-500/[0.04] py-16 text-center">
            <AlertTriangle className="h-5 w-5 text-rose-400/70" />
            <p className="text-[13px] text-rose-300/70">{error}</p>
          </div>
        ) : usage ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {/*
                AI credits are enforced (a spent budget returns 402 on backend_chat
                and generate_function), so they must be visible here. The page
                already fetched them and rendered nothing, which meant the first
                signal a user got was their agent being refused.
              */}
              <Meter icon={Sparkles} label="AI credits" used={usage.aiCreditsUsed} max={usage.monthlyAiCredits} format={fmtNum} resetNote={resetNote} />
              <Meter icon={Bot} label="Function invocations" used={usage.aiFunctionInvocationsUsed} max={usage.maxAiFunctionInvocationsPerMonth} format={fmtNum} resetNote={resetNote} />
              <Meter
                icon={Activity}
                label="API requests"
                used={apiReqUsed}
                max={apiReqMax}
                format={fmtNum}
                resetNote={usage.apiQuotaIsLifetime ? 'Total · no reset' : resetNote}
              />
              <Meter icon={Database} label="PostgreSQL storage" used={usage.dbStorageUsedMb} max={usage.maxPostgresStorageMb} format={fmtStorage} />
              <Meter icon={HardDrive} label="File storage" used={usage.fileStorageUsedMb} max={usage.maxFileStorageMb} format={fmtStorage} />
              <Meter icon={Users} label="Monthly active users" used={usage.monthlyActiveUsersUsed} max={usage.maxMonthlyActiveUsers} format={fmtNum} resetNote={resetNote} />
            </div>

            {activity && (
              <KitCard className="mt-4">
                <KitCardHeader
                  title="Autonomy"
                  description="Included on every plan. Runs no model, so it never draws your credits"
                  actions={
                    <span className="inline-flex items-baseline gap-1.5">
                      <span className="font-mono text-[20px] font-medium tabular-nums leading-none text-white">{fmtNum(activity.runsThisCycle)}</span>
                      <span className="text-[11px] text-zinc-500">runs this cycle</span>
                    </span>
                  }
                />
                <KitCardBody>
                  <AutonomyChart perDay={activity.perDay} />
                </KitCardBody>
              </KitCard>
            )}

            <div className="mt-5">
              <KitNote tone="info" title="Usage refreshes periodically">
                Counters can take up to an hour to reflect the latest activity. Autonomy runs never draw from your credits;
                keeping backends alive is included.
              </KitNote>
            </div>

            <p className="mt-4 text-[12px] text-zinc-500">
              Need more headroom?{' '}
              <Link href="/app/billing" className="text-violet-300 hover:text-violet-200 underline underline-offset-2">
                Compare plans
              </Link>
              .
            </p>
          </>
        ) : null}
      </div>
    </OrgShell>
  )
}

// ─── Autonomy per-day chart ───────────────────────────────────────────────────
// Single-series bar chart, one bar per day of the cycle. Violet bars for days
// the loop ran, hairline ticks for quiet days. Flat kit — no gradients, mono
// axis labels. Real AuditLog counts; an empty cycle reads honestly empty.

function AutonomyChart({ perDay }: { perDay: { date: string; count: number }[] }) {
  const total = perDay.reduce((s, d) => s + d.count, 0)
  const max = Math.max(1, ...perDay.map((d) => d.count))

  if (total === 0) {
    return (
      <div className="flex items-center gap-2 py-2">
        <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600" />
        <p className="text-[12px] text-zinc-500">
          No autonomy runs recorded yet this cycle. The loop reports here as it works.
        </p>
      </div>
    )
  }

  const first = perDay[0]?.date
  const label = first
    ? new Date(first + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : ''

  return (
    <div>
      <div className="flex h-16 items-end gap-[3px]" role="img" aria-label={`Autonomy runs per day this cycle: ${total} total`}>
        {perDay.map((d) => {
          const h = d.count === 0 ? 2 : Math.max(4, Math.round((d.count / max) * 64))
          return (
            <div
              key={d.date}
              title={`${d.date}: ${d.count} run${d.count === 1 ? '' : 's'}`}
              className="flex min-w-[2px] flex-1 items-end"
            >
              <div
                className={`w-full rounded-[2px] ${d.count > 0 ? 'bg-violet-500/80' : 'bg-white/[0.06]'}`}
                style={{ height: h }}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-zinc-600">
        <span>{label}</span>
        <span>Today</span>
      </div>
    </div>
  )
}
