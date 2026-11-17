'use client'

/**
 * Usage: what one organization used this billing cycle, pooled across its
 * projects, against what its plan includes. Rendered by
 * /app/org/[orgId]/usage on Backenly Cloud (and /app/usage, which forwards
 * there); every request names the organization, so the server answers for it
 * and refuses one the caller is not in.
 *
 * One list, read top to bottom (console team pages, 2026-11-16):
 *
 *   Usage  Resets Dec 1
 *   Pooled across every project in Northwind Labs.
 *
 *   Included in Pro
 *   Monthly active users   81,900 of 100,000   ━━━━━━━━━━━──   About 104,300 by Nov 30
 *   …one row per quota, then API requests, which are never capped
 *
 *   Past the plan            (Pro, read-only; the limit is changed on Billing)
 *   Self-healing             (checks this cycle, never metered)
 *
 * Only what the routes return is shown. The quotas are /api/usage/account
 * (lib/usage/describe.ts), the same description an agent reads over MCP; AI
 * credits and API requests are /api/billing/usage; the spend limit is
 * /api/billing/spend-limit; the checks are /api/account/autonomy-activity.
 *
 * Brightness says one thing per row, never hue: a quota on course to pass its
 * included amount before the reset, or at 90%, has a brighter bar, and one
 * past it a white bar, each with the words beside the bar in white. Storage rows carry no month-end projection:
 * their "projection" is the month's average, not where the month ends.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useOrgHrefs } from '@cloud/org-routing'
import { planAllowsOverage } from '@/lib/pricing/catalog'
import { planDisplayName } from '@/lib/entitlements/plan-names'
import { OrgShell } from '@/components/shell/OrgShell'
import { KitButton, KitButtonLink, KitNote, PageHeader, Skeleton } from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { Panel, Section } from '@/components/autonomy/rows'
import { measuredAgo } from '@/components/usage/measured-ago'
import { fetchSpendLimit, limitLabel, type SpendLimitState } from '@/components/usage/spend-limit'
import {
  fmtAgo,
  fmtBytes,
  fmtCents,
  fmtCount,
  fmtCycleLastDay,
  fmtDay,
  getJson,
  scoped,
} from '@/components/usage/format'

// ─── What the routes return ──────────────────────────────────────────────────

interface BillingUsage {
  planName: string
  aiCreditsUsed: number
  monthlyAiCredits: number | null
  apiRequestsUsed: string
  resetAt: string
  /** Whether the caller is the owner, who alone changes billing. */
  canManage?: boolean
}

type Axis = 'mau' | 'fn_runs' | 'egress_bytes' | 'db_bytes' | 'file_bytes'

interface AxisDescription {
  axis: Axis
  label: string
  unit: 'users' | 'runs' | 'bytes'
  used: number
  included: number | null
  cap: number | null
  /** Month-end projection for the counters; the month's average for storage. */
  projected: number
  billable: boolean
  estimatedCents: number
  projectedCents: number
  grace: { overSince: string; graceEndsAt: string; restricted: boolean } | null
  measuredAt?: string | null
}

/** AI credits with every part the credit gate counts (lib/entitlements/policy.ts AiCreditAllowance). */
export interface AiCredits {
  used: number
  plan: number
  bonus: number
  purchased: number
  cap: number
  left: number
}

interface AccountUsage {
  period: string
  /** The plan as it is sold ("Pro"). */
  planName: string
  /** The plan's code (BUILDER): what overage is decided on. */
  planCode: string
  /** Absent from an older server, null where credits are not capped. */
  aiCredits?: AiCredits | null
  overage: {
    mode: 'off' | 'shadow' | 'enforce' | null
    /** The limit in force: the owner's, up to what is prepaid. */
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
  /** The newest check this cycle; null when none has run since it began. */
  lastAt?: string | null
}

interface PageData {
  usage: BillingUsage
  account: AccountUsage
  /** null when it could not be read: its section says so. */
  activity: AutonomyActivity | null
  spend: SpendLimitState | null
  orgName: string | null
}

// ─── The rows ────────────────────────────────────────────────────────────────

/** The order an owner reads them in: who uses the product, then what it runs, stores and sends. */
const AXIS_ORDER: Axis[] = ['mau', 'fn_runs', 'db_bytes', 'file_bytes', 'egress_bytes']

const AXIS_LABEL: Record<Axis, string> = {
  mau: 'Monthly active users',
  fn_runs: 'Function runs',
  db_bytes: 'Database storage',
  file_bytes: 'File storage',
  egress_bytes: 'Data transfer',
}

type Tone = 'normal' | 'warn' | 'over'

interface Quota {
  key: string
  label: string
  used: number
  included: number | null
  format: (n: number) => string
  tone: Tone
  /** The one fact on the right, in words. */
  fact: string | null
}

/**
 * One quota as a row: `warn` when the server's projection passes the included
 * amount before the reset (counters only) or 90% is used, `over` when it is past.
 */
function quotaOf(a: AxisDescription, cycleLastDay: string, now: number): Quota {
  const format = a.unit === 'bytes' ? fmtBytes : fmtCount
  const storage = a.axis === 'db_bytes' || a.axis === 'file_bytes'
  const included = a.included
  let tone: Tone = 'normal'
  let fact: string | null = null

  if (included !== null) {
    const share = included > 0 ? a.used / included : a.used > 0 ? Infinity : 0
    const projectedPast = !storage && a.projected > included
    if (a.used > included || (included === 0 && a.used > 0)) {
      tone = 'over'
      fact = 'Over the plan'
    } else if (a.used === included && included > 0) {
      tone = 'over'
      fact = 'At the plan’s limit'
    } else if (projectedPast) {
      tone = 'warn'
      fact = `About ${format(a.projected)} by ${cycleLastDay}`
    } else if (share >= 0.9) {
      tone = 'warn'
      fact = `${Math.floor(share * 100)}% used`
    }
  }

  if (!fact) {
    if (a.axis === 'db_bytes') {
      const ago = measuredAgo(a.measuredAt, now)
      fact = ago ? ago.charAt(0).toUpperCase() + ago.slice(1) : 'Measured just now'
    } else if (a.axis === 'egress_bytes') {
      fact = 'Updates hourly'
    } else if (included === null) {
      fact = 'Not capped'
    } else if (!storage && a.projected > a.used) {
      fact = `About ${format(a.projected)} by ${cycleLastDay}`
    }
  }

  return { key: a.axis, label: AXIS_LABEL[a.axis] ?? a.label, used: a.used, included, format, tone, fact }
}

/**
 * AI credits, against everything the account has this month: the plan's
 * credits plus bonus and bought ones, the numbers the credit gate itself
 * counts (GET /api/usage/account, aiCredits). The row used to read "575 of
 * 200" against the plan's alone while the gate, which counts the other two,
 * still let calls through (production QA re-test, 2026-11-16, #98).
 *
 * Without those numbers (an older server) it falls back to the plan's amount,
 * and then says only what is known, that the plan's credits are used up.
 */
export function aiCreditsQuota(usage: BillingUsage, credits?: AiCredits | null): Quota {
  if (credits) {
    const extra = [
      credits.bonus > 0 ? `${fmtCount(credits.bonus)} bonus` : null,
      credits.purchased > 0 ? `${fmtCount(credits.purchased)} bought` : null,
    ].filter(Boolean)
    let tone: Tone = 'normal'
    let fact = extra.length > 0 ? `${fmtCount(credits.plan)} plan + ${extra.join(' + ')}` : 'Typed MCP tools never use credits'
    if (credits.cap > 0 && credits.used >= credits.cap) {
      tone = 'over'
      fact = 'All credits used'
    } else if (credits.cap > 0 && credits.used / credits.cap >= 0.9) {
      tone = 'warn'
      fact = `${Math.floor((credits.used / credits.cap) * 100)}% used`
    }
    return { key: 'ai', label: 'AI credits', used: credits.used, included: credits.cap, format: fmtCount, tone, fact }
  }
  const included = usage.monthlyAiCredits
  const used = usage.aiCreditsUsed
  let tone: Tone = 'normal'
  let fact: string | null = included === null ? 'Not capped' : 'Typed MCP tools never use credits'
  if (included !== null && included > 0) {
    if (used >= included) {
      tone = 'over'
      fact = 'Plan credits used up'
    } else if (used / included >= 0.9) {
      tone = 'warn'
      fact = `${Math.floor((used / included) * 100)}% used`
    }
  }
  return { key: 'ai', label: 'AI credits', used, included, format: fmtCount, tone, fact }
}

/**
 * The row grid every list on this page shares, so the columns line up from
 * the first quota to the self-healing row:
 *
 *   xl (a 13-inch laptop)  label | value | bar | fact      one line
 *   lg                     label  value             fact   bar underneath
 *   narrower               label                   value  bar, then fact
 *
 * Breakpoints follow the viewport, and the sidebar takes 240px from md up, so
 * the two-line form waits for lg, where the content is wide enough for it. A
 * value never wraps; the label or the fact gives way first.
 */
const ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-[13px] lg:grid-cols-[minmax(0,180px)_auto_minmax(0,1fr)] xl:grid-cols-[minmax(0,184px)_minmax(0,184px)_minmax(0,1fr)_minmax(0,232px)] xl:gap-x-6'
const CELL_LABEL = 'min-w-0 text-[13.5px] leading-[20px] text-zinc-100'
const CELL_VALUE = 'whitespace-nowrap text-right text-[13.5px] leading-[20px] tabular-nums lg:text-left'
const CELL_BAR = 'col-span-2 lg:col-span-3 lg:row-start-2 xl:col-span-1 xl:col-start-3 xl:row-start-1'
/** Where the fact sits from lg up; below it each row says how wide it is. */
const CELL_FACT = 'min-w-0 text-[12.5px] leading-[18px] lg:col-span-1 lg:col-start-3 lg:row-start-1 lg:text-right xl:col-start-4'

// Monochrome: the words beside the bar carry the meaning, the fill only
// brightens as the quota fills.
const FACT_TONE: Record<Tone, string> = {
  normal: 'text-faint',
  warn: 'font-medium text-zinc-50',
  over: 'font-medium text-zinc-50',
}

const FILL_TONE: Record<Tone, string> = {
  normal: 'bg-zinc-400',
  warn: 'bg-zinc-200',
  over: 'bg-zinc-50',
}

function Bar({ used, included, tone }: { used: number; included: number; tone: Tone }) {
  const share = included > 0 ? Math.min(1, used / included) : used > 0 ? 1 : 0
  // The numbers beside it say the same thing in words, so the bar is not read out.
  return (
    <span aria-hidden className="block h-[4px] overflow-hidden rounded-full bg-white/[0.08]">
      <span
        className={`block h-full rounded-full ${FILL_TONE[tone]}`}
        style={{ width: `${share * 100}%`, minWidth: used > 0 ? 4 : 0 }}
      />
    </span>
  )
}

function QuotaRow({ q }: { q: Quota }) {
  return (
    <li className={ROW}>
      <span className={CELL_LABEL}>{q.label}</span>
      <span className={CELL_VALUE}>
        <span className="text-zinc-100">{q.format(q.used)}</span>
        {q.included !== null && <span className="text-faint"> of {q.format(q.included)}</span>}
      </span>
      {q.included !== null ? (
        <span className={CELL_BAR}>
          <Bar used={q.used} included={q.included} tone={q.tone} />
        </span>
      ) : (
        <span aria-hidden className="hidden xl:block" />
      )}
      {q.fact && <span className={`col-span-2 ${CELL_FACT} ${FACT_TONE[q.tone]}`}>{q.fact}</span>}
    </li>
  )
}

/**
 * A row in the same grid whose third cell is words rather than a bar. On a
 * phone both facts share the second line. A cell with nothing in it is left
 * out, so a phone does not stack an empty line.
 */
function FactRow({ label, value, middle, fact }: { label: ReactNode; value: ReactNode; middle?: ReactNode; fact?: ReactNode }) {
  return (
    <li className={ROW}>
      <span className={CELL_LABEL}>{label}</span>
      <span className={CELL_VALUE}>{value}</span>
      {middle ? (
        <span className="col-span-1 min-w-0 self-start text-[12.5px] leading-[18px] text-faint lg:col-span-3 lg:row-start-2 lg:self-center xl:col-span-1 xl:col-start-3 xl:row-start-1">
          {middle}
        </span>
      ) : (
        <span aria-hidden className="hidden xl:block" />
      )}
      {fact && (
        <span className={`${middle ? 'col-span-1 self-start text-right lg:self-center' : 'col-span-2'} ${CELL_FACT} text-faint`}>{fact}</span>
      )}
    </li>
  )
}

/** Rows the size of the real ones, so nothing moves when the numbers arrive. */
function SkeletonRows({ count }: { count: number }) {
  return (
    <ul aria-hidden className="divide-y divide-white/[0.06]">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className={ROW}>
          <span className="flex h-[20px] items-center">
            <Skeleton className="h-[12px] w-[128px]" />
          </span>
          <span className="flex h-[20px] items-center justify-end lg:justify-start">
            <Skeleton className="h-[12px] w-[96px]" />
          </span>
          <span className={CELL_BAR}>
            <Skeleton className="h-[4px] w-full rounded-full" />
          </span>
          <span className={`col-span-2 ${CELL_FACT} flex h-[18px] items-center lg:justify-end`}>
            <Skeleton className="h-[12px] w-[112px]" />
          </span>
        </li>
      ))}
    </ul>
  )
}

/** An error inside the panel it belongs to: what failed, what still works, and Retry. */
function ErrorRow({ title, hint, onRetry }: { title: string; hint?: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
      <AlertTriangle aria-hidden className="h-4 w-4 flex-shrink-0 text-zinc-50" strokeWidth={1.75} />
      <div className="min-w-0 flex-[1_1_240px]">
        <p className="text-[13.5px] leading-[20px] text-zinc-100">{title}</p>
        {hint && <p className="mt-0.5 text-[12.5px] leading-[18px] text-faint">{hint}</p>}
      </div>
      <KitButton icon={RefreshCw} onClick={onRetry}>
        Retry
      </KitButton>
    </div>
  )
}

// ─── Sections ────────────────────────────────────────────────────────────────

/** Grace and restriction, with their dates. Only database storage and data transfer have one. */
function GraceNotices({ axes, graceDays }: { axes: AxisDescription[]; graceDays: number }) {
  const notices = axes.filter((a) => a.grace)
  if (!notices.length) return null
  return (
    <div className="flex flex-col gap-2">
      {notices.map((a) => {
        const g = a.grace!
        const label = AXIS_LABEL[a.axis] ?? a.label
        const effect =
          a.axis === 'db_bytes'
            ? 'the data API is read-only (reads and deletes still work)'
            : 'files are not served to your end users (API responses are never cut)'
        return (
          <KitNote key={a.axis} tone="warn" icon={AlertTriangle} title={`${label} is over the plan`}>
            {g.restricted
              ? `Over since ${fmtDay(g.overSince, { utc: true })}. The ${graceDays}-day grace period ended on ${fmtDay(g.graceEndsAt, { utc: true })}, so ${effect}. That lifts within minutes of usage coming back under the plan.`
              : `Over since ${fmtDay(g.overSince, { utc: true })}. If it is still over on ${fmtDay(g.graceEndsAt, { utc: true })}, ${effect}.`}
          </KitNote>
        )
      })}
    </div>
  )
}

/**
 * Usage past the plan this cycle: what it has cost, where it is heading, and
 * the limit and prepaid balance that bound it. Read-only; the limit is changed
 * on Billing, by the owner.
 */
function PastThePlan({
  account,
  spend,
  cycleLastDay,
  changeHref,
  onRetry,
}: {
  account: AccountUsage
  spend: SpendLimitState | null
  cycleLastDay: string
  /** Billing's spend-limit section, for an owner; null for everyone else. */
  changeHref: string | null
  onRetry: () => void
}) {
  if (!spend) {
    return (
      <Panel>
        <ErrorRow title="Could not load your spend limit. Try again." hint="Usage past the plan still stops at your limit." onRetry={onRetry} />
      </Panel>
    )
  }
  const { estimatedCents, projectedCents, mode } = account.overage
  // What can actually run past the plan this month: the limit, up to what is prepaid.
  const effective = Math.min(spend.limitCents, spend.balanceCents)
  const shadow = mode === 'shadow'
  // Where the month is heading, capped by what can run: nothing past a quota runs unpaid.
  let projectionCents: number | null = null
  let consequence: string | null = null
  if (shadow) {
    if (projectedCents > estimatedCents) projectionCents = projectedCents
    consequence = 'Estimates only for now. Nothing is drawn from your balance.'
  } else if (spend.limitCents === 0) {
    consequence = 'The spend limit is off, so usage stops at each quota.'
  } else if (spend.balanceCents <= 0) {
    consequence = 'Nothing is prepaid, so usage stops at each quota.'
  } else {
    if (projectedCents > estimatedCents) projectionCents = Math.min(projectedCents, effective)
    if (projectedCents > effective) consequence = `Usage stops at each quota once ${fmtCents(effective)} is used.`
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
        <div className="min-w-0 flex-[1_1_320px]">
          <p className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[13.5px] leading-[20px] text-faint">
            <span>
              <span className="tabular-nums text-zinc-100">{fmtCents(estimatedCents)}</span> so far
            </span>
            {projectionCents !== null && (
              <span>
                About <span className="tabular-nums text-zinc-100">{fmtCents(projectionCents)}</span> by {cycleLastDay}
              </span>
            )}
            <span>
              Limit <span className="tabular-nums text-zinc-100">{limitLabel(spend.limitCents)}</span>
            </span>
            <span>
              Prepaid <span className="tabular-nums text-zinc-100">{fmtCents(spend.balanceCents)}</span>
            </span>
          </p>
          {consequence && <p className="mt-1.5 text-[12.5px] leading-[18px] text-zinc-400">{consequence}</p>}
        </div>
        {changeHref && <KitButtonLink href={changeHref}>Change limit</KitButtonLink>}
      </div>
    </Panel>
  )
}

/** The self-healing loop's checks this cycle: never metered on any plan. */
function SelfHealing({ activity, now, onRetry }: { activity: AutonomyActivity | null; now: number; onRetry: () => void }) {
  if (!activity) {
    return (
      <Panel>
        <ErrorRow title="Could not load self-healing checks. Try again." hint="Checks keep running either way." onRetry={onRetry} />
      </Panel>
    )
  }
  const ran = activity.runsThisCycle > 0
  return (
    <Panel>
      <ul>
        <FactRow
          label={
            <span className="relative">
              {/* Violet marks what Backenly itself does. It hangs in the margin so the label lines up with the quotas above. */}
              <span aria-hidden className="absolute -left-[13px] top-1/2 h-[6px] w-[6px] -translate-y-1/2 rounded-full bg-violet-400" />
              Self-healing checks
            </span>
          }
          value={
            ran ? (
              <>
                <span className="text-zinc-100">{fmtCount(activity.runsThisCycle)}</span>
                <span className="text-faint"> this cycle</span>
              </>
            ) : (
              <span className="text-faint">None this cycle</span>
            )
          }
          middle={
            ran
              ? activity.lastAt
                ? `Last check ${fmtAgo(activity.lastAt, now)}`
                : null
              : 'Starts once your agent builds something'
          }
          fact="Never metered"
        />
      </ul>
    </Panel>
  )
}

// ─── The page ────────────────────────────────────────────────────────────────

/** Re-renders every `ms`, so a relative time stays true while the page is open. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: PageData }

export function UsageView({ orgId }: { orgId?: string | null }) {
  const router = useRouter()
  const hrefs = useOrgHrefs()
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const now = useNow(15_000)
  const retry = () => {
    setLoad({ state: 'loading' })
    setAttempt((n) => n + 1)
  }

  // Stripe Checkout used to send owners back here after paying for a spend
  // limit; the limit lives on Billing now, so a return from a session opened
  // before that change is passed on with its query, and Billing reports it.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('prepay')) router.replace(`${hrefs.billing}${window.location.search}`)
  }, [router, hrefs.billing])

  // The page is keyed by organization, so a new one starts here from 'loading'.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Everything the page shows, in parallel, then rendered once.
      const [usage, account, activity, spend, orgs] = await Promise.all([
        getJson<BillingUsage>(scoped('/api/billing/usage', orgId)),
        getJson<AccountUsage>(scoped('/api/usage/account', orgId)),
        getJson<AutonomyActivity>(scoped('/api/account/autonomy-activity', orgId)),
        fetchSpendLimit(orgId),
        orgId ? getJson<{ orgs?: Array<{ id: string; name: string }> }>('/api/org/list') : Promise.resolve(null),
      ])
      if (cancelled) return
      if (!usage.ok && usage.status === 401) {
        router.push(`/auth/login?redirect=${encodeURIComponent(window.location.pathname)}`)
        return
      }
      if (!usage.ok || !account.ok || !Array.isArray(account.data?.axes)) {
        setLoad({ state: 'error' })
        return
      }
      const orgName = orgs && orgs.ok ? (orgs.data.orgs?.find((o) => o.id === orgId)?.name ?? null) : null
      setLoad({
        state: 'ready',
        data: {
          usage: usage.data,
          account: account.data,
          activity: activity.ok ? activity.data : null,
          spend,
          orgName,
        },
      })
    })()
    return () => {
      cancelled = true
    }
  }, [orgId, attempt, router])

  const data = load.state === 'ready' ? load.data : null
  const resetAt = data?.usage.resetAt ?? null
  const cycleLastDay = resetAt ? fmtCycleLastDay(resetAt, now) : ''

  const quotas = useMemo(() => {
    if (!data) return []
    const byAxis = new Map(data.account.axes.map((a) => [a.axis, a]))
    const known = AXIS_ORDER.flatMap((axis) => (byAxis.has(axis) ? [quotaOf(byAxis.get(axis)!, cycleLastDay, now)] : []))
    const others = data.account.axes.filter((a) => !AXIS_ORDER.includes(a.axis)).map((a) => quotaOf(a, cycleLastDay, now))
    return [...known, ...others, aiCreditsQuota(data.usage, data.account.aiCredits)]
  }, [data, cycleLastDay, now])

  const planName = data ? planDisplayName(data.usage.planName) : null
  const canManage = data?.usage.canManage !== false
  const overageOn = !!data && planAllowsOverage(data.account.planCode) && (data.account.overage.mode === 'enforce' || data.account.overage.mode === 'shadow')
  const apiRequests = data ? Number.parseInt(data.usage.apiRequestsUsed, 10) || 0 : 0

  const header = (
    <PageHeader
      flush
      title="Usage"
      meta={
        load.state === 'loading' ? (
          <Skeleton className="h-[13px] w-[84px]" />
        ) : resetAt ? (
          <span className="text-[13px] tabular-nums text-faint">Resets {fmtDay(resetAt, { utc: true, now })}</span>
        ) : undefined
      }
      description={
        load.state === 'loading' ? (
          <Skeleton className="my-[4px] h-[14px] w-[300px] max-w-full" />
        ) : data ? (
          orgId ? (
            `Pooled across every project in ${data.orgName ?? 'this organization'}.`
          ) : (
            'Pooled across every project on your account.'
          )
        ) : undefined
      }
    />
  )

  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        {header}

        {load.state === 'loading' && (
          <div className="flex flex-col gap-[40px]" aria-busy="true">
            <div>
              {/* The heading names the plan, which is not known yet. */}
              <div className="mb-2.5 flex min-h-[28px] items-center">
                <Skeleton className="h-[13px] w-[124px]" />
              </div>
              <Panel>
                <SkeletonRows count={7} />
              </Panel>
            </div>
            <Section id="self-healing" title="Self-healing">
              <Panel>
                <SkeletonRows count={1} />
              </Panel>
            </Section>
          </div>
        )}

        {load.state === 'error' && (
          <Section id="included" title="Included in your plan">
            <Panel>
              <ErrorRow
                title="Could not load usage. Try again."
                hint="Your quotas and limits are still enforced, and nothing you built is affected."
                onRetry={retry}
              />
            </Panel>
          </Section>
        )}

        {data && (
          <div className="flex flex-col gap-[40px]">
            {data.account.axes.some((a) => a.grace) && <GraceNotices axes={data.account.axes} graceDays={data.account.graceDays} />}

            <div>
              <Section id="included" title={`Included in ${planName}`}>
                <Panel>
                  <ul className="divide-y divide-white/[0.06]">
                    {quotas.map((q) => (
                      <QuotaRow key={q.key} q={q} />
                    ))}
                    <FactRow
                      label="API requests"
                      value={<span className="text-zinc-100">{fmtCount(apiRequests)}</span>}
                      fact="Not capped"
                    />
                  </ul>
                </Panel>
              </Section>
              {planName === 'Free' ? (
                <p className="mt-3 text-[12.5px] leading-[18px] text-faint">Free has hard limits. Nothing is billed.</p>
              ) : planAllowsOverage(data.account.planCode) && !overageOn ? (
                <p className="mt-3 text-[12.5px] leading-[18px] text-faint">Every quota is a hard cap. Nothing is billed past the plan.</p>
              ) : null}
            </div>

            {overageOn && (
              <Section id="past-the-plan" title="Past the plan">
                <PastThePlan
                  account={data.account}
                  spend={data.spend}
                  cycleLastDay={cycleLastDay}
                  changeHref={canManage ? `${hrefs.billing}#spend-limit` : null}
                  onRetry={retry}
                />
              </Section>
            )}

            <Section id="self-healing" title="Self-healing">
              <SelfHealing activity={data.activity} now={now} onRetry={retry} />
            </Section>
          </div>
        )}
      </div>
    </OrgShell>
  )
}
