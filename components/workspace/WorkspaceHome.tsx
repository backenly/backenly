'use client'

/**
 * The Overview of a project that has something built (project console
 * decision 10, 2026-11-16). Five plain sections, each read from the page that
 * owns it and linking there by that page's sidebar name:
 *
 *   Waiting on you  1                                                 Autonomy
 *   🗑  Drop column spoilers on reviews                               [Review]
 *       From your agent   9,431 rows   Expires in 23 h   26 min ago
 *   Needs a look                     (only when true: a missing provider key,
 *                                     browser requests failing)
 *   Self-healing                                                      Autonomy
 *   ◔ Autopilot   Checked 40 s ago   Last fix 2 d ago
 *      ●────────────●────────────●────────────●      (SelfHealingLoop: one violet
 *    Check        Find          Fix        Re-check     trace a minute, on the
 *    27 checks    1 open        2 in 30 days 2 of 2     loop's own beat)
 *   Last 24 hours                                                   Monitoring
 *      Requests 18,641   Server errors 11 0.06%   Average response 62 ms
 *   Your backend          (BackendStrip: each cell opens its page)
 *   Database 8 tables   Auth & Users 37 users   Storage 1 bucket   Functions 4
 *
 * Overview summarizes and the owning page acts: nothing here approves, fixes
 * or changes anything (copying a fix prompt is the one exception). Every count
 * is the owning page's own: "Waiting on you" is useWaitingCount, the inbox's
 * and Autonomy's count; the Self-healing row reads /health and /autonomy as
 * Autonomy does, and checks `executionMode` before it says repairs happen;
 * Last 24 hours is Monitoring's route and labels.
 *
 * The loop came back on the founder's call (2026-11-16) as an instrument: the
 * old comet, glow and pulsing tiles stay gone. Also gone on purpose: the
 * 40-word receipts (Autonomy's Activity says them), the agent panel's
 * paragraphs, the Backend cards (the sidebar names those sections), and "19k".
 *
 * Each section fails on its own, with its own error row; a failure never reads
 * as "nothing waiting".
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { KeyRound, Globe, type LucideIcon } from 'lucide-react'
import { CopyButton, KitButtonLink, TextWithCode } from '@/components/inspector/kit'
import { Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow } from '@/components/console/states'
import { Time, useNow } from '@/components/console/Time'
import { formatTime } from '@/components/console/format'
import { FOCUS, FOCUS_INSET } from '@/components/console/tokens'
import { evolutionOf } from '@/components/autonomy/EvolutionRequestRow'
import { groupFindings } from '@/lib/core/finding-groups'
import { isEvolutionApprovalFinding } from '@/lib/core/types'
import { approvalTitle } from '@/lib/mcp/approval-title'
import { levelLabel, useAutonomyStatus, type AutonomyPendingApproval } from '@/lib/hooks/useAutonomyStatus'
import { useWaitingCount } from '@/lib/hooks/useWaitingCount'
import { useConnectionHealth } from '@/lib/hooks/useConnectionHealth'
import { sharedRead } from '@/lib/client/shared-read'
import { LOOP_STALE_MS, type SensorSummary } from './health-state'
import { ObservabilityStrip } from './ObservabilityStrip'
import { BackendStrip } from './BackendStrip'
import { SelfHealingLoop, type LoopStage } from './SelfHealingLoop'
import { LoopMark, type LoopMarkState } from '@/components/console/LoopMark'
import { approvalIcon, ARCHITECTURE_ICON, FIX_ICON, REMOVES } from '@/components/autonomy/row-icons'

// ── Shapes ────────────────────────────────────────────────────────────────────

/** The parts of a /health answer this page reads. */
interface HealthData {
  /** The self-healing loop's last pass (per minute). Null: it has not run here. */
  lastReconciledAt: string | null
  /** Uncapped: open + held findings. */
  actionableTotal?: number
  /** Uncapped: findings held for a person. */
  needsAttention?: number
  sensors?: SensorSummary | null
}

/** A call the coding agent parked for approval (GET /agent-approvals). */
interface AgentApproval {
  id: string
  status: string
  tool: string
  target: string
  requestedBy?: 'agent' | 'backenly'
  rowCount: number | null
  createdAt: string
  expiresAt: string
}

/** A missing provider key the build is waiting on (GET /build-status `blocked`). */
export interface BlockedItem {
  name: string
  type: string
  reason?: string
}

// ── Small parts ───────────────────────────────────────────────────────────────

/** A section heading's link to the page that owns the full view, named as the sidebar names it. */
function SideLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`rounded-[4px] text-[13px] leading-[20px] text-zinc-400 transition-colors duration-150 hover:text-white ${FOCUS}`}
    >
      {children}
    </Link>
  )
}

/** "Expires in 23 h", "Expires in 40 min", then the date. */
function expiresIn(iso: string, now: number): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'Expired'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `Expires in ${Math.max(1, min)} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `Expires in ${h} h`
  return `Expires ${formatTime(iso, 'date', { now })}`
}

// ── Waiting on you ────────────────────────────────────────────────────────────

interface WaitingItem {
  key: string
  icon: LucideIcon
  destructive: boolean
  title: ReactNode
  facts: ReactNode[]
  href: string
}

function WaitingSection({
  projectId,
  pending,
  autonomyError,
}: {
  projectId: string
  /** The trust report's held items, or null until it has loaded. */
  pending: AutonomyPendingApproval[] | null
  autonomyError: boolean
}) {
  const waiting = useWaitingCount(projectId)
  const now = useNow()
  const [calls, setCalls] = useState<AgentApproval[] | null>(null)
  const [callsError, setCallsError] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const base = `/app/projects/${projectId}`

  const loadCalls = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/agent-approvals`, { credentials: 'include' })
      const body = res.ok ? await res.json() : null
      if (!Array.isArray(body?.approvals)) throw new Error('no approvals')
      setCalls(body.approvals)
      setCallsError(false)
    } catch {
      setCallsError(true)
    } finally {
      setRetrying(false)
    }
  }, [projectId])

  // Re-read the rows whenever the shared count moves, so they never disagree for long.
  useEffect(() => {
    if (waiting.total && waiting.total > 0) void loadCalls()
  }, [waiting.total, loadCalls])

  const items = useMemo<WaitingItem[] | null>(() => {
    if (calls === null && !callsError) return null
    if (pending === null && !autonomyError) return null
    const out: WaitingItem[] = []
    // Calls the agent parked come first: they expire unanswered.
    for (const a of (calls ?? []).filter((c) => c.status === 'pending')) {
      const destructive = REMOVES.test(a.tool)
      out.push({
        key: `approval-${a.id}`,
        icon: approvalIcon(a.tool),
        destructive,
        title: <TextWithCode text={approvalTitle(a.tool, a.target)} />,
        facts: [
          a.requestedBy === 'backenly' ? 'From Backenly' : 'From your agent',
          ...(typeof a.rowCount === 'number' ? [`${a.rowCount.toLocaleString('en-US')} ${a.rowCount === 1 ? 'row' : 'rows'}`] : []),
          now === null ? '' : expiresIn(a.expiresAt, now),
          <Time key="at" iso={a.createdAt} />,
        ],
        href: `${base}/autonomy#approval-${a.id}`,
      })
    }
    const all = (pending ?? []).map((p) => ({ ...p, details: p.details ?? null }))
    for (const r of all.filter((p) => isEvolutionApprovalFinding(p.type))) {
      out.push({
        key: `finding-${r.id}`,
        icon: ARCHITECTURE_ICON,
        destructive: false,
        title: evolutionOf(r)?.summary.headline ?? r.reason ?? 'An architecture change is waiting',
        facts: ['Prepared by Backenly', <Time key="at" iso={r.detectedAt} />],
        // Autonomy anchors an architecture change as an approval (EvolutionRequestRow).
        href: `${base}/autonomy#approval-${encodeURIComponent(r.id)}`,
      })
    }
    for (const g of groupFindings(all.filter((p) => !isEvolutionApprovalFinding(p.type)))) {
      out.push({
        key: `finding-${g.key}`,
        icon: FIX_ICON,
        destructive: false,
        title: g.title,
        facts: [
          'Held by Backenly',
          ...(g.members.length > 1 ? [`${g.members.length} findings`] : []),
          ...g.subjects.slice(0, 2).map((s) => (
            <code key={s} className="font-mono text-[11.5px] text-zinc-400">
              {s}
            </code>
          )),
          <Time key="at" iso={g.members[0]?.detectedAt} />,
        ],
        href: `${base}/autonomy#finding-${encodeURIComponent(g.key)}`,
      })
    }
    return out
  }, [calls, callsError, pending, autonomyError, base, now])

  const total = waiting.total
  // Nothing waits: no section at all. A count that could not be read is said, never shown as nothing.
  if (total === 0 || (total === null && !waiting.error)) return null

  const shown = (items ?? []).slice(0, 3)
  let body: ReactNode
  if (total === null) {
    body = <ErrorRow things="what’s waiting" onRetry={() => void loadCalls()} retrying={retrying} />
  } else if (items === null) {
    body = <RowSkeleton rows={Math.min(total, 3)} lead="well" />
  } else if (shown.length === 0) {
    // The count and the rows are read separately; say the count rather than nothing.
    body = callsError || autonomyError ? (
      <ErrorRow
        things="what’s waiting"
        stillWorks={`${total} ${total === 1 ? 'thing waits' : 'things wait'} on your approval.`}
        onRetry={() => {
          setRetrying(true)
          void loadCalls()
        }}
        retrying={retrying}
      />
    ) : (
      <RowList>
        <Row
          lead="none"
          title={<p className={ROW_TITLE}>{total} waiting on your approval</p>}
          actions={<KitButtonLink href={`${base}/autonomy#autonomy-waiting`} size="sm">Review</KitButtonLink>}
        />
      </RowList>
    )
  } else {
    body = (
      <RowList>
        {shown.map((it) => (
          <Row
            key={it.key}
            lead="well"
            icon={it.icon}
            title={<p className={ROW_TITLE}>{it.title}</p>}
            actions={
              <KitButtonLink href={it.href} size="sm">
                Review
              </KitButtonLink>
            }
          >
            <Facts>
              {it.facts.filter(Boolean).map((f, i) => (
                <Fact key={i}>{f}</Fact>
              ))}
            </Facts>
          </Row>
        ))}
        {(items?.length ?? 0) > shown.length && (
          <li>
            <Link
              href={`${base}/autonomy#autonomy-waiting`}
              className={`block px-[20px] py-[12px] text-[13px] leading-[20px] text-zinc-300 transition-colors duration-150 hover:bg-white/[0.02] hover:text-white ${FOCUS_INSET}`}
            >
              Show all {total}
            </Link>
          </li>
        )}
      </RowList>
    )
  }

  return (
    <Section id="overview-waiting" title="Waiting on you" count={total ?? undefined} aside={<SideLink href={`${base}/autonomy`}>Autonomy</SideLink>}>
      <Panel>{body}</Panel>
    </Section>
  )
}

// ── Needs a look ──────────────────────────────────────────────────────────────

function NeedsLookSection({ projectId, blocked }: { projectId: string; blocked: BlockedItem[] }) {
  const { health } = useConnectionHealth(projectId)
  const base = `/app/projects/${projectId}`
  const failing = (health?.failures ?? []).slice(0, 3)
  if (blocked.length === 0 && failing.length === 0) return null
  return (
    <Section id="overview-needs-look" title="Needs a look">
      <Panel>
        <RowList>
          {blocked.slice(0, 3).map((b) => (
            <Row
              key={`blocked-${b.name}`}
              lead="well"
              icon={KeyRound}
              title={
                <p className={ROW_TITLE}>
                  {b.name} needs {b.reason ? <code className="font-mono text-[12.5px]">{b.reason}</code> : 'a provider key'}
                </p>
              }
              actions={
                <KitButtonLink href={`${base}/integrations`} size="sm">
                  Add key
                </KitButtonLink>
              }
            >
              <Facts>
                <Fact>Waiting until the key is added in Integrations</Fact>
              </Facts>
            </Row>
          ))}
          {failing.map((f) => (
            <Row
              key={`origin-${f.origin}`}
              lead="well"
              icon={Globe}
              title={
                <p className={ROW_TITLE}>
                  <Link href={`${base}/connect?tab=api`} className={`rounded-[3px] hover:underline ${FOCUS}`}>
                    Browser requests from <code className="font-mono text-[12.5px]">{f.origin}</code> are failing
                  </Link>
                </p>
              }
              actions={<CopyButton value={f.fixPrompt} label="Copy fix prompt" showLabel />}
            >
              <Facts>
                <Fact>{f.count.toLocaleString('en-US')} failed in 24 h</Fact>
                <Fact>
                  <Time iso={f.lastSeen} prefix="Last" />
                </Fact>
              </Facts>
            </Row>
          ))}
        </RowList>
      </Panel>
    </Section>
  )
}

// ── Self-healing ──────────────────────────────────────────────────────────────

function SelfHealingSection({
  projectId,
  health,
  healthError,
  autonomy,
  autonomyLoading,
  onRetry,
}: {
  projectId: string
  health: HealthData | null
  healthError: boolean
  autonomy: ReturnType<typeof useAutonomyStatus>['status']
  autonomyLoading: boolean
  onRetry: () => void
}) {
  const now = useNow()
  const base = `/app/projects/${projectId}`
  let body: ReactNode
  if (!health && healthError) {
    body = <ErrorRow things="self-healing" stillWorks="Checks keep running either way." onRetry={onRetry} />
  } else if (!health || (autonomyLoading && !autonomy)) {
    body = <RowSkeleton rows={2} lead="none" />
  } else {
    const level = autonomy?.level ?? null
    const execution = autonomy?.executionMode ?? null
    const off = level === 'OFF'
    // The dial says what the owner chose; executionMode says whether this deployment applies anything at all.
    const watchingOnly = !off && execution !== null && !execution.repairsAreApplied
    const mode = off ? 'Off' : watchingOnly ? 'Watching only' : level ? levelLabel(level) : 'Self-healing'
    const last = health.lastReconciledAt
    const lastMs = last ? Date.parse(last) : NaN
    const stale = now !== null && Number.isFinite(lastMs) && now - lastMs >= LOOP_STALE_MS
    const sensors = health.sensors ?? null
    const blind = sensors?.errored.length ?? 0
    const found = Math.max(0, health.actionableTotal ?? 0)
    const fixes = autonomy ? autonomy.autonomousFixes : null
    const rechecked = autonomy && autonomy.verifiedRate !== null && fixes !== null ? Math.round(autonomy.verifiedRate * fixes) : null

    const facts: ReactNode[] = []
    if (off) facts.push('Records issues, changes nothing')
    else if (watchingOnly) facts.push('This deployment doesn’t apply repairs')
    if (!last) {
      facts.push(<span key="first" className="text-zinc-300">First check running</span>)
    } else if (stale) {
      facts.push(
        <span key="stale" className="font-medium text-zinc-50">
          <Time iso={last} prefix="Last check" />
        </span>,
      )
    } else {
      facts.push(<Time key="checked" iso={last} prefix="Checked" />)
    }
    if (blind > 0) {
      facts.push(
        <span key="blind" className="font-medium text-zinc-50">
          {blind} {blind === 1 ? 'check' : 'checks'} could not run
        </span>,
      )
    }
    if (!off && autonomy?.lastFixAt) facts.push(<Time key="fix" iso={autonomy.lastFixAt} prefix="Last fix" />)

    // The loop's four stages, each with the number its owning page shows.
    const stages: LoopStage[] = [
      {
        key: 'check',
        label: 'Check',
        value: !last ? 'Starting' : sensors ? (blind > 0 ? `${sensors.ran - blind} of ${sensors.ran} ran` : `${sensors.ran} checks`) : 'Every minute',
        attention: blind > 0,
      },
      { key: 'find', label: 'Find', value: last ? `${found} open` : '—', attention: found > 0 },
      {
        key: 'fix',
        label: 'Fix',
        value: off ? 'Off' : watchingOnly ? 'Not applied here' : fixes === null ? '—' : `${fixes} in 30 days`,
        dim: off || watchingOnly,
      },
      {
        key: 'recheck',
        label: 'Re-check',
        value: off || watchingOnly ? '—' : fixes === null ? '—' : fixes === 0 ? 'None yet' : `${rechecked ?? 0} of ${fixes}`,
        dim: off || watchingOnly,
      },
    ]
    const markState: LoopMarkState = off ? 'off' : !last || stale ? 'still' : 'running'
    body = (
      <div>
        <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] px-[20px] pt-[14px]">
          <span className="inline-flex items-center gap-[8px] text-[13.5px] font-medium leading-[21px] text-white">
            {/* Violet marks what Backenly itself does: the loop's ring, filling toward its next pass. */}
            <LoopMark lastPassAt={last} state={markState} />
            {mode}
          </span>
          {facts.map((f, i) => (
            <span key={i} className="text-[12.5px] leading-[18px] tabular-nums text-faint">
              {f}
            </span>
          ))}
        </div>
        <div className="px-[20px] pb-[16px] pt-[22px]">
          <SelfHealingLoop stages={stages} lastPassAt={last} animate={!off && !stale && !!last} />
        </div>
      </div>
    )
  }
  return (
    <Section id="overview-self-healing" title="Self-healing" aside={<SideLink href={`${base}/autonomy`}>Autonomy</SideLink>}>
      <Panel>{body}</Panel>
    </Section>
  )
}

// ── The page ──────────────────────────────────────────────────────────────────

/** While a finding is open the loop is about to act: re-read this often, then stop. */
const OPEN_FINDING_POLL_MS = 10_000

export function WorkspaceHome({ projectId, blocked = [] }: { projectId: string; blocked?: BlockedItem[] }) {
  const { status: autonomy, loading: autonomyLoading, error: autonomyError, refresh: refreshAutonomy } = useAutonomyStatus(projectId)
  const [health, setHealth] = useState<HealthData | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [refreshSignal, setRefreshSignal] = useState(0)

  // The same read the inbox count makes, joined (lib/client/shared-read.ts).
  const loadHealth = useCallback(async (fresh = false) => {
    try {
      const res = await sharedRead<{ data?: HealthData }>(`/api/projects/${projectId}/health`, { fresh })
      if (!res.ok || !res.data?.data) throw new Error('no health')
      setHealth(res.data.data)
      setHealthError(false)
    } catch {
      setHealthError(true)
    }
  }, [projectId])

  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  // Back on the tab: everything on the page reads again. No polling while hidden.
  useEffect(() => {
    const again = () => {
      if (document.hidden) return
      void loadHealth()
      setRefreshSignal((n) => n + 1)
    }
    document.addEventListener('visibilitychange', again)
    window.addEventListener('focus', again)
    return () => {
      document.removeEventListener('visibilitychange', again)
      window.removeEventListener('focus', again)
    }
  }, [loadHealth])

  const open = health ? Math.max(0, (health.actionableTotal ?? 0) - (health.needsAttention ?? 0)) : 0
  useEffect(() => {
    if (open === 0) return
    const timer = setInterval(() => {
      if (document.hidden) return
      void loadHealth(true)
      void refreshAutonomy()
    }, OPEN_FINDING_POLL_MS)
    return () => clearInterval(timer)
  }, [open, loadHealth, refreshAutonomy])

  return (
    <div className="space-y-[36px]">
      <WaitingSection projectId={projectId} pending={autonomy?.pendingApprovals ?? (autonomyLoading ? null : [])} autonomyError={autonomyError} />
      <NeedsLookSection projectId={projectId} blocked={blocked} />
      <SelfHealingSection
        projectId={projectId}
        health={health}
        healthError={healthError}
        autonomy={autonomy}
        autonomyLoading={autonomyLoading}
        onRetry={() => {
          void loadHealth(true)
          void refreshAutonomy()
        }}
      />
      <Section id="overview-traffic" title="Last 24 hours" aside={<SideLink href={`/app/projects/${projectId}/monitoring`}>Monitoring</SideLink>}>
        <ObservabilityStrip projectId={projectId} refreshSignal={refreshSignal} />
      </Section>
      <Section id="overview-backend" title="Your backend">
        <BackendStrip projectId={projectId} mode="numbers" refreshSignal={refreshSignal} />
      </Section>
    </div>
  )
}
