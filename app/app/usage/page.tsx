'use client'

/**
 * Usage (/app/usage) — IA restructure §5.2.
 *
 * Account-wide usage for the current billing cycle. The quota meters read
 * /api/usage/account (lib/usage/describe.ts): usage pooled across every project
 * of the account, the most each may reach, and the month-end projection; the
 * same description an agent gets from the MCP usage read. AI credits still
 * come from /api/billing/usage. API requests have no meter: they are unlimited
 * on every plan, so there is no quota to show. Flat kit — solid violet meters,
 * mono numerals, no gradients/glows.
 *
 * Honesty: we render only metrics the endpoint actually returns. "Autonomy runs
 * this cycle" and the per-day chart from the report need data sources that
 * aren't wired yet, so they're intentionally absent rather than faked. The
 * "may take up to an hour to refresh" note is kept as an honesty beat.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { notFound, useRouter } from 'next/navigation'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { planAllowsOverage } from '@/lib/pricing/catalog'
import { Database, HardDrive, Bot, Users, ArrowUpRight, AlertTriangle, ShieldCheck, Sparkles, Globe, Wallet, Info, RefreshCw } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import { EmptyState, INPUT_BASE, KitButton, KitNote, KitCard, KitCardHeader, KitCardBody, PageHeader, Skeleton } from '@/components/inspector/kit'
import { EDGE, PAGE_GUTTER, PAGE_WIDTH, PLATE, R_PANEL } from '@/components/console/tokens'

interface UsageData {
  planName: string
  aiCreditsUsed: number
  monthlyAiCredits: number | null
  aiFunctionInvocationsUsed: number
  maxAiFunctionInvocationsPerMonth: number | null
  monthlyActiveUsersUsed: number
  maxMonthlyActiveUsers: number | null
  maxPostgresStorageMb: number | null
  dbStorageUsedMb: number
  maxFileStorageMb: number | null
  fileStorageUsedMb: number
  resetAt: string
}

interface AxisDescription {
  axis: 'mau' | 'fn_runs' | 'egress_bytes' | 'db_bytes' | 'file_bytes'
  label: string
  unit: 'users' | 'runs' | 'bytes'
  used: number
  included: number | null
  cap: number | null
  projected: number
  /** Usage past the plan can be charged on this axis (egress: not until egress billing is on). */
  billable: boolean
  estimatedCents: number
  projectedCents: number
  grace: { overSince: string; graceEndsAt: string; restricted: boolean } | null
}

interface AccountUsage {
  period: string
  planName: string
  overage: {
    mode: 'off' | 'shadow' | 'enforce' | null
    spendLimitCents: number
    active: boolean
    estimatedCents: number
    projectedCents: number
  }
  graceDays: number
  axes: AxisDescription[]
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
function fmtBytes(bytes: number): string {
  return fmtStorage(bytes / (1024 * 1024))
}
function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
  note,
}: {
  icon: React.ElementType
  label: string
  used: number
  max: number | null
  format: (v: number) => string
  resetNote?: string
  /** A second line under the meter: the projection, or headroom past the plan. */
  note?: string
}) {
  const p = pct(used, max)
  const over = max !== null && (used > max || max === 0)
  const warn = !over && p >= 75
  const bar = over ? 'bg-rose-400' : warn ? 'bg-amber-400' : 'bg-violet-400'

  return (
    <div className={`relative ${PLATE} border ${EDGE} ${R_PANEL} px-4 py-3.5`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" strokeWidth={1.75} />
          <p className="truncate text-[12.5px] text-zinc-400">{label}</p>
        </div>
        {over && <span className="text-[12px] font-medium text-rose-300">Over the limit</span>}
      </div>

      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={`text-[20px] font-semibold leading-[26px] tracking-[-0.02em] tabular-nums ${over ? 'text-rose-300' : warn ? 'text-amber-200' : 'text-zinc-50'}`}>
          {format(used)}
        </span>
        <span className="text-[12.5px] tabular-nums text-zinc-500">
          of {max === null ? 'unlimited' : format(max)}
        </span>
      </div>

      {max !== null && (
        <div
          className="mt-2.5 h-[5px] overflow-hidden rounded-full bg-white/[0.06]"
          role="meter"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={p}
        >
          <div className={`h-full rounded-full ${bar} transition-[width] duration-700`} style={{ width: `${Math.max(p, used > 0 ? 2 : 0)}%` }} />
        </div>
      )}
      {note && <p className="mt-2 text-[12px] leading-[17px] text-zinc-500">{note}</p>}
      {resetNote && <p className="mt-1.5 text-[12px] tabular-nums text-zinc-500">{resetNote}</p>}
    </div>
  )
}

const AXIS_ICON: Record<AxisDescription['axis'], React.ElementType> = {
  mau: Users,
  fn_runs: Bot,
  egress_bytes: Globe,
  db_bytes: Database,
  file_bytes: HardDrive,
}

/** One pooled quota: used against included, with the projection and any headroom past the plan. */
function AxisMeter({ a, resetNote, planBillsOverage }: { a: AxisDescription; resetNote?: string; planBillsOverage: boolean }) {
  const format = a.unit === 'bytes' ? fmtBytes : fmtNum
  const counter = a.axis === 'mau' || a.axis === 'fn_runs' || a.axis === 'egress_bytes'
  const notes: string[] = []
  if (a.included !== null && a.projected > a.used) notes.push(`≈ ${format(a.projected)} by month end`)
  if (a.included !== null && a.cap !== null && a.cap > a.included) {
    notes.push(`up to ${format(a.cap)} within your spend limit`)
  }
  // On a plan that bills other axes, say plainly which one it does not: the
  // spend limit never buys more of it, and it is never on an invoice.
  if (planBillsOverage && !a.billable && a.included !== null) notes.push('not billed past the plan')
  return (
    <Meter
      icon={AXIS_ICON[a.axis]}
      label={a.label}
      used={a.used}
      max={a.included}
      format={format}
      note={notes.join(' · ') || undefined}
      resetNote={counter ? resetNote : undefined}
    />
  )
}

/** Grace and restriction, stated with their dates. Only database and egress have one. */
function GraceNotices({ axes, graceDays }: { axes: AxisDescription[]; graceDays: number }) {
  const notices = axes.filter((a) => a.grace)
  if (!notices.length) return null
  return (
    <div className="mt-4 flex flex-col gap-2">
      {notices.map((a) => {
        const g = a.grace!
        const effect =
          a.axis === 'db_bytes'
            ? 'the data API is read-only (reads and deletes still work)'
            : 'files are not served to your end users (API responses are never cut)'
        return (
          <KitNote key={a.axis} tone="warn" title={`${a.label} is over its limit`}>
            {g.restricted
              ? `Over since ${fmtDay(g.overSince)}. The ${graceDays}-day grace period ended on ${fmtDay(g.graceEndsAt)}, so ${effect}. It lifts within minutes of usage coming back under the limit or the limit being raised.`
              : `Over since ${fmtDay(g.overSince)}. If it is still over on ${fmtDay(g.graceEndsAt)}, ${effect}.`}
          </KitNote>
        )
      })}
    </div>
  )
}

/** The spend limit as the Cloud route reports it: the owner's limit and what pays for it. */
interface SpendLimitState {
  limitCents: number
  /** Paid in advance and not yet drawn. The limit allows usage only up to it. */
  balanceCents: number
}

/** Where Stripe Checkout sent the owner back to: ?prepay=success&session_id=… or ?prepay=canceled. */
interface CheckoutReturn {
  outcome: 'success' | 'canceled'
  sessionId: string | null
}

function readCheckoutReturn(): CheckoutReturn | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const outcome = params.get('prepay')
  if (outcome !== 'success' && outcome !== 'canceled') return null
  return { outcome, sessionId: outcome === 'success' ? params.get('session_id') : null }
}

const CHECKOUT_CANCELED = 'Payment canceled. Your spend limit and prepaid balance did not change.'

/**
 * Usage past the plan this month and the spend limit that bounds it. Shown only
 * where it can apply: Cloud, a plan that allows overage (never Free), and
 * overage not off.
 *
 * The limit is paid for in advance and allows usage only up to the prepaid
 * balance. Lowering it applies at once. Raising it, or saving it again to top
 * the balance back up, sends a code to the owner's email; when the balance does
 * not cover the limit, confirming the code opens Stripe Checkout for the
 * difference, and the limit applies once Stripe reports the payment.
 */
function OverageCard({ usage, notice, onChanged }: { usage: AccountUsage; notice: string | null; onChanged: () => void }) {
  const [limit, setLimit] = useState<SpendLimitState | null>(null)
  const [presets, setPresets] = useState<number[]>([0, 5_000, 10_000, 25_000])
  const [choice, setChoice] = useState<string | null>(null)
  const [custom, setCustom] = useState('')
  const [pending, setPending] = useState<{ requestedCents: number; paymentCents: number; sentTo: string } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Read again whenever the account description reloads, so the balance moves
  // with the meters after a change or a payment.
  useEffect(() => {
    let cancelled = false
    fetch('/api/billing/spend-limit', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return
        setLimit({ limitCents: d.limitCents, balanceCents: d.balanceCents ?? 0 })
        if (d.presetsCents) setPresets(d.presetsCents)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [usage])

  const mode = usage.overage.mode
  if (mode === null || mode === 'off') return null

  const currentCents = limit?.limitCents ?? usage.overage.spendLimitCents
  const selected = choice ?? String(currentCents)
  // A custom limit set earlier is listed as itself rather than shown as the first preset.
  const options = presets.includes(currentCents) ? presets : [...presets, currentCents].sort((a, b) => a - b)
  const shortCents = limit ? Math.max(0, limit.limitCents - limit.balanceCents) : 0

  const save = async () => {
    const cents = selected === 'custom' ? Math.round(Number(custom) * 100) : Number(selected)
    if (!Number.isFinite(cents) || cents < 0 || (selected === 'custom' && !custom)) { setMessage('Enter a whole-dollar amount.'); return }
    setBusy(true); setMessage(null)
    try {
      const res = await fetch('/api/billing/spend-limit', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limitCents: cents }),
      })
      const data = await res.json()
      if (res.status === 202) setPending({ requestedCents: data.requestedCents, paymentCents: data.paymentCents ?? 0, sentTo: data.sentTo })
      else if (!res.ok) setMessage(data.error || 'Could not change the limit.')
      else { setMessage('Spend limit updated.'); onChanged() }
    } finally { setBusy(false) }
  }

  const confirm = async () => {
    setBusy(true); setMessage(null)
    try {
      const res = await fetch('/api/billing/spend-limit/confirm', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const data = await res.json()
      if (!res.ok) { setMessage(data.error || 'That code did not work.'); return }
      if (data.checkoutUrl) {
        // The limit changes once Stripe reports the payment, not before.
        setMessage('Opening Stripe to take the payment…')
        window.location.assign(data.checkoutUrl)
        return
      }
      setPending(null); setCode(''); setMessage('Spend limit changed.'); onChanged()
    } finally { setBusy(false) }
  }

  const shown = message ?? notice

  return (
    <KitCard className="mt-4">
      <KitCardHeader
        title="Usage beyond your plan"
        description={
          mode === 'shadow'
            ? 'Estimated only. Nothing is drawn from your balance yet.'
            : 'Paid in advance from your prepaid balance, never past your spend limit.'
        }
        actions={
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-[20px] font-medium tabular-nums leading-none text-white">{fmtCents(usage.overage.estimatedCents)}</span>
            <span className="text-[12px] text-zinc-500">so far · ≈ {fmtCents(usage.overage.projectedCents)} by month end</span>
          </span>
        }
      />
      <KitCardBody>
        <div className="flex flex-wrap items-center gap-2">
          <Wallet className="h-3.5 w-3.5 text-zinc-500" />
          <span className="text-[12.5px] text-zinc-300">Spend limit</span>
          <select
            className={`${INPUT_BASE} h-[32px] w-auto px-2.5 tabular-nums`}
            aria-label="Spend limit"
            value={selected}
            onChange={(e) => setChoice(e.target.value)}
            disabled={busy || !!pending}
          >
            {options.map((c) => (
              <option key={c} value={String(c)}>{c === 0 ? 'Off ($0)' : fmtCents(c)}</option>
            ))}
            <option value="custom">Custom…</option>
          </select>
          {selected === 'custom' && (
            <input
              className={`${INPUT_BASE} h-[32px] w-24 px-2.5 tabular-nums`}
              aria-label="Custom spend limit in US dollars"
              placeholder="USD"
              inputMode="numeric"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ''))}
              disabled={busy || !!pending}
            />
          )}
          <KitButton variant="secondary" size="sm" onClick={save} disabled={!!pending} loading={busy && !pending}>
Save
          </KitButton>
          <span className="text-[12.5px] text-zinc-500">Current: {currentCents === 0 ? 'Off' : fmtCents(currentCents)}</span>
        </div>
        {limit && (
          <p className="mt-2 text-[12.5px] tabular-nums text-zinc-400">
            Prepaid balance {fmtCents(limit.balanceCents)}
            {shortCents > 0 &&
              `, ${fmtCents(shortCents)} short of your ${fmtCents(limit.limitCents)} limit: usage past the plan stops at ${fmtCents(limit.balanceCents)}. Save the limit to top it up.`}
          </p>
        )}
        {pending && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-zinc-400">
              We sent a code to {pending.sentTo} to set the limit to {fmtCents(pending.requestedCents)}.
              {pending.paymentCents > 0 && ` Next, Stripe takes ${fmtCents(pending.paymentCents)} for your prepaid balance.`}
            </span>
            <input
              className={`${INPUT_BASE} h-[32px] w-28 px-2.5 font-mono tracking-[0.2em]`}
              aria-label="Six-digit code from your email"
              placeholder="000000"
              inputMode="numeric"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <KitButton variant="primary" size="sm" onClick={confirm} disabled={busy || code.replace(/\D/g, '').length !== 6}>
              {pending.paymentCents > 0 ? 'Confirm and pay' : 'Confirm'}
            </KitButton>
          </div>
        )}
        {shown && <p className="mt-2 text-[12.5px] text-zinc-400">{shown}</p>}
        <p className="mt-3 max-w-[72ch] text-[12.5px] leading-[19px] text-zinc-500">
          Usage past your plan is paid for in advance. Raising the limit takes a code from your email and, when your balance does
          not cover it, a card payment through Stripe for the difference. Each month&apos;s usage past the plan is drawn from the
          balance, never past your limit, and the rest carries over. With the limit off, every quota is a hard cap. Limits are
          checked every few minutes, so usage can run a little past one. Agents and API keys can read the limit but never change it.
        </p>
      </KitCardBody>
    </KitCard>
  )
}

export default function UsagePage() {
  // Billing-cycle surface: reads /api/billing/usage, which ships only with the
  // Cloud overlay, and plots consumption against plan ceilings that a
  // self-hosted deployment does not have.
  if (!CLOUD_CONTROL_PLANE) notFound()

  const router = useRouter()
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [account, setAccount] = useState<AccountUsage | null>(null)
  const [accountVersion, setAccountVersion] = useState(0)
  const [activity, setActivity] = useState<AutonomyActivity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Back from Stripe Checkout. Read once in the browser; nothing it decides is
  // rendered before the account loads, so the server render never differs.
  const [checkout] = useState(readCheckoutReturn)
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(
    checkout?.outcome === 'canceled' ? CHECKOUT_CANCELED : null,
  )

  // Report a paid Checkout Session so the balance and limit update now rather
  // than whenever Stripe's webhook arrives. Crediting is keyed on the session,
  // so this and the webhook together still credit the payment once.
  useEffect(() => {
    if (!checkout) return
    window.history.replaceState(null, '', window.location.pathname)
    if (!checkout.sessionId) return
    let cancelled = false
    fetch('/api/billing/spend-limit/prepay', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: checkout.sessionId }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) setCheckoutNotice(data.error || 'Stripe has not confirmed the payment yet. Your balance updates when it does.')
        else if (data.outcome === 'unpaid') setCheckoutNotice('Stripe is still processing the payment. Your balance updates when it clears.')
        else setCheckoutNotice(`Payment received. Your prepaid balance is ${fmtCents(data.balanceCents ?? 0)}.`)
      })
      .catch(() => {
        if (!cancelled) setCheckoutNotice('Stripe has not confirmed the payment yet. Your balance updates when it does.')
      })
      .finally(() => {
        if (!cancelled) setAccountVersion((v) => v + 1)
      })
    return () => { cancelled = true }
  }, [checkout])

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

  // The pooled quotas. If this cannot load, the meters below fall back to the
  // plan summary rather than showing nothing.
  useEffect(() => {
    let cancelled = false
    fetch('/api/usage/account', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setAccount(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [accountVersion])

  const resetDate = usage
    ? new Date(usage.resetAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : ''
  const resetNote = usage ? `Resets ${resetDate}` : undefined

  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        <PageHeader
          className="!px-0"
          title="Usage"
          meta={usage ? <span className="text-[13px] text-zinc-500">{usage.planName} plan</span> : undefined}
          description="Everything this account has used in the current billing cycle, pooled across all of its projects."
          actions={
            <KitButton variant="secondary" iconRight={ArrowUpRight} onClick={() => router.push('/app/billing')}>
              Plans and billing
            </KitButton>
          }
        />

        {loading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-[104px] w-full rounded-[10px]" />
            ))}
          </div>
        ) : error ? (
          <div className={`${PLATE} border ${EDGE} ${R_PANEL}`}>
            <EmptyState
              icon={AlertTriangle}
              title="Usage did not load"
              description="The usage service did not answer. Your quotas and limits are still enforced."
              action={
                <KitButton icon={RefreshCw} onClick={() => location.reload()}>
                  Try again
                </KitButton>
              }
            />
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
              {account ? (
                account.axes.map((a) => (
                  <AxisMeter key={a.axis} a={a} resetNote={resetNote} planBillsOverage={account.axes.some((x) => x.billable)} />
                ))
              ) : (
                <>
                  <Meter icon={Bot} label="Function invocations" used={usage.aiFunctionInvocationsUsed} max={usage.maxAiFunctionInvocationsPerMonth} format={fmtNum} resetNote={resetNote} />
                  <Meter icon={Database} label="PostgreSQL storage" used={usage.dbStorageUsedMb} max={usage.maxPostgresStorageMb} format={fmtStorage} />
                  <Meter icon={HardDrive} label="File storage" used={usage.fileStorageUsedMb} max={usage.maxFileStorageMb} format={fmtStorage} />
                  <Meter icon={Users} label="Monthly active users" used={usage.monthlyActiveUsersUsed} max={usage.maxMonthlyActiveUsers} format={fmtNum} resetNote={resetNote} />
                </>
              )}
            </div>

            {account && <GraceNotices axes={account.axes} graceDays={account.graceDays} />}
            {/* Free has no usage past the plan, only hard caps, so there is nothing to set or pay for. */}
            {account && planAllowsOverage(account.planName) && (
              <OverageCard usage={account} notice={checkoutNotice} onChanged={() => setAccountVersion((v) => v + 1)} />
            )}

            {activity && (
              <KitCard className="mt-4">
                <KitCardHeader
                  title="Autonomy"
                  description="Included on every plan. Detection and repair run no model, so it never draws your credits"
                  actions={
                    <span className="inline-flex items-baseline gap-1.5">
                      <span className="text-[20px] font-medium tabular-nums leading-none text-white">{fmtNum(activity.runsThisCycle)}</span>
                      <span className="text-[12px] text-zinc-500">runs this cycle</span>
                    </span>
                  }
                />
                <KitCardBody>
                  <AutonomyChart perDay={activity.perDay} />
                </KitCardBody>
              </KitCard>
            )}

            <div className="mt-5">
              <KitNote tone="info" icon={Info} title="Counters lag a little">
                Counters can take up to an hour to reflect the latest activity. Autonomy runs never draw from your credits;
                keeping backends alive is included.
              </KitNote>
            </div>

            <p className="mt-4 text-[12.5px] text-zinc-500">
              Need more headroom?{' '}
              <Link href="/app/billing" className="font-medium text-zinc-200 underline-offset-2 hover:underline">
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
                className={`w-full rounded-[2px] ${d.count > 0 ? 'bg-violet-400/80' : 'bg-white/[0.06]'}`}
                style={{ height: h }}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[12px] tabular-nums text-zinc-500">
        <span>{label}</span>
        <span>Today</span>
      </div>
    </div>
  )
}
